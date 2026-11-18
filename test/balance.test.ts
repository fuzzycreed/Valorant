import { describe, expect, it } from "vitest";
import { acsBaseline, ACS_PER_POINT, AGENT_ACS, balance, EXPECTED_FLOOR, impact, perfAdjustment, rerollOptions, ROLE_ACS, type Candidate, type PerfSample } from "../src/balance";

const P = (id: string, rating: number, role: Candidate["role"] = null): Candidate => ({ id, rating, role });

describe("balance", () => {
  it("10人なら 126 通りを調べ、差が最小の案を先頭に返す", () => {
    // 全員が平均から ±250点以内なら、戦力はレート差どおりに効く
    const players = [1500, 1450, 1400, 1380, 1350, 1320, 1300, 1250, 1200, 1100].map((r, i) => P(`p${i}`, r));
    const splits = balance(players);
    expect(splits).toHaveLength(126);
    const best = splits[0];
    expect(best.a).toHaveLength(5);
    expect(best.b).toHaveLength(5);
    expect(new Set([...best.a, ...best.b]).size).toBe(10);
    expect(best.diff).toBeLessThanOrEqual(10);
    for (const s of splits) expect(s.cost).toBeGreaterThanOrEqual(best.cost);
  });

  it("平均から大きく離れた人は、レート差以上に効くものとして釣り合わせる", () => {
    // レートの合計だけなら [2000, 1000] 対 [1500, 1500] で完全に釣り合うが、
    // 飛び抜けた人（+500）より、大きく下回る人（-500）のほうが強く効くので、戦力としては釣り合わない
    const players = [P("top", 2000), P("low", 1000), P("m1", 1500), P("m2", 1500)];
    const even = balance(players).find((s) => [...s.a].sort().join() === "low,top" || [...s.b].sort().join() === "low,top")!;
    expect(even.diff).toBeGreaterThan(50);
  });

  it("レート差が同じなら、ロールが偏らない案を選ぶ", () => {
    const players = [
      P("d1", 1000, "duelist"), P("d2", 1000, "duelist"),
      P("c1", 1000, "controller"), P("c2", 1000, "controller"),
    ];
    const best = balance(players)[0];
    const roles = (ids: string[]) => ids.map((id) => id[0]).sort().join("");
    expect(roles(best.a)).toBe("cd");
    expect(roles(best.b)).toBe("cd");
    expect(best.diff).toBe(0);
  });

  it("大きなレート差はロールの偏りより優先される", () => {
    const players = [
      P("d1", 2000, "duelist"), P("d2", 2000, "duelist"),
      P("c1", 1000, "controller"), P("c2", 1000, "controller"),
    ];
    const best = balance(players)[0];
    expect(best.diff).toBe(0);
    expect(best.a.map((id) => id[0]).sort().join("")).toBe("cd");
  });

  it("奇数人数は少ない側を a にし、合計で比べるので強い人が少ない側に入る", () => {
    const best = balance([P("a", 1500), P("b", 1000), P("c", 1000)])[0];
    expect(best.a).toEqual(["a"]);
    expect(best.b.sort()).toEqual(["b", "c"]);
  });

  it("2人未満は分けられない", () => {
    expect(balance([P("a", 1000)])).toEqual([]);
  });

  it("振り直し候補は最良案に近いものだけ", () => {
    const players = [1500, 1450, 1400, 1380, 1350, 1320, 1300, 1250, 1200, 1100].map((r, i) => P(`p${i}`, r));
    const opts = rerollOptions(balance(players));
    expect(opts.length).toBeGreaterThan(1);
    expect(opts.length).toBeLessThanOrEqual(12);
    for (const o of opts) expect(o.cost).toBeLessThanOrEqual(opts[0].cost + 60);
  });
});

describe("impact", () => {
  it("平均の近くではレート差どおり", () => {
    expect(impact(0)).toBe(0);
    expect(impact(200)).toBe(200);
    expect(impact(-300)).toBe(-300);
  });
  it("平均より大きく上の人は差以上に、大きく下の人はさらに大きく効く", () => {
    expect(impact(350)).toBe(250 + 100 * 1.3);
    expect(impact(-550)).toBe(-350 - 200 * 2.5);
  });
});

