// チーム分け用のレート算出。ランク（elo）を土台に、直近の成績で補正する。

import { roleOf, type Role } from "./agents";
import { perfAdjustment, type PerfSample } from "./balance";
import type { Env } from "./db";
import { Henrik, HenrikError } from "./henrik";
import { actIndex, blendBase, gamesThisAct, newcomerBase, provenLevel, rrShift, summarizeMmr, summarizeRr, UNRANKED_PENALTY, type RankHistory, type RrTrend } from "./skill";

const RANK_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const PERF_WINDOW_MS = 120 * 24 * 60 * 60 * 1000;
const PERF_MATCHES = 20;
/** 相手のランク帯と比べるのに必要な、その試合でランクが分かっている人数。 */
const MIN_RANKED_IN_LOBBY = 8;
/** ランクも過去の試合も無い人だけの集まりだった場合の仮レート（ゴールド1相当）。 */
const DEFAULT_RATING = 900;
/** RR の増減を取り直す間隔と、1回の更新で取りに行く人数の上限（API の回数制限に収めるため。残りは定期更新で埋まる）。 */
const RR_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const RR_FETCH_PER_REFRESH = 5;

export interface Link {
  user_id: string;
  puuid: string;
  name: string;
  tag: string;
  region: string;
  platform: string;
  tier: number | null;
  rr: number | null;
  elo: number | null;
  rank_updated_at: number;
  /** アクトごとの到達ランクなど（RankHistory の JSON）。未取得なら null */
  history?: string | null;
  account_level?: number | null;
  /** 直近のコンペでの RR の動き（RrTrend の JSON）。未取得・使える試合なしは null */
  rr_trend?: string | null;
  rr_updated_at?: number | null;
}

/** 土台をどの情報から決めたか。 */
export type Basis = "rank" | "history" | "level" | "average";

export interface Rated {
  userId: string;
  puuid: string;
  name: string;
  tag: string;
  tier: number | null;
  rr: number | null;
  /** ランク由来の土台: 現在ランクを、過去の実績の側へ寄せた値。現在ランクが無い場合は estimated が true */
  base: number;
  estimated: boolean;
  /** 現在ランクの数値（ランクなしは null）と、過去の実績から見た水準（履歴が無ければ null） */
  current: number | null;
  proven: number | null;
  /** rank: 現在ランク / history: 過去の実績（現在ランクなし）/ level: アカウントレベル（ランクの記録なし）/ average: 参加者の平均（手がかりなし） */
  basis: Basis;
  level: number | null;
  /** RR の増減から見た、内部レートとランクのずれ（土台に足す点数）。trend はその元になった RR の動き */
  rrAdj: number;
  trend: RrTrend | null;
  /** 直近の成績による補正（土台 + rrAdj から見込まれる成績との差） */
  adj: number;
  rating: number;
  role: Role | null;
  samples: number;
}

function parseTrend(json: string | null | undefined): RrTrend | null {
  if (!json) return null;
  try {
    const t = JSON.parse(json);
    return typeof t?.w === "number" && typeof t?.l === "number" && typeof t?.n === "number" ? t : null;
  } catch {
    return null;
  }
}

function parseHistory(json: string | null | undefined): RankHistory | null {
  if (!json) return null;
  try {
    const h = JSON.parse(json);
    return Array.isArray(h?.acts) ? h : null;
  } catch {
    return null;
  }
}

export const isStale = (l: Link, now = Date.now()) => now - (l.rank_updated_at ?? 0) > RANK_MAX_AGE_MS;

