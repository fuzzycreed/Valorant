// チーム分けの計算。DB にも Discord にも依存しない純粋関数。

import type { Role } from "./agents";

/** ロールの偏り1人分を、レート何点分の不利として扱うか。 */
export const ROLE_WEIGHT = 25;
/**
 * 「振り直し」で許す、最良案との差（1人あたりの戦力差）。押すたびに1段ずつ広げ、3回目で上限に届く。
 * 上限の根拠: カスタム82試合の実測で、戦力差100点の勝率は約65%、40点なら約56%。
 * 戦力差100点未満の試合は勝敗の的中がほぼ五分（16/35）だったので、この範囲なら公平さは実質変わらない。
 */
export const REROLL_TIERS = [12, 25, 40];
export const MAX_OPTIONS = 12;

export interface Candidate {
  id: string;
  rating: number;
  role: Role | null;
}

export interface Split {
  a: string[];
  b: string[];
  /** 1人あたりの戦力差（絶対値）。レートを impact() で「その場での効き方」に直してから比べた値 */
  diff: number;
  /** 合計の戦力差（絶対値）。人数が違うときはこちらで釣り合わせる */
  sumDiff: number;
  cost: number;
}

/**
 * 全ての分け方を調べ、釣り合いの良い順に返す。
 * 10人なら 5対5 の分け方は 126 通りしかないので総当たりで足りる。
 * 比べるのはレートそのものではなく、その場の平均からの離れ具合を impact() で直した「戦力」。
 * 人数が奇数のときは a が1人少なくなる。合計で比べるので、少ない側に強い人が寄る。
 */
