import { describe, expect, it } from "vitest";
import { computeMatch } from "../src/stats";

// 2対2の小さな架空試合で、各指標の定義を固定する。
const P = (puuid: string, team: string) => ({
  puuid, name: puuid, tag: "t", team_id: team, party_id: puuid, agent: { id: "a", name: "Jett" }, tier: { id: 15, name: "Platinum 1" },
  stats: { score: 500, kills: 0, deaths: 0, assists: 0, headshots: 1, bodyshots: 2, legshots: 1, damage: { dealt: 300, received: 200 } },
});
const K = (round: number, t: number, killer: string, victim: string, assistants: string[] = [], weapon: any = { name: "Vandal", type: "Weapon" }) => ({
  round, time_in_round_in_ms: t,
  killer: { puuid: killer }, victim: { puuid: victim }, assistants: assistants.map((puuid) => ({ puuid })), weapon,
});
const R = (id: number, winner: string, role: string | null, extra: object = {}) => ({
  id, winning_team: winner, winning_team_role: role, result: "Elimination", plant: null, defuse: null, stats: [], ...extra,
});

/** キルの無いラウンド。1ラウンドだけの試合はラウンド制として扱われないため、2ラウンド目として足す。 */
const QUIET = R(1, "Red", "Defender");

function match(rounds: any[], kills: any[]) {
  return computeMatch({
    metadata: {
      match_id: "m1", started_at: "2026-01-01T00:00:00Z", game_length_in_ms: 1,
      queue: { id: "competitive", name: "Competitive", mode_type: "Standard" }, map: { name: "Haven" }, season: { short: "e1a1" },
    },
    players: [P("r1", "Red"), P("r2", "Red"), P("b1", "Blue"), P("b2", "Blue")],
    teams: [
      { team_id: "Red", won: true, rounds: { won: 2, lost: 1 } },
      { team_id: "Blue", won: false, rounds: { won: 1, lost: 2 } },
    ],
    rounds,
    kills,
  });
}
const by = (c: ReturnType<typeof computeMatch>, id: string) => c.players.find((p) => p.puuid === id)!;