/** HenrikDev から現在のランクを取り直して保存する。1人失敗しても他は続ける。 */
export async function refreshRanks(env: Env, api: Henrik, links: Link[]): Promise<void> {
  const now = Date.now();
  // RR の増減は、記録が古い人から順に、1回の更新につき数人ぶんだけ取りに行く
  const rrDue = new Set(
    links
      .filter((l) => now - (l.rr_updated_at ?? 0) > RR_MAX_AGE_MS)
      .sort((a, b) => (a.rr_updated_at ?? 0) - (b.rr_updated_at ?? 0))
      .slice(0, RR_FETCH_PER_REFRESH)
      .map((l) => l.user_id),
  );
  await Promise.all(
    links.map(async (l) => {
      try {
        const d = (await api.mmrByPuuid(l.region, l.platform, l.puuid)).data;
        const cur = d?.current;
        l.tier = cur?.tier?.id ?? null;
        l.rr = cur?.rr ?? null;
        l.elo = cur?.elo ?? null;
        l.name = d?.account?.name ?? l.name;
        l.tag = d?.account?.tag ?? l.tag;
        l.rank_updated_at = now;
        l.history = JSON.stringify(summarizeMmr(d));
        if (l.account_level == null) {
          // レベルは初回だけ取得する（ランクの記録がない人の初心者判定に使う）。取れなくても先へ進む
          l.account_level = await api.accountByPuuid(l.puuid).then((a) => a?.data?.account_level ?? null, () => null);
        }
        if (rrDue.has(l.user_id)) {
          // ランクなしの人は RR が動かないので取りに行かない。取得に失敗したら前回の値のまま（次の機会にやり直す）
          const h = (l.tier ?? 0) >= 3
            ? await api.mmrHistoryByPuuid(l.region, l.platform, l.puuid).then((r) => (Array.isArray(r?.data?.history) ? r.data.history : null), () => null)
            : [];
          if (h) {
            const t = summarizeRr(h, now);
            l.rr_trend = t ? JSON.stringify(t) : null;
            l.rr_updated_at = now;
          }
        }
        await env.DB.prepare(
          `UPDATE discord_links SET tier = ?, rr = ?, elo = ?, name = ?, tag = ?, rank_updated_at = ?, history = ?, account_level = ?,
             rr_trend = ?, rr_updated_at = ? WHERE user_id = ?`,
        )
          .bind(l.tier, l.rr, l.elo, l.name, l.tag, now, l.history, l.account_level ?? null, l.rr_trend ?? null, l.rr_updated_at ?? 0, l.user_id)
          .run();
      } catch (e) {
        if (!(e instanceof HenrikError)) throw e;
        console.warn("rank refresh failed", l.user_id, e.status);
      }
    }),
  );
}

