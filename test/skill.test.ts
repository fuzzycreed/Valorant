import { describe, expect, it } from "vitest";
import { actIndex, blendBase, gamesThisAct, newcomerBase, provenLevel, rrShift, summarizeMmr, summarizeRr, type RankHistory } from "../src/skill";

const NOW = actIndex("e11a6")!;
const act = (s: string, g: number, e: number) => ({ s, g, e });

describe("actIndex", () => {
  it("エピソード9までは3アクト、10以降は6アクトで数える", () => {
    expect(actIndex("e1a1")).toBe(1);
    expect(actIndex("e9a3")).toBe(27);
    expect(actIndex("e10a1")).toBe(28);
    expect(actIndex("e11a6")).toBe(39);
    expect(actIndex("unknown")).toBeNull();
  });
});

describe("provenLevel", () => {
  it("半年以内の実績はそのまま、古い実績は1アクトごとに25点割り引く", () => {
    expect(provenLevel({ acts: [act("e11a4", 40, 2100)], peak: null }, NOW)).toBe(2100); // 2アクト前
    expect(provenLevel({ acts: [act("e10a6", 40, 2100)], peak: null }, NOW)).toBe(2025); // 6アクト前 → 3アクト分
    expect(provenLevel({ acts: [act("e5a1", 40, 2100)], peak: null }, NOW)).toBe(1800); // 上限300
  });
  it("試合数の少ないアクトは実績に数えない", () => {
    expect(provenLevel({ acts: [act("e11a5", 3, 2100), act("e11a4", 30, 1500)], peak: null }, NOW)).toBe(1500);
  });
  it("割り引いたあとで一番高いものを取る（生涯最高も候補）", () => {
    const h: RankHistory = { acts: [act("e11a5", 30, 1600), act("e9a3", 50, 1810)], peak: { s: "e9a3", e: 1800 } };
    expect(provenLevel(h, NOW)).toBe(1600); // e9a3 は 12アクト前 → 1810 - 225 = 1585
  });
  it("履歴が無ければ null", () => {
    expect(provenLevel(null, NOW)).toBeNull();
    expect(provenLevel({ acts: [], peak: null }, NOW)).toBeNull();
  });
});

describe("blendBase", () => {
  it("元イモータルで現在ダイヤの人は、安定したアセンダント1より高くなる", () => {
    // 実績 2075（イモータル1・4アクト前）、現在ダイヤ2 50RR = 1650、今アクト30試合
    const base = blendBase(1650, 2075, 30)!;
    expect(base).toBe(1894);
    expect(base).toBeGreaterThan(1850);
  });
  it("今アクトの試合数が少ないほど、実績へ大きく寄せる", () => {
    expect(blendBase(1000, 2000, 0)).toBe(1750);
    expect(blendBase(1000, 2000, 10)).toBe(1750);
    expect(blendBase(1000, 2000, 30)).toBe(1575);
    expect(blendBase(1000, 2000, 80)).toBe(1400);
  });
  it("現在ランクが実績以上なら、そのまま使う", () => {
    expect(blendBase(1900, 1700, 5)).toBe(1900);
    expect(blendBase(1900, null, 5)).toBe(1900);
  });
  it("現在ランクが無ければ、実績から少し引く。どちらも無ければ null", () => {
    expect(blendBase(null, 1800, 0)).toBe(1750);
    expect(blendBase(null, null, 0)).toBeNull();
  });
});

describe("summarizeMmr", () => {
  it("最終ランクとアクトランクの高い方を実績にし、旧ランク体系のIDを直す", () => {
    const h = summarizeMmr({
      peak: { season: { short: "e9a3" }, ranking_schema: "ascendant", tier: { id: 21 }, rr: 0 },
      seasonal: [
        { season: { short: "e3a1" }, games: 40, end_tier: { id: 21 }, end_rr: 20, ranking_schema: "base", act_rank: { id: 0 } },
        { season: { short: "e10a6" }, games: 160, end_tier: { id: 20 }, end_rr: 0, ranking_schema: "ascendant", act_rank: { id: 21 } },
        { season: { short: "e11a4" }, games: 0, end_tier: { id: 0 }, end_rr: 0, ranking_schema: "ascendant", act_rank: { id: 0 } },
        { season: { short: "e11a6" }, games: 26, end_tier: { id: 19 }, end_rr: 17, ranking_schema: "ascendant", act_rank: { id: 19 } },
      ],
    });
    expect(h.peak).toEqual({ s: "e9a3", e: 1800 });
    expect(h.acts).toEqual([
      { s: "e3a1", g: 40, e: 2120 }, // 旧体系のイモータル1（ID 21）は現行の ID 24
      { s: "e10a6", g: 160, e: 1800 }, // 最終はダイヤ3だが、アクトランクはアセンダント1
      { s: "e11a6", g: 26, e: 1617 },
    ]);
    expect(gamesThisAct(h, NOW)).toBe(26);
  });
});

describe("newcomerBase", () => {
  it("ランクの記録がない人は、アカウントレベルが低いほど低く置く", () => {
    expect(newcomerBase(5)).toBe(200); // コンペに参加できないレベル
    expect(newcomerBase(23)).toBe(265);
    expect(newcomerBase(100)).toBe(650);
    expect(newcomerBase(300)).toBe(900); // どれだけ高くても、ランクなしならゴールド1相当まで
  });
});

describe("summarizeRr / rrShift", () => {
  const T0 = Date.parse("2026-11-17T00:00:00Z");
  const day = 24 * 60 * 60 * 1000;
  const e = (daysAgo: number, change: number, extra: object = {}) => ({ date: new Date(T0 - daysAgo * day).toISOString(), last_change: change, queue_id: "competitive", ...extra });
  it("勝ちの平均と負けの平均をまとめる", () => {
    expect(summarizeRr([e(1, 28), e(2, -8), e(3, 26), e(4, -10)], T0)).toEqual({ w: 27, l: -9, n: 4 });
  });
  it("認定戦・放置ペナルティ・増減なし・古い試合は数えない", () => {
    const h = [e(1, 20), e(2, -15), e(3, 22), e(4, -17), e(5, 40, { is_placement_match: true }), e(6, -30, { afk_penalty: 8 }), e(7, 0), e(200, 35)];
    expect(summarizeRr(h, T0)).toEqual({ w: 21, l: -16, n: 4 });
  });
  it("勝ち・負けのどちらかが2試合に満たなければ使わない", () => {
    expect(summarizeRr([e(1, 20), e(2, 22), e(3, -15)], T0)).toBeNull();
    expect(summarizeRr([], T0)).toBeNull();
    expect(summarizeRr(null, T0)).toBeNull();
  });
  it("直近20試合だけを見る", () => {
    const recent = Array.from({ length: 20 }, (_, i) => e(i + 1, i % 2 ? -15 : 15));
    expect(summarizeRr([...recent, e(30, 99), e(31, -1)], T0)).toEqual({ w: 15, l: -15, n: 20 });
  });
  it("差し引きがプラスなら土台を上げ、試合数が少ないほど弱め、上限で止める", () => {
    expect(rrShift({ w: 18, l: -18, n: 20 })).toBe(0);
    expect(rrShift({ w: 24, l: -16, n: 12 })).toBe(150); // 8 × 25 × 12/16
    expect(rrShift({ w: 15, l: -21, n: 8 })).toBe(-100); // -6 × 25 × 8/12
    expect(rrShift({ w: 40, l: -5, n: 20 })).toBe(300);
    expect(rrShift(null)).toBe(0);
  });
});