export function balance(players: Candidate[]): Split[] {
  const n = players.length;
  if (n < 2) return [];
  const sizeA = Math.floor(n / 2);
  const sizeB = n - sizeA;
  const out: Split[] = [];
  const pick: number[] = [];
  // その場の平均から見た各人の効き方。平均から大きく離れた人は、レート差以上に試合へ影響する
  const mean = players.reduce((a, p) => a + p.rating, 0) / n;
  const strength = players.map((p) => mean + impact(p.rating - mean));

  const evaluate = () => {
    const inA = new Set(pick);
    let sumA = 0, sumB = 0;
    const roles = new Map<Role, number>();
    players.forEach((p, i) => {
      const sign = inA.has(i) ? 1 : -1;
      if (sign > 0) sumA += strength[i];
      else sumB += strength[i];
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

/** 「この2人は同じチームに」「この2人は別のチームに」という指定。 */
export interface Pair {
  a: string;
  b: string;
  mode: "together" | "apart";
}

/**
 * ペアの指定を満たす分け方だけに絞る。点数で釣り合いを崩すのではなく、満たさない案を候補から外す。
 * その場にいない人を含む指定は無視する。すべてを満たす分け方が1つも無ければ、絞らずに返す（satisfied が false）。
 */
export function applyPairs(splits: Split[], pairs: Pair[]): { splits: Split[]; satisfied: boolean } {
  if (!pairs.length || !splits.length) return { splits, satisfied: true };
  const ok = splits.filter((s) => {
    const inA = new Set(s.a), inB = new Set(s.b);
    return pairs.every((p) => {
      if (!(inA.has(p.a) || inB.has(p.a)) || !(inA.has(p.b) || inB.has(p.b)) || p.a === p.b) return true;
      const same = inA.has(p.a) === inA.has(p.b);
      return p.mode === "together" ? same : !same;
    });
  });
  return ok.length ? { splits: ok, satisfied: true } : { splits, satisfied: false };
}

/** 振り直しの候補。tier は最良案との差の段階（0 = 最良案、1〜3 = REROLL_TIERS の何段目の範囲に入るか）。 */
export interface RerollOption extends Split {
  tier: number;
}

/** 種から決まる乱数（同じ種なら同じ並びになる。Discord ではボタンを押すたびに計算し直すため）。 */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 「振り直し」で順番に出す候補。先頭は最良案。
 * 1回目は最良案から1人あたり 12点以内、2回目は 25点以内、3回目以降は 40点以内（上限）の案から、
 * まだ出していないものを無作為に1つ選ぶ。その範囲に候補が無ければ、次の範囲へ先に広げる。
 * 比べるのは cost（戦力の合計の差 + ロールの偏り）なので、ロールが偏る案はそのぶん範囲に入りにくい。
 */
export function rerollOptions(splits: Split[], seed = 0): RerollOption[] {
  if (!splits.length) return [];
  const best = splits[0];
  // cost は合計の差なので、1人あたりの点数に人数（片側ぶん）を掛けて比べる
  const perSide = (best.a.length + best.b.length) / 2;
  const tierOf = (s: Split) => REROLL_TIERS.findIndex((t) => s.cost <= best.cost + t * perSide) + 1;
  const pool = splits.slice(1).map((s) => ({ ...s, tier: tierOf(s) })).filter((s) => s.tier > 0);
  const out: RerollOption[] = [{ ...best, tier: 0 }];
  const rand = seeded(seed);
  for (let press = 1; out.length < MAX_OPTIONS && pool.length; press++) {
    const allowed = Math.min(press, REROLL_TIERS.length);
    const lowest = Math.min(...pool.map((s) => s.tier));
    const within = pool.filter((s) => s.tier <= Math.max(allowed, lowest));
    const pick = within[Math.floor(rand() * within.length)];
    pool.splice(pool.indexOf(pick), 1);
    out.push(pick);
  }
  return out;
}

// ---------- 成績と実力の関係（実測値） ----------
// コンペ2,076試合・のべ20,355人分（本人、一緒に組んだ人、同じ試合にいた人をランク帯が偏らないように集めたもの）から求めた値。

/**
 * 同じロールでも、エージェントによって ACS の出やすさが違う（例: デュエリストでもレイナ 1.09、ネオン 0.99）。
 * 値は試合内の10人平均を 1.00 としたもので、ランク差の影響を除いてある。
 * 件数が少ないエージェントほど、同じロールのエージェントの平均へ寄せて推定している（30件で半々）。
 */
export const AGENT_ACS: Record<string, number> = {
  iso: 1.09, reyna: 1.09, phoenix: 1.08, jett: 1.07, raze: 1.02, yoru: 1.02, hush: 1.0, neon: 0.99, waylay: 0.99,
  breach: 0.95, "kay/o": 0.94, tejo: 0.92, gekko: 0.91, sova: 0.89, fade: 0.88, skye: 0.86,
  clove: 1.08, harbor: 1.04, miks: 0.99, brimstone: 0.98, viper: 0.98, omen: 0.97, astra: 0.96,
  chamber: 1.04, vyse: 0.99, veto: 0.98, deadlock: 0.97, killjoy: 0.97, cypher: 0.94, sage: 0.93,
};
/**
 * 表に無いエージェント（新しく追加されたものなど）に使う、ロールごとの値。
 * 試合数で重み付けした平均ではなく、エージェントごとの値の単純平均にしてある
 * （重み付けすると、使用者の多い1体に引っ張られて、他のエージェントの目安として偏るため）。
 */
export const ROLE_ACS: Record<Role, number> = { duelist: 1.04, initiator: 0.91, controller: 1.0, sentinel: 0.97 };
/** その試合で使ったエージェント（無ければロール）から見込まれる、平均的な ACS 比。 */
export function acsBaseline(agent: string | null | undefined, role: Role | null): number {
  return (agent && AGENT_ACS[agent.toLowerCase()]) || (role ? ROLE_ACS[role] : 1);
}
/** レート1点差あたりの、ロール補正後 ACS の変化（100点差で約 6.3%）。 */
export const ACS_PER_POINT = 0.00063;
/**
 * 見込みの成績の下限。どれだけ格上の試合に入っても ACS はこの辺りで下げ止まる
 * （実測: 試合の平均より 500点以上低い人でも、平均の 0.55〜0.65 倍は取れている）。
 */
export const EXPECTED_FLOOR = 0.55;

/**
 * その場の平均からの離れ具合を、実際の効き方に直す。
 * 平均の近くではレート差どおりに効くが、大きく離れると差以上に効く:
 * 平均より 350点以上低い人は急に活躍しにくくなり（2.5倍）、250点以上高い人は試合を動かしやすい（1.3倍）。
 */
export const HIGH_KNEE = 250;
export const HIGH_FACTOR = 1.3;
export const LOW_KNEE = -350;
export const LOW_FACTOR = 2.5;
export function impact(gap: number): number {
  if (gap > HIGH_KNEE) return HIGH_KNEE + (gap - HIGH_KNEE) * HIGH_FACTOR;
  if (gap < LOW_KNEE) return LOW_KNEE + (gap - LOW_KNEE) * LOW_FACTOR;
  return gap;
}

// ---------- 直近の成績による補正 ----------

/** 1試合ぶんの成績。ratio は「自分の ACS ÷ その試合の10人の平均 ACS」。 */
export interface PerfSample {
  ratio: number;
  role: Role | null;
  /** 使ったエージェント。分かれば、ロールの平均ではなくエージェントごとの平均で均す */
  agent?: string | null;
  /** その試合の参加者の平均ランク（点数）。分からなければ null */
  lobbyElo: number | null;
}
/** 試合数が少ないうちは補正を弱める。n 試合なら n / (n + この値) 倍。 */
export const PERF_SHRINK = 8;
export const PERF_CAP = 300;

/**
 * 直近の成績からレート補正を求める。
 * 1試合ごとに「エージェント（無ければロール）で均した ACS」と「土台のレートの人が、その試合のランク帯で出すはずの ACS」を比べ、
 * その差を点数に直して平均する。格下相手に稼いだぶんや、デュエリストを使って伸びたぶんは補正に入らない。
 */
export function perfAdjustment(samples: PerfSample[], base: number): number {
  const n = samples.length;
  if (!n) return 0;
  let sum = 0;
  for (const s of samples) {
    const actual = s.ratio / acsBaseline(s.agent, s.role);
    const expected = Math.max(EXPECTED_FLOOR, 1 + ACS_PER_POINT * (s.lobbyElo == null ? 0 : impact(base - s.lobbyElo)));
    sum += actual - expected;
  }
  const points = sum / n / ACS_PER_POINT;
  return Math.round(Math.max(-PERF_CAP, Math.min(PERF_CAP, (points * n) / (n + PERF_SHRINK))));
}