describe("computeMatch", () => {
  it("FB/FD は敵を倒した最初のキルで数え、自滅は含めない", () => {
    const c = match(
      [R(0, "Red", "Attacker"), R(1, "Blue", "Defender")],
      [
        K(0, 1000, "b1", "b1", [], { name: null, type: "Fall" }), // 落下死は先制キルではない
        K(0, 2000, "r1", "b2"),
        K(1, 1500, "b2", "r1"),
      ],
    );
    expect(by(c, "r1")).toMatchObject({ fk: 1, fd: 1, fk_wins: 1, fd_wins: 0 });
    expect(by(c, "b2")).toMatchObject({ fk: 1, fd: 1, fk_wins: 1, fd_wins: 0 });
    expect(by(c, "b1")).toMatchObject({ fk: 0, fd: 0 });
    expect(by(c, "r1").weapons).toEqual({ Vandal: 1 });
  });

  it("トレード: 味方を倒した敵を5秒以内に倒すと成立し、倒された味方は KAST に入る", () => {
    const c = match(
      [R(0, "Red", "Attacker"), QUIET],
      [K(0, 1000, "b1", "r1"), K(0, 4000, "r2", "b1"), K(0, 20000, "r2", "b2")],
    );
    expect(by(c, "r2")).toMatchObject({ trade_kills: 1, mk2: 1, kast_rounds: 2 });
    expect(by(c, "r1")).toMatchObject({ traded_deaths: 1, kast_rounds: 2 });
    // b2 はキルもアシストもなく、トレードもされずに死亡 → そのラウンドは KAST に入らない
    expect(by(c, "b2").kast_rounds).toBe(1);
  });

  it("5秒を超えたキルはトレードにならない", () => {
    const c = match([R(0, "Red", "Attacker"), QUIET], [K(0, 1000, "b1", "r1"), K(0, 7000, "r2", "b1")]);
    expect(by(c, "r2").trade_kills).toBe(0);
    expect(by(c, "r1")).toMatchObject({ traded_deaths: 0, kast_rounds: 1 });
  });

  it("クラッチ: 最後の1人になった時点の敵の人数で 1vX を記録する", () => {
    const c = match(
      [R(0, "Red", "Attacker"), QUIET],
      [K(0, 1000, "b1", "r1"), K(0, 9000, "r2", "b1"), K(0, 12000, "r2", "b2")],
    );
    // r2 は 1v2 を勝利。b2 は 1v1 になって負け。
    expect(by(c, "r2")).toMatchObject({ clutch_attempts: 1, clutch_wins: 1, clutches: { "2": 1 } });
    expect(by(c, "b2")).toMatchObject({ clutch_attempts: 1, clutch_wins: 0 });
  });

  it("攻守: API がロールを返さない古い試合は Red 先攻の規則で補う", () => {
    const rounds = Array.from({ length: 14 }, (_, i) => R(i, i % 2 ? "Blue" : "Red", null));
    const c = match(rounds, [K(0, 1000, "r1", "b1"), K(13, 1000, "b1", "r1")]);
    const r1 = by(c, "r1");
    expect(r1).toMatchObject({ atk_rounds: 12, def_rounds: 2, atk_wins: 6, def_wins: 1, atk_kills: 1, def_deaths: 1 });
    expect(by(c, "b1")).toMatchObject({ def_rounds: 12, atk_rounds: 2, atk_kills: 1 });
    // ピストルラウンドは 1 と 13 ラウンド目
    expect(r1).toMatchObject({ pistol_rounds: 2, pistol_wins: 2 });
  });

  it("設置と解除を数える", () => {
    const c = match(
      [R(0, "Blue", "Defender", { plant: { player: { puuid: "r1" }, site: "A", round_time_in_ms: 30000 }, defuse: { player: { puuid: "b1" }, round_time_in_ms: 60000 } }), QUIET],
      [],
    );
    expect(by(c, "r1").plants).toBe(1);
    expect(by(c, "b1").defuses).toBe(1);
    expect(by(c, "r1").won).toBe(1);
  });
});

describe("カスタムゲーム", () => {
  const custom = (players: any[]) =>
    computeMatch({
      metadata: {
        match_id: "c1", started_at: "2026-01-01T00:00:00Z", game_length_in_ms: 1,
        queue: { id: "", name: "Custom Game", mode_type: "Standard" }, map: { name: "Haven" }, season: { short: "e1a1" },
      },
      players,
      teams: [
        { team_id: "Red", won: true, rounds: { won: 2, lost: 0 } },
        { team_id: "Blue", won: false, rounds: { won: 0, lost: 2 } },
      ],
      rounds: [R(0, "Red", "Attacker"), R(1, "Red", "Attacker")],
      kills: [K(0, 1000, "r1", "b1")],
    });
  const noDamage = (puuid: string, team: string) => {
    const p = P(puuid, team);
    p.stats = { ...p.stats, headshots: 0, bodyshots: 0, legshots: 0, damage: { dealt: 0, received: 0 } };
    return p;
  };

  it("キューIDが空文字の試合は custom として扱う", () => {
    expect(custom([P("r1", "Red"), P("b1", "Blue")]).match.queue).toBe("custom");
  });

  it("ダメージが記録されていない試合は ADR の分母（dmg_rounds）を 0 にする", () => {
    const c = custom([noDamage("r1", "Red"), noDamage("b1", "Blue")]);
    expect(by(c, "r1")).toMatchObject({ rounds: 2, dmg_rounds: 0, damage_dealt: 0, fk: 1 });
  });

  it("ダメージが記録されている試合は全ラウンドを分母にする", () => {
    const c = custom([P("r1", "Red"), noDamage("b1", "Blue")]);
    expect(by(c, "r1").dmg_rounds).toBe(2);
    expect(by(c, "b1").dmg_rounds).toBe(2);
  });
});
