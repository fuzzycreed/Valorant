// チーム分けの対象として登録されたプレイヤーの管理。Discord の /link とウェブの両方から使う。
//
// 保存先は discord_links テーブル。user_id は Discord のユーザーID、
// ウェブから追加した人は "web:<puuid>" という形の ID になる。

import type { Env } from "./db";
import { Henrik, HenrikError } from "./henrik";
import { refreshRanks, type Link } from "./rating";

/** 登録時に取り込み待ちへ積む直近の試合数。 */
const BACKFILL = 10;
const QUEUES = new Set(["competitive", "unrated", "premier"]);

export const WEB_PREFIX = "web:";

export type AccountResult = { ok: true; account: any } | { ok: false; reason: "format" | "not_found" | "rate_limited" };

/** "名前#タグ" を HenrikDev で引く。 */
export async function findAccount(api: Henrik, riotId: string): Promise<AccountResult> {
  const at = riotId.lastIndexOf("#");
  const name = riotId.slice(0, at).trim(), tag = riotId.slice(at + 1).trim();
  if (at < 1 || !name || !tag || name.length > 32 || tag.length > 16) return { ok: false, reason: "format" };
  try {
    return { ok: true, account: (await api.account(name, tag)).data };
  } catch (e) {
    if (e instanceof HenrikError && (e.status === 404 || e.status === 400)) return { ok: false, reason: "not_found" };
    if (e instanceof HenrikError && e.status === 429) return { ok: false, reason: "rate_limited" };
    throw e;
  }
}

/** プレイヤーを登録（または上書き）し、現在のランクを取得して、直近の試合を取り込み待ちに積む。 */
export async function saveLink(env: Env, api: Henrik, userId: string, account: any): Promise<{ link: Link; queued: number }> {
  const link: Link = {
    user_id: userId, puuid: account.puuid, name: account.name, tag: account.tag,
    region: account.region ?? env.REGION, platform: env.PLATFORM, tier: null, rr: null, elo: null, rank_updated_at: 0,
    account_level: account.account_level ?? null,
  };
  await env.DB.prepare(
    `INSERT INTO discord_links (user_id, puuid, name, tag, region, platform, linked_at, account_level) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET puuid = excluded.puuid, name = excluded.name, tag = excluded.tag,
       region = excluded.region, platform = excluded.platform, tier = NULL, rr = NULL, elo = NULL, history = NULL, rr_trend = NULL, rr_updated_at = 0,
       rank_updated_at = 0, discovered_at = 0, linked_at = excluded.linked_at, account_level = excluded.account_level`,
  )
    .bind(userId, link.puuid, link.name, link.tag, link.region, link.platform, Date.now(), link.account_level ?? null)
    .run();
  await refreshRanks(env, api, [link]);
  let queued = 0;
  try {
    queued = await queueRecentMatches(env, api, link);
  } catch (e) {
    if (!(e instanceof HenrikError)) throw e;
  }
  return { link, queued };
}

/** 直近の試合IDを取り込み待ちに積み、次回の確認時刻を更新する。 */
export async function queueRecentMatches(env: Env, api: Henrik, link: Pick<Link, "user_id" | "puuid" | "region">): Promise<number> {
  const h = (await api.matchHistory(link.region, link.puuid, 0, 20)).data;
  const found = ((h?.History ?? []) as any[])
    .filter((e) => QUEUES.has(e.QueueID))
    .slice(0, BACKFILL)
    .map((e) => ({ id: e.MatchID, t: e.GameStartTime ?? 0, q: e.QueueID }));
  const now = Date.now();
  const res = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO match_queue (match_id, region, started_at, queue, updated_at, puuid)
       SELECT json_extract(value, '$.id'), ?1, json_extract(value, '$.t'), json_extract(value, '$.q'), ?2, ?4 FROM json_each(?3)`,
    ).bind(link.region, now, JSON.stringify(found), link.puuid),
    // ほかの人の履歴から先に積まれていた試合も、登録者のものとして優先して取り込む（本人アカウントの試合は生データを残すので触らない）
    env.DB.prepare(
      `UPDATE match_queue SET puuid = ?1 WHERE status = 'pending' AND keep_raw = 0 AND match_id IN (SELECT json_extract(value, '$.id') FROM json_each(?2))`,
    ).bind(link.puuid, JSON.stringify(found)),
    env.DB.prepare(`UPDATE discord_links SET discovered_at = ? WHERE user_id = ?`).bind(now, link.user_id),
  ]);
  return res[0]?.meta?.changes ?? 0;
}

/** 追跡中のプレイヤーが最近コンペで遊んだマップ（現行のマッププールの近似）。 */
export async function recentMaps(env: Env): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT map FROM matches WHERE queue = 'competitive' AND started_at > ? AND map != '' ORDER BY map`,
  )
    .bind(Date.now() - 45 * 24 * 60 * 60 * 1000)
    .all<{ map: string }>();
  return results.map((r) => r.map);
}

const LOOKUP_WINDOW_MS = 10 * 60 * 1000;
const LOOKUP_LIMIT = 40;

/**
 * Riot ID 検索の回数を10分単位で数える（公開サイトなので API の使いすぎを防ぐ）。
 * 厳密な排他はしていない（多少の超過は許容）。
 */
export async function allowLookup(env: Env): Promise<boolean> {
  const now = Date.now();
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'web_lookups'`).first<{ value: string }>();
  let [start, count] = (row?.value ?? "0:0").split(":").map(Number);
  if (now - start > LOOKUP_WINDOW_MS) [start, count] = [now, 0];
  if (count >= LOOKUP_LIMIT) return false;
  await env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('web_lookups', ?)`).bind(`${start}:${count + 1}`).run();
  return true;
}
