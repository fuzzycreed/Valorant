// チーム分け用のレート算出。ランク（elo）を土台に、直近の成績で補正する。

import { roleOf, type Role } from "./agents";
import { perfAdjustment } from "./balance";
import type { Env } from "./db";
import { Henrik, HenrikError } from "./henrik";

const RANK_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const PERF_WINDOW_MS = 120 * 24 * 60 * 60 * 1000;
const PERF_MATCHES = 20;
/** ランクも過去の試合も無い人だけの集まりだった場合の仮レート（ゴールド1相当）。 */
const DEFAULT_RATING = 900;

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
}

export interface Rated {
  userId: string;
  name: string;
  tag: string;
  tier: number | null;
  rr: number | null;
  /** ランク由来の土台。ランクが無い場合は推定値で、estimated が true */
  base: number;
  estimated: boolean;
  /** 直近の成績による補正 */
  adj: number;
  rating: number;
  role: Role | null;
  samples: number;
}

export const isStale = (l: Link, now = Date.now()) => now - (l.rank_updated_at ?? 0) > RANK_MAX_AGE_MS;

/** HenrikDev から現在のランクを取り直して保存する。1人失敗しても他は続ける。 */
export async function refreshRanks(env: Env, api: Henrik, links: Link[]): Promise<void> {
  const now = Date.now();
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
        await env.DB.prepare(
          `UPDATE discord_links SET tier = ?, rr = ?, elo = ?, name = ?, tag = ?, rank_updated_at = ? WHERE user_id = ?`,
        )
          .bind(l.tier, l.rr, l.elo, l.name, l.tag, now, l.user_id)
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
     SELECT r.puuid, r.agent, r.tier, r.acs,
            (SELECT AVG(o.score * 1.0 / o.rounds) FROM player_matches o WHERE o.match_id = r.match_id AND o.rounds > 0) AS lobby_acs
     FROM recent r WHERE r.rn <= ?3 ORDER BY r.puuid, r.rn`,
  )
    .bind(JSON.stringify(links.map((l) => l.puuid)), Date.now() - PERF_WINDOW_MS, PERF_MATCHES)
    .all<{ puuid: string; agent: string | null; tier: number | null; acs: number; lobby_acs: number | null }>();

  const perf = new Map<string, { ratios: number[]; roles: Map<Role, number>; lastTier: number | null }>();
  for (const r of results) {
    const p = perf.get(r.puuid) ?? { ratios: [] as number[], roles: new Map<Role, number>(), lastTier: null as number | null };
    if (r.lobby_acs) p.ratios.push(r.acs / r.lobby_acs);
    const role = roleOf(r.agent);
    if (role) p.roles.set(role, (p.roles.get(role) ?? 0) + 1);
    if (p.lastTier == null && r.tier && r.tier >= 3) p.lastTier = r.tier;
    perf.set(r.puuid, p);
  }

  const partial = links.map((l) => {
    const p = perf.get(l.puuid);
    const samples = p?.ratios.length ?? 0;
    const ratio = samples ? p!.ratios.reduce((a, b) => a + b, 0) / samples : null;
    const role = p && p.roles.size ? [...p.roles.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
    const ranked = l.elo != null && (l.tier ?? 0) >= 3;
    // 現在ランクなしの人は、最後に試合で確認できたランクの中央（50RR）を土台にする
    const base = ranked ? l.elo! : p?.lastTier ? (p.lastTier - 3) * 100 + 50 : null;
    return { l, base, ranked, adj: perfAdjustment(ratio, samples), role, samples, lastTier: p?.lastTier ?? null };
  });
  const known = partial.filter((x) => x.base != null).map((x) => x.base!);
  const fallback = known.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : DEFAULT_RATING;

  return partial.map((x) => {
    const base = x.base ?? fallback;
    return {
      userId: x.l.user_id,
      name: x.l.name,
      tag: x.l.tag,
      tier: x.ranked ? x.l.tier : x.lastTier,
      rr: x.ranked ? x.l.rr : null,
      base,
      estimated: !x.ranked,
      adj: x.adj,
      rating: base + x.adj,
      role: x.role,
      samples: x.samples,
    };
  });
}