describe("perfAdjustment", () => {
  const many = (s: PerfSample, n: number) => Array.from({ length: n }, () => s);
  it("同格の相手に、ロール平均どおりの成績なら補正なし", () => {
    expect(perfAdjustment(many({ ratio: ROLE_ACS.duelist, role: "duelist", lobbyElo: 1500 }, 20), 1500)).toBe(0);
    expect(perfAdjustment(many({ ratio: ROLE_ACS.initiator, role: "initiator", lobbyElo: 1500 }, 20), 1500)).toBe(0);
  });
  it("同じ ACS でも、デュエリストよりイニシエーターのほうが高く評価される", () => {
    const duelist = perfAdjustment(many({ ratio: 1, role: "duelist", lobbyElo: 1500 }, 20), 1500);
    const initiator = perfAdjustment(many({ ratio: 1, role: "initiator", lobbyElo: 1500 }, 20), 1500);
    expect(duelist).toBeLessThan(0);
    expect(initiator).toBeGreaterThan(0);
  });
  it("エージェントごとの平均が分かっていれば、ロールの平均より優先する", () => {
    expect(acsBaseline("Reyna", "duelist")).toBe(AGENT_ACS.reyna);
    expect(acsBaseline("KAY/O", "initiator")).toBe(AGENT_ACS["kay/o"]);
    expect(acsBaseline("Viper", "controller")).toBe(ROLE_ACS.controller); // データが少ないエージェントはロール平均
    expect(acsBaseline(null, null)).toBe(1);
    // 同じデュエリストで同じ ACS でも、稼ぎやすいレイナより、稼ぎにくいネオンのほうが高く評価される
    const reyna = perfAdjustment(many({ ratio: 1.05, role: "duelist", agent: "Reyna", lobbyElo: 1500 }, 20), 1500);
    const neon = perfAdjustment(many({ ratio: 1.05, role: "duelist", agent: "Neon", lobbyElo: 1500 }, 20), 1500);
    expect(reyna).toBeLessThan(0);
    expect(neon).toBeGreaterThan(0);
  });
  it("格下相手に稼いだぶんは補正に入らない", () => {
    // 200点下のランク帯で、その差から見込まれるとおりの成績
    const expected = 1 + ACS_PER_POINT * 200;
    expect(perfAdjustment(many({ ratio: expected, role: null, lobbyElo: 1300 }, 20), 1500)).toBe(0);
    // 同じ成績を同格相手に出していれば、プラスの補正になる
    expect(perfAdjustment(many({ ratio: expected, role: null, lobbyElo: 1500 }, 20), 1500)).toBeGreaterThan(100);
  });
  it("試合数が少ないうちは弱め、上限で頭打ち", () => {
    const s: PerfSample = { ratio: 1.1, role: null, lobbyElo: 1500 };
    const full = 0.1 / ACS_PER_POINT; // 約159点
    expect(perfAdjustment(many(s, 8), 1500)).toBe(Math.round(full / 2));
    expect(perfAdjustment(many(s, 24), 1500)).toBe(Math.round(full * 0.75));
    expect(perfAdjustment(many({ ...s, ratio: 2 }, 40), 1500)).toBe(300);
    expect(perfAdjustment(many({ ...s, ratio: 0.2 }, 40), 1500)).toBe(-300);
  });
  it("はるかに格上の試合でも、見込みの成績は下限で止まる", () => {
    // 1000点上のランク帯: 見込みは下限の 0.55。そのとおりなら補正なし、0.4 しか取れなければマイナス
    expect(perfAdjustment(many({ ratio: EXPECTED_FLOOR, role: null, lobbyElo: 2500 }, 20), 1500)).toBe(0);
    expect(perfAdjustment(many({ ratio: 0.4, role: null, lobbyElo: 2500 }, 20), 1500)).toBeLessThan(-100);
  });
  it("相手のランク帯が分からない試合は、同格相手として扱う", () => {
    expect(perfAdjustment(many({ ratio: 1, role: null, lobbyElo: null }, 10), 1500)).toBe(0);
  });
  it("データが無ければ補正なし", () => {
    expect(perfAdjustment([], 1500)).toBe(0);
  });
});
