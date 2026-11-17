// ランクの履歴から「ランク由来の土台」を求める純粋関数。
//
// 現在のランクだけを見ると、最近あまり遊んでいない人や、今シーズンは本気でやっていない人を
// 実力より低く見積もってしまう。そこで、過去のアクトで到達していた水準（実績）を出し、
// 現在ランクがそれより低い場合は、実績の側へ寄せる。

/** 1つのアクトの成績。e はそのアクトで到達したランクの数値（1段階 = 100）。 */
export interface ActRecord {
  /** アクトの短縮名。例: "e10a6" */
  s: string;
  /** そのアクトのコンペ試合数 */
  g: number;
  e: number;
}
export interface RankHistory {
  acts: ActRecord[];
  /** API が返す生涯最高ランク */
  peak: { s: string; e: number } | null;
}

/** 実績として数えるのに必要な、そのアクトの試合数（認定戦だけの結果などを除くため）。 */
export const MIN_ACT_GAMES = 10;
/** この数のアクト（約半年）以内の実績は、そのままの値で扱う。 */
export const FRESH_ACTS = 3;
/** それより古い実績は、1アクト古くなるごとにこの点数だけ割り引く。 */
export const DECAY_PER_ACT = 25;
/** 割り引きの上限（どれだけ古くても、これ以上は引かない）。 */
export const DECAY_MAX = 300;
/** 現在ランクを実績へ寄せる割合。今アクトの試合数が少ないほど大きく寄せる。 */
export const PULL_MAX = 0.75;
export const PULL_MIN = 0.4;
export const PULL_FEW_GAMES = 10;
export const PULL_MANY_GAMES = 50;
/** 現在ランクが無い人の土台: 実績からこの点数を引く（ブランクぶん）。 */
export const UNRANKED_PENALTY = 50;

const tierElo = (tier: number, rr = 0) => (tier - 3) * 100 + rr;

/**
 * アクトの通し番号（1アクト ≒ 2か月）。エピソード9までは1エピソード3アクト、
 * エピソード10以降は1年6アクト。
 */
export function actIndex(short: string | null | undefined): number | null {
  const m = /^e(\d+)a(\d+)$/.exec(short ?? "");
  if (!m) return null;
  const e = Number(m[1]), a = Number(m[2]);
  return e <= 9 ? (e - 1) * 3 + a : 27 + (e - 10) * 6 + a;
}

/** HenrikDev の MMR 応答から、保存用の小さな履歴を作る。 */
export function summarizeMmr(d: any): RankHistory {
  // アセンダント追加前（base）のランクIDは、イモータル以上が3つ小さい
  const fix = (tier: number, schema: string | undefined) => (schema === "base" && tier >= 21 ? tier + 3 : tier);
  const acts: ActRecord[] = [];
  for (const s of d?.seasonal ?? []) {
    const end = fix(s?.end_tier?.id ?? 0, s?.ranking_schema);
    const badge = fix(s?.act_rank?.id ?? 0, s?.ranking_schema);
    if (end < 3 && badge < 3) continue;
    // 最終ランクと、そのアクトのアクトランク（勝ち試合の上位から決まるバッジ）の高い方を実績とする
    const e = Math.max(end >= 3 ? tierElo(end, s?.end_rr ?? 0) : 0, badge >= 3 ? tierElo(badge) : 0);
    if (s?.season?.short) acts.push({ s: s.season.short, g: s?.games ?? 0, e });
  }
  const pk = d?.peak;
  const pkTier = fix(pk?.tier?.id ?? 0, pk?.ranking_schema);
  const peak = pkTier >= 3 && pk?.season?.short ? { s: pk.season.short, e: tierElo(pkTier, pk?.rr ?? 0) } : null;
  return { acts, peak };
}

const decay = (age: number) => Math.min(DECAY_MAX, Math.max(0, age - FRESH_ACTS) * DECAY_PER_ACT);

/** 過去の実績から見た水準。古い実績ほど割り引き、その中で一番高い値を取る。 */
export function provenLevel(h: RankHistory | null | undefined, nowIndex: number): number | null {
  if (!h) return null;
  let best: number | null = null;
  const consider = (short: string, elo: number) => {
    const i = actIndex(short);
    if (i == null) return;
    const v = elo - decay(Math.max(0, nowIndex - i));
    if (best == null || v > best) best = v;
  };
  for (const a of h.acts) if (a.g >= MIN_ACT_GAMES) consider(a.s, a.e);
  if (h.peak) consider(h.peak.s, h.peak.e);
  return best == null ? null : Math.round(best);
}

/** 今のアクトのコンペ試合数。 */
export function gamesThisAct(h: RankHistory | null | undefined, nowIndex: number): number {
  return h?.acts.find((a) => actIndex(a.s) === nowIndex)?.g ?? 0;
}

/**
 * ランク由来の土台。
 * - 現在ランクが実績以上なら、現在ランクをそのまま使う
 * - 実績より低ければ、差の 40〜75% だけ実績へ寄せる（今アクトの試合数が少ないほど大きく）
 * - 現在ランクが無ければ、実績から少し引いた値
 */
export function blendBase(current: number | null, proven: number | null, games: number): number | null {
  if (current == null) return proven == null ? null : proven - UNRANKED_PENALTY;
  if (proven == null || proven <= current) return current;
  const t = Math.min(1, Math.max(0, (games - PULL_FEW_GAMES) / (PULL_MANY_GAMES - PULL_FEW_GAMES)));
  const pull = PULL_MAX - (PULL_MAX - PULL_MIN) * t;
  return Math.round(current + (proven - current) * pull);
}
