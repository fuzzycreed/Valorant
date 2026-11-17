const GROUPS = ["アイアン", "ブロンズ", "シルバー", "ゴールド", "プラチナ", "ダイヤ", "アセンダント", "イモータル"];

/** ランクID（3=アイアン1 … 27=レディアント）を日本語名にする。 */
export function tierName(id: number | null | undefined): string {
  if (id == null || id < 3) return "ランクなし";
  if (id >= 27) return "レディアント";
  return `${GROUPS[Math.floor((id - 3) / 3)]} ${((id - 3) % 3) + 1}`;
}