/** 保存済みの試合から、各プレイヤーの直近の成績比・よく使うロール・最後に確認できたランクを求める。 */
export async function ratePlayers(env: Env, links: Link[]): Promise<Rated[]> {
  if (!links.length) return [];
  const { results } = await env.DB.prepare(
    `WITH recent AS (
       SELECT pm.puuid, pm.match_id, pm.agent, pm.tier, pm.score * 1.0 / pm.rounds AS acs,
              ROW_NUMBER() OVER (PARTITION BY pm.puuid ORDER BY pm.started_at DESC) AS rn
       FROM player_matches pm
       WHERE pm.puuid IN (SELECT value FROM json_each(?1))
         AND pm.queue IN ('competitive', 'unrated', 'premier') AND pm.round_based = 1 AND pm.rounds > 0
         AND pm.started_at > ?2
     )
     SELECT r.puuid, r.agent, r.tier, r.acs, l.lobby_acs, l.lobby_elo, l.ranked
     FROM recent r JOIN (
       SELECT o.match_id, AVG(o.score * 1.0 / o.rounds) AS lobby_acs,
              AVG(CASE WHEN o.tier >= 3 THEN (o.tier - 3) * 100 + 50 END) AS lobby_elo, SUM(o.tier >= 3) AS ranked
       FROM player_matches o WHERE o.rounds > 0 AND o.match_id IN (SELECT match_id FROM recent WHERE rn <= ?3)
       GROUP BY o.match_id
     ) l ON l.match_id = r.match_id
     WHERE r.rn <= ?3 ORDER BY r.puuid, r.rn`,
  )
    .bind(JSON.stringify(links.map((l) => l.puuid)), Date.now() - PERF_WINDOW_MS, PERF_MATCHES)
    .all<{ puuid: string; agent: string | null; tier: number | null; acs: number; lobby_acs: number | null; lobby_elo: number | null; ranked: number }>();

  const perf = new Map<string, { samples: PerfSample[]; roles: Map<Role, number>; lastTier: number | null }>();
  for (const r of results) {
    const p = perf.get(r.puuid) ?? { samples: [] as PerfSample[], roles: new Map<Role, number>(), lastTier: null as number | null };
    const role = roleOf(r.agent);
    // 参加者の大半にランクがある試合だけ、相手のランク帯と比べる（アンレートなどは「同格相手」とみなす）
    if (r.lobby_acs) p.samples.push({ ratio: r.acs / r.lobby_acs, role, agent: r.agent, lobbyElo: r.ranked >= MIN_RANKED_IN_LOBBY ? r.lobby_elo : null });
    if (role) p.roles.set(role, (p.roles.get(role) ?? 0) + 1);
    if (p.lastTier == null && r.tier && r.tier >= 3) p.lastTier = r.tier;
    perf.set(r.puuid, p);
  }

  // 「今のアクト」は、取り込み済みの最新の試合と、参加者の履歴に出てくる一番新しいアクトから決める
  const latest = await env.DB.prepare(`SELECT season FROM matches WHERE season != '' ORDER BY started_at DESC LIMIT 1`).first<{ season: string }>();
  const histories = links.map((l) => parseHistory(l.history));
  const nowIndex = Math.max(
    actIndex(latest?.season) ?? 0,
    ...histories.flatMap((h) => (h ? h.acts.map((a) => actIndex(a.s) ?? 0) : [])),
  );

  const partial = links.map((l, n) => {
    const p = perf.get(l.puuid);
    const role = p && p.roles.size ? [...p.roles.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
    const ranked = l.elo != null && (l.tier ?? 0) >= 3;
    const current = ranked ? l.elo! : null;
    const h = histories[n];
    // 履歴が無い人（未取得など）は、試合で最後に確認できたランクの中央（50RR）を実績の代わりにする
    const proven = provenLevel(h, nowIndex) ?? (!ranked && p?.lastTier ? (p.lastTier - 3) * 100 + 50 + UNRANKED_PENALTY : null);
    let base = blendBase(current, proven, gamesThisAct(h, nowIndex));
    let basis: Basis = ranked ? "rank" : "history";
    if (base == null && l.account_level != null) {
      // ランクの記録が一切ない: アカウントレベルから、初心者か経験者かを見分ける
      base = newcomerBase(l.account_level);
      basis = "level";
    }
    // 現在ランクがある人だけ、RR の増減から内部レートとのずれを見る
    const trend = ranked ? parseTrend(l.rr_trend) : null;
    return { l, base, basis, ranked, current, proven, role, trend, samples: p?.samples ?? [], lastTier: p?.lastTier ?? null };
  });
  // 手がかりが何も無い人だけ、他の参加者の平均を仮の土台にする
  const known = partial.filter((x) => x.base != null).map((x) => x.base!);
  const fallback = known.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : DEFAULT_RATING;

  return partial.map((x) => {
    const base = x.base ?? fallback;
    // RR の動きで土台をずらし、そこから見込まれる成績との差を補正にする（同じずれを二重に数えないため）
    const rrAdj = rrShift(x.trend);
    const adj = perfAdjustment(x.samples, base + rrAdj);
    return {
      userId: x.l.user_id,
      puuid: x.l.puuid,
      name: x.l.name,
      tag: x.l.tag,
      // ランクなしの人は、過去の実績に当たるランクを「（過去）」付きで表示する
      tier: x.ranked ? x.l.tier : (x.lastTier ?? (x.proven != null ? Math.min(27, Math.max(3, Math.floor(x.proven / 100) + 3)) : null)),
      rr: x.ranked ? x.l.rr : null,
      base,
      estimated: !x.ranked,
      current: x.current,
      proven: x.proven,
      basis: x.base == null ? "average" : x.basis,
      level: x.l.account_level ?? null,
      rrAdj,
      trend: x.trend,
      adj,
      rating: base + rrAdj + adj,
      role: x.role,
      samples: x.samples.length,
    };
  });
}
