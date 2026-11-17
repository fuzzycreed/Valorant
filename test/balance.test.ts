import { describe, expect, it } from "vitest";
import { balance, perfAdjustment, rerollOptions, type Candidate } from "../src/balance";

const P = (id: string, rating: number, role: Candidate["role"] = null): Candidate => ({ id, rating, role });

describe("balance", () => {
  it("10人なら 126 通りを調べ、差が最小の案を先頭に返す", () => {
    const players = [1900, 1700, 1500, 1400, 1300, 1250, 1200, 1100, 1000, 900].map((r, i) => P(`p${i}`, r));
    const splits = balance(players);
    expect(splits).toHaveLength(126);
    const best = splits[0];
    expect(best.a).toHaveLength(5);
    expect(best.b).toHaveLength(5);
    expect(new Set([...best.a, ...best.b]).size).toBe(10);
    // 合計 13250 は奇数個の 50 なので、最小の合計差は 50（平均差 10）
    expect(best.diff).toBeCloseTo(10);
    for (const s of splits) expect(s.cost).toBeGreaterThanOrEqual(best.cost);
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
    const players = [1900, 1700, 1500, 1400, 1300, 1250, 1200, 1100, 1000, 900].map((r, i) => P(`p${i}`, r));
    const opts = rerollOptions(balance(players));
    expect(opts.length).toBeGreaterThan(1);
    expect(opts.length).toBeLessThanOrEqual(12);
    for (const o of opts) expect(o.cost).toBeLessThanOrEqual(opts[0].cost + 60);
  });
});

describe("perfAdjustment", () => {
  it("平均より2割高いスコアを10試合続けると +80", () => {
    expect(perfAdjustment(1.2, 10)).toBe(80);
  });
  it("試合数が少ないうちは弱める", () => {
    expect(perfAdjustment(1.2, 5)).toBe(40);
  });
  it("上限と下限で頭打ち", () => {
    expect(perfAdjustment(2, 20)).toBe(150);
    expect(perfAdjustment(0.2, 20)).toBe(-150);
  });
  it("データが無ければ補正なし", () => {
    expect(perfAdjustment(null, 0)).toBe(0);
  });
});
