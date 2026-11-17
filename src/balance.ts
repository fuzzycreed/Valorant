// チーム分けの計算。DB にも Discord にも依存しない純粋関数。

import type { Role } from "./agents";

/** ロールの偏り1人分を、レート何点分の不利として扱うか。 */
export const ROLE_WEIGHT = 25;
/** 「振り直し」で候補に含める範囲: 最良案からこの点数以内の案まで。 */
export const REROLL_SLACK = 60;
export const MAX_OPTIONS = 12;

export interface Candidate {
  id: string;
  rating: number;
  role: Role | null;
}

export interface Split {
  a: string[];
  b: string[];
  /** 平均レートの差（絶対値） */
  diff: number;
  /** 合計レートの差（絶対値）。人数が違うときはこちらで釣り合わせる */
  sumDiff: number;
  cost: number;
}

/**
 * 全ての分け方を調べ、釣り合いの良い順に返す。
 * 10人なら 5対5 の分け方は 126 通りしかないので総当たりで足りる。
 * 人数が奇数のときは a が1人少なくなる。合計レートで比べるので、少ない側に強い人が寄る。
 */
export function balance(players: Candidate[]): Split[] {
  const n = players.length;
  if (n < 2) return [];
  const sizeA = Math.floor(n / 2);
  const sizeB = n - sizeA;
  const out: Split[] = [];
  const pick: number[] = [];

  const evaluate = () => {
    const inA = new Set(pick);
    let sumA = 0, sumB = 0;
    const roles = new Map<Role, number>();
    players.forEach((p, i) => {
      const sign = inA.has(i) ? 1 : -1;
      if (sign > 0) sumA += p.rating;
      else sumB += p.rating;
      if (p.role) roles.set(p.role, (roles.get(p.role) ?? 0) + sign);
    });
    const diff = Math.abs(sumA / sizeA - sumB / sizeB);
    let roleGap = 0;
    for (const v of roles.values()) roleGap += Math.abs(v);
    out.push({
      a: players.filter((_, i) => inA.has(i)).map((p) => p.id),
      b: players.filter((_, i) => !inA.has(i)).map((p) => p.id),
      diff,
      sumDiff: Math.abs(sumA - sumB),
      cost: Math.abs(sumA - sumB) + roleGap * ROLE_WEIGHT,
    });
  };

  // 同人数のときは「先頭の人が a にいる案」だけ数えれば、左右を入れ替えただけの重複を除ける
  const start = sizeA === sizeB ? 1 : 0;
  if (sizeA === sizeB) pick.push(0);
  const rec = (from: number) => {
    if (pick.length === sizeA) return evaluate();
    for (let i = from; i < n; i++) {
      pick.push(i);
      rec(i + 1);
      pick.pop();
    }
  };
  rec(start);
  return out.sort((x, y) => x.cost - y.cost);
}

/** 「振り直し」で順番に出す候補: 最良案と、それに近い案。 */
export function rerollOptions(splits: Split[]): Split[] {
  if (!splits.length) return [];
  const limit = splits[0].cost + REROLL_SLACK;
  return splits.filter((s) => s.cost <= limit).slice(0, MAX_OPTIONS);
}

/** 直近の成績によるレート補正の上限と、成績1.0倍からのずれ1.0あたりの点数。 */
export const PERF_SCALE = 400;
export const PERF_CAP = 150;
/** この試合数に満たないうちは、補正を試合数に比例して弱める。 */
export const PERF_FULL_SAMPLES = 10;

/**
 * 直近の成績からレート補正を求める。
 * ratio は「自分の ACS ÷ その試合の10人の平均 ACS」の平均。1.2 なら毎試合、平均より2割高いスコア。
 */
export function perfAdjustment(ratio: number | null, samples: number): number {
  if (ratio == null || samples <= 0) return 0;
  const raw = Math.max(-PERF_CAP, Math.min(PERF_CAP, (ratio - 1) * PERF_SCALE));
  return Math.round(raw * Math.min(1, samples / PERF_FULL_SAMPLES));
}
