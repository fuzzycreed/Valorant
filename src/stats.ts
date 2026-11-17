// HenrikDev v4 の試合データから、プレイヤーごとの集計値を計算する純粋関数群。
// ネットワークやDBには触らないので、単体でテストできる。

/** トレード判定の時間窓（ミリ秒）。味方を倒した敵をこの時間内に倒せばトレード成立とみなす。 */
export const TRADE_WINDOW_MS = 5000;

/** リスポーンがありラウンド単位の指標（FB、KAST、クラッチなど）が意味を持たないキュー。 */
const NON_ROUND_QUEUES = new Set(["deathmatch", "hurm", "ggteam", "snowball"]);

export interface PlayerMatchStats {
  puuid: string;
  name: string;
  tag: string;
  team: string;
  party_id: string | null;
  agent: string | null;
  agent_id: string | null;
  tier: number | null;
  tier_name: string | null;
  score: number;
  kills: number;
  deaths: number;
  assists: number;
  headshots: number;
  bodyshots: number;
  legshots: number;
  damage_dealt: number;
  damage_received: number;
  rounds: number;
  /** ADR の分母に使うラウンド数。API がダメージを記録していない試合（カスタムなど）では 0 */
  dmg_rounds: number;
  rounds_won: number;
  rounds_lost: number;
  /** 1=勝ち 0=負け null=引き分け／判定なし */
  won: number | null;
  fk: number;
  fd: number;
  /** FBを取ったラウンドのうち勝ったラウンド数 */
  fk_wins: number;
  /** FDしたラウンドのうち勝ったラウンド数 */
  fd_wins: number;
  mk2: number;
  mk3: number;
  mk4: number;
  mk5: number;
  kast_rounds: number;
  trade_kills: number;
  traded_deaths: number;
  clutch_attempts: number;
  clutch_wins: number;
  /** 勝ったクラッチの相手人数ごとの回数。例: {"1":2,"3":1} */
  clutches: Record<string, number>;
  atk_rounds: number;
  atk_wins: number;
  def_rounds: number;
  def_wins: number;
  atk_kills: number;
  atk_deaths: number;
  def_kills: number;
  def_deaths: number;
  plants: number;
  defuses: number;
  pistol_rounds: number;
  pistol_wins: number;
  loadout_total: number;
  /** 武器名 → キル数 */
  weapons: Record<string, number>;
}

export interface MatchSummary {
  match_id: string;
  started_at: number;
  queue: string;
  queue_name: string;
  mode_type: string;
  map: string;
  season: string;
  game_length_ms: number;
  rounds: number;
  round_based: boolean;
  cluster: string | null;
  /** チームID → 取得ラウンド数 */
  score: Record<string, number>;
  winner: string | null;
}

export interface MatchDetail {
  players: string[];
  rounds: {
    winner: string;
    role: string;
    result: string;
    plant: { by: number; site: string | null; t: number } | null;
    defuse: { by: number; t: number } | null;
    kills: { t: number; k: number; v: number; w: string; a: number[] }[];
    /** players と同じ順の [装備総額, 武器名] */
    eco: [number, string | null][];
  }[];
}

export interface ComputedMatch {
  match: MatchSummary;
  players: PlayerMatchStats[];
  detail: MatchDetail;
}

function weaponLabel(w: any): string {
  if (!w) return "Unknown";
  if (w.name) return w.name;
  if (w.type === "Bomb") return "Spike";
  if (w.type === "Fall") return "Fall";
  if (w.type === "Ability") return "Ability";
  return "Melee";
}

const opposite = (role: string) => (role === "Attacker" ? "Defender" : role === "Defender" ? "Attacker" : "");

/**
 * そのラウンドで Red チームが攻めか守りかを返す。
 * 新しい試合は API が勝利側のロールを返すのでそれを使う。古い試合には無いので、
 * 「Red が先攻、ハーフで交代、延長は1ラウンドごとに交代」の規則から求める（実データ390ラウンドで一致を確認済み）。
 */
function redRoleOf(r: any, index: number, modeType: string): string {
  const role: string = r.winning_team_role ?? "";
  if (role === "Attacker" || role === "Defender") return r.winning_team === "Red" ? role : opposite(role);
  const half = modeType === "Standard" ? 12 : modeType === "Swiftplay" ? 4 : 0;
  if (!half) return "";
  if (index < half) return "Attacker";
  if (index < half * 2) return "Defender";
  if (modeType !== "Standard") return "";
  return (index - half * 2) % 2 === 0 ? "Attacker" : "Defender";
}

function emptyStats(p: any, rounds: number): PlayerMatchStats {
  const s = p.stats ?? {};
  return {
    puuid: p.puuid,
    name: p.name ?? "",
    tag: p.tag ?? "",
    team: p.team_id ?? "",
    party_id: p.party_id ?? null,
    agent: p.agent?.name ?? null,
    agent_id: p.agent?.id ?? null,
    tier: p.tier?.id ?? null,
    tier_name: p.tier?.name ?? null,
    score: s.score ?? 0,
    kills: s.kills ?? 0,
    deaths: s.deaths ?? 0,
    assists: s.assists ?? 0,
    headshots: s.headshots ?? 0,
    bodyshots: s.bodyshots ?? 0,
    legshots: s.legshots ?? 0,
    damage_dealt: s.damage?.dealt ?? 0,
    damage_received: s.damage?.received ?? 0,
    rounds,
    dmg_rounds: 0,
    rounds_won: 0,
    rounds_lost: 0,
    won: null,
    fk: 0,
    fd: 0,
    fk_wins: 0,
    fd_wins: 0,
    mk2: 0,
    mk3: 0,
    mk4: 0,
    mk5: 0,
    kast_rounds: 0,
    trade_kills: 0,
    traded_deaths: 0,
    clutch_attempts: 0,
    clutch_wins: 0,
    clutches: {},
    atk_rounds: 0,
    atk_wins: 0,
    def_rounds: 0,
    def_wins: 0,
    atk_kills: 0,
    atk_deaths: 0,
    def_kills: 0,
    def_deaths: 0,
    plants: 0,
    defuses: 0,
    pistol_rounds: 0,
    pistol_wins: 0,
    loadout_total: 0,
    weapons: {},
  };
}

export function computeMatch(raw: any): ComputedMatch {
  const md = raw.metadata;
  const rawPlayers: any[] = raw.players ?? [];
  const rawRounds: any[] = raw.rounds ?? [];
  const rawKills: any[] = raw.kills ?? [];
  const teams: any[] = raw.teams ?? [];
  // カスタムゲームは API 上のキューIDが空文字になる。扱いやすいよう "custom" に揃える
  const queue: string = md.queue?.id === "" ? "custom" : (md.queue?.id ?? "unknown");

  const twoTeams = teams.length === 2;
  const roundBased = twoTeams && rawRounds.length > 1 && !NON_ROUND_QUEUES.has(queue);

  const stats = new Map<string, PlayerMatchStats>();
  const order: string[] = [];
  for (const p of rawPlayers) {
    stats.set(p.puuid, emptyStats(p, rawRounds.length));
    order.push(p.puuid);
  }
  // カスタムなど一部の試合は、API がダメージと命中部位を全員 0 で返す。
  // その試合を ADR の計算に含めると実際より低く出るので、分母から外せるように記録しておく。
  const hasDamageData = rawPlayers.some((p) => {
    const st = p.stats ?? {};
    return (st.damage?.dealt ?? 0) > 0 || (st.headshots ?? 0) + (st.bodyshots ?? 0) + (st.legshots ?? 0) > 0;
  });
  if (hasDamageData) for (const st of stats.values()) st.dmg_rounds = st.rounds;
  const idx = new Map(order.map((id, i) => [id, i]));
  const teamOf = (puuid: string) => stats.get(puuid)?.team ?? "";

  const score: Record<string, number> = {};
  let winner: string | null = null;
  for (const t of teams) {
    score[t.team_id] = t.rounds?.won ?? 0;
    if (t.won) winner = t.team_id;
  }
  if (twoTeams) {
    for (const st of stats.values()) {
      const t = teams.find((x) => x.team_id === st.team);
      if (!t) continue;
      st.rounds_won = t.rounds?.won ?? 0;
      st.rounds_lost = t.rounds?.lost ?? 0;
      st.won = winner === null ? null : winner === st.team ? 1 : 0;
    }
  } else {
    // フリーフォーオール: チームID = puuid。勝者だけ 1、他は 0。
    for (const st of stats.values()) st.won = winner === null ? null : winner === st.puuid ? 1 : 0;
  }

  // 武器別キル（全モード共通）
  for (const k of rawKills) {
    const killer = stats.get(k.killer?.puuid);
    if (!killer || k.killer.puuid === k.victim?.puuid) continue;
    if (twoTeams && teamOf(k.killer.puuid) === teamOf(k.victim.puuid)) continue;
    const w = weaponLabel(k.weapon);
    killer.weapons[w] = (killer.weapons[w] ?? 0) + 1;
  }

  const detail: MatchDetail = { players: order, rounds: [] };

  if (roundBased) {
    const killsByRound = new Map<number, any[]>();
    for (const k of rawKills) {
      const arr = killsByRound.get(k.round) ?? [];
      arr.push(k);
      killsByRound.set(k.round, arr);
    }
    const isStandard = md.queue?.mode_type === "Standard";

    rawRounds.forEach((r, ri) => {
      const winTeam: string = r.winning_team ?? "";
      const redRole = redRoleOf(r, ri, md.queue?.mode_type ?? "");
      const sideOf = (team: string) => (team === "Red" ? redRole : opposite(redRole));
      const winRole = sideOf(winTeam);
      const kills = (killsByRound.get(r.id ?? ri) ?? []).sort(
        (a, b) => a.time_in_round_in_ms - b.time_in_round_in_ms,
      );

      const alive = new Map<string, Set<string>>();
      for (const st of stats.values()) {
        if (!alive.has(st.team)) alive.set(st.team, new Set());
        alive.get(st.team)!.add(st.puuid);
      }
      const rk = new Map<string, number>();
      const ra = new Set<string>();
      const died = new Set<string>();
      const traded = new Set<string>();
      const clutcher = new Map<string, { puuid: string; vs: number }>();
      let firstBlood = false;
      const realKills: { t: number; killer: string; victim: string }[] = [];
      const dKills: MatchDetail["rounds"][number]["kills"] = [];

      for (const k of kills) {
        const killer: string = k.killer?.puuid;
        const victim: string = k.victim?.puuid;
        if (!stats.has(victim)) continue;
        const t: number = k.time_in_round_in_ms ?? 0;
        const real = stats.has(killer) && killer !== victim && teamOf(killer) !== teamOf(victim);
        died.add(victim);

        if (real) {
          rk.set(killer, (rk.get(killer) ?? 0) + 1);
          for (const a of k.assistants ?? []) if (stats.has(a.puuid)) ra.add(a.puuid);
          if (!firstBlood) {
            firstBlood = true;
            const ks = stats.get(killer)!;
            const vs = stats.get(victim)!;
            ks.fk++;
            vs.fd++;
            if (ks.team === winTeam) ks.fk_wins++;
            if (vs.team === winTeam) vs.fd_wins++;
          }
          // トレード: 倒した相手が直前に味方を倒していたら成立
          let tradedSomeone = false;
          for (const prev of realKills) {
            if (prev.killer === victim && t - prev.t <= TRADE_WINDOW_MS && teamOf(prev.victim) === teamOf(killer)) {
              traded.add(prev.victim);
              tradedSomeone = true;
            }
          }
          if (tradedSomeone) stats.get(killer)!.trade_kills++;
          realKills.push({ t, killer, victim });
          const side = sideOf(teamOf(killer));
          if (side === "Attacker") stats.get(killer)!.atk_kills++;
          else if (side === "Defender") stats.get(killer)!.def_kills++;
        }

        // クラッチ判定: この死亡で、あるチームの生存者が1人になった瞬間を記録
        const vTeam = teamOf(victim);
        alive.get(vTeam)?.delete(victim);
        for (const [team, set] of alive) {
          if (set.size !== 1 || clutcher.has(team)) continue;
          let enemies = 0;
          for (const [other, os] of alive) if (other !== team) enemies += os.size;
          if (enemies >= 1) clutcher.set(team, { puuid: [...set][0], vs: enemies });
        }

        dKills.push({
          t,
          k: idx.get(killer) ?? -1,
          v: idx.get(victim) ?? -1,
          w: weaponLabel(k.weapon),
          a: (k.assistants ?? []).map((a: any) => idx.get(a.puuid) ?? -1).filter((i: number) => i >= 0),
        });
      }

      for (const [team, c] of clutcher) {
        const st = stats.get(c.puuid)!;
        st.clutch_attempts++;
        if (team === winTeam) {
          st.clutch_wins++;
          st.clutches[c.vs] = (st.clutches[c.vs] ?? 0) + 1;
        }
      }

      const isPistol = isStandard && (ri === 0 || ri === 12);
      const eco: [number, string | null][] = order.map(() => [0, null]);
      for (const rs of r.stats ?? []) {
        const i = idx.get(rs.player?.puuid);
        if (i === undefined) continue;
        const lv = rs.economy?.loadout_value ?? 0;
        eco[i] = [lv, rs.economy?.weapon?.name ?? null];
        stats.get(rs.player.puuid)!.loadout_total += lv;
      }

      for (const st of stats.values()) {
        const k = rk.get(st.puuid) ?? 0;
        if (k >= 5) st.mk5++;
        else if (k === 4) st.mk4++;
        else if (k === 3) st.mk3++;
        else if (k === 2) st.mk2++;
        const dead = died.has(st.puuid);
        if (traded.has(st.puuid)) st.traded_deaths++;
        if (k > 0 || ra.has(st.puuid) || !dead || traded.has(st.puuid)) st.kast_rounds++;
        const side = sideOf(st.team);
        const wonRound = st.team === winTeam;
        if (side === "Attacker") {
          st.atk_rounds++;
          if (wonRound) st.atk_wins++;
          if (dead) st.atk_deaths++;
        } else if (side === "Defender") {
          st.def_rounds++;
          if (wonRound) st.def_wins++;
          if (dead) st.def_deaths++;
        }
        if (isPistol) {
          st.pistol_rounds++;
          if (wonRound) st.pistol_wins++;
        }
      }

      const planter = r.plant?.player?.puuid;
      const defuser = r.defuse?.player?.puuid;
      if (planter && stats.has(planter)) stats.get(planter)!.plants++;
      if (defuser && stats.has(defuser)) stats.get(defuser)!.defuses++;

      detail.rounds.push({
        winner: winTeam,
        role: winRole,
        result: r.result ?? "",
        plant: planter
          ? { by: idx.get(planter) ?? -1, site: r.plant.site ?? null, t: r.plant.round_time_in_ms ?? 0 }
          : null,
        defuse: defuser ? { by: idx.get(defuser) ?? -1, t: r.defuse.round_time_in_ms ?? 0 } : null,
        kills: dKills,
        eco,
      });
    });
  }

  return {
    match: {
      match_id: md.match_id,
      started_at: Date.parse(md.started_at),
      queue,
      queue_name: md.queue?.name ?? queue,
      mode_type: md.queue?.mode_type ?? "",
      map: md.map?.name ?? "",
      season: md.season?.short ?? "",
      game_length_ms: md.game_length_in_ms ?? 0,
      rounds: rawRounds.length,
      round_based: roundBased,
      cluster: md.cluster ?? null,
      score,
      winner,
    },
    players: [...stats.values()],
    detail,
  };
}
