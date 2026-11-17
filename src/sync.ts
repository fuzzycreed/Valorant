import { ensureSchema, ingestStatements, type Env } from "./db";
import { Henrik, HenrikError } from "./henrik";
import { computeMatch } from "./stats";

const DISCOVER_INTERVAL_MS = 5 * 60 * 1000;
const RANK_INTERVAL_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const HISTORY_PAGE = 20;
const HISTORY_MAX = 100;

export interface SyncResult {
  discovered: number;
  processed: number;
  failed: number;
  pending: number;
  rateLimited: boolean;
  errors: string[];
}

interface PlayerRow {
  puuid: string;
  name: string;
  tag: string;
  region: string;
  platform: string;
  rank_updated_at: number;
  discovered_at: number;
  backfilled: number;
}

function parseRiotIds(s: string): { name: string; tag: string }[] {
  return (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const i = x.lastIndexOf("#");
      return { name: x.slice(0, i), tag: x.slice(i + 1) };
    })
    .filter((x) => x.name && x.tag);
}

/** RIOT_IDS に書かれたプレイヤーを players テーブルに揃えて返す。 */
async function trackedPlayers(env: Env, api: Henrik): Promise<PlayerRow[]> {
  const ids = parseRiotIds(env.RIOT_IDS);
  const { results } = await env.DB.prepare(`SELECT * FROM players`).all<PlayerRow>();
  const out: PlayerRow[] = [];
  for (const id of ids) {
    const hit = results.find(
      (p) => p.name.toLowerCase() === id.name.toLowerCase() && p.tag.toLowerCase() === id.tag.toLowerCase(),
    );
    if (hit) {
      out.push(hit);
      continue;
    }
    const acc = (await api.account(id.name, id.tag)).data;
    const row: PlayerRow = {
      puuid: acc.puuid,
      name: acc.name,
      tag: acc.tag,
      region: acc.region ?? env.REGION,
      platform: env.PLATFORM,
      rank_updated_at: 0,
      discovered_at: 0,
      backfilled: 0,
    };
    // Riot ID を変更した場合も puuid は同じなので、名前だけ更新される
    await env.DB.prepare(
      `INSERT INTO players (puuid, name, tag, region, platform, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (puuid) DO UPDATE SET name = excluded.name, tag = excluded.tag`,
    )
      .bind(row.puuid, row.name, row.tag, row.region, row.platform, Date.now())
      .run();
    const existing = results.find((p) => p.puuid === row.puuid);
    out.push(existing ? { ...existing, name: row.name, tag: row.tag } : row);
  }
  return out;
}

function mmrRows(history: any[]) {
  return history
    .filter((h) => h?.match_id)
    .map((h) => ({
      match_id: h.match_id,
      date: Date.parse(h.date),
      tier: h.tier?.id ?? null,
      tier_name: h.tier?.name ?? null,
      rr: h.rr ?? null,
      rr_change: h.last_change ?? null,
      elo: h.elo ?? null,
      map: h.map?.name ?? null,
      season: h.season?.short ?? null,
    }));
}

/** 新しい試合IDとランク履歴を取得してキューに積む。初回は取れるだけ過去に遡る。 */
async function discover(env: Env, api: Henrik, p: PlayerRow): Promise<number> {
  const now = Date.now();
  const found: { id: string; t: number; q: string | null }[] = [];

  let end = HISTORY_PAGE;
  let total = HISTORY_PAGE;
  for (let start = 0; start < total && start < HISTORY_MAX; start += HISTORY_PAGE, end += HISTORY_PAGE) {
    const h = (await api.matchHistory(p.region, p.puuid, start, end)).data;
    for (const e of h?.History ?? []) found.push({ id: e.MatchID, t: e.GameStartTime ?? 0, q: e.QueueID ?? null });
    total = p.backfilled ? 0 : (h?.Total ?? 0);
  }
  if (!p.backfilled) {
    const stored = await api.storedMatches(p.region, p.name, p.tag);
    for (const e of stored?.data ?? []) {
      found.push({ id: e.meta.id, t: Date.parse(e.meta.started_at) || 0, q: (e.meta.mode ?? "").toLowerCase() || null });
    }
  }

  const mmr = mmrRows((await api.mmrHistory(p.region, p.platform, p.name, p.tag)).data?.history ?? []);
  if (!p.backfilled) {
    mmr.push(...mmrRows((await api.mmrHistory(p.region, p.platform, p.name, p.tag, true)).data ?? []));
  }

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO match_queue (match_id, region, started_at, queue, updated_at)
       SELECT json_extract(value, '$.id'), ?1, json_extract(value, '$.t'), json_extract(value, '$.q'), ?2
       FROM json_each(?3)`,
    ).bind(p.region, now, JSON.stringify(found)),
    env.DB.prepare(
      `INSERT OR REPLACE INTO mmr_history (puuid, match_id, date, tier, tier_name, rr, rr_change, elo, map, season)
       SELECT ?1, json_extract(value, '$.match_id'), json_extract(value, '$.date'), json_extract(value, '$.tier'),
              json_extract(value, '$.tier_name'), json_extract(value, '$.rr'), json_extract(value, '$.rr_change'),
              json_extract(value, '$.elo'), json_extract(value, '$.map'), json_extract(value, '$.season')
       FROM json_each(?2)`,
    ).bind(p.puuid, JSON.stringify(mmr)),
  ];

  if (now - (p.rank_updated_at ?? 0) > RANK_INTERVAL_MS) {
    const r = (await api.mmr(p.region, p.platform, p.name, p.tag)).data;
    const rank = { current: r?.current ?? null, peak: r?.peak ?? null };
    stmts.push(
      env.DB.prepare(`UPDATE players SET rank_json = ?, rank_updated_at = ? WHERE puuid = ?`).bind(
        JSON.stringify(rank), now, p.puuid,
      ),
    );
  }
  stmts.push(
    env.DB.prepare(`UPDATE players SET discovered_at = ?, backfilled = 1 WHERE puuid = ?`).bind(now, p.puuid),
  );
  const res = await env.DB.batch(stmts);
  return res[0]?.meta?.changes ?? 0;
}

/**
 * 同期を1ステップ進める: 新着の検出 → キューから maxMatches 件だけ取り込み。
 * 無料プランの CPU 上限に収めるため、1回の呼び出しで処理する試合数を小さく保つ。
 */
export async function syncStep(env: Env, opts: { maxMatches?: number; forceDiscover?: boolean } = {}): Promise<SyncResult> {
  const out: SyncResult = { discovered: 0, processed: 0, failed: 0, pending: 0, rateLimited: false, errors: [] };
  if (!env.HENRIK_API_KEY) throw new Error("HENRIK_API_KEY が設定されていません");
  await ensureSchema(env.DB);
  const api = new Henrik(env.HENRIK_API_KEY);
  const now = Date.now();

  try {
    for (const p of await trackedPlayers(env, api)) {
      if (!opts.forceDiscover && now - (p.discovered_at ?? 0) < DISCOVER_INTERVAL_MS) continue;
      out.discovered += await discover(env, api, p);
    }

    const { results } = await env.DB.prepare(
      `SELECT match_id, region, attempts FROM match_queue WHERE status = 'pending' ORDER BY started_at DESC LIMIT ?`,
    )
      .bind(opts.maxMatches ?? 2)
      .all<{ match_id: string; region: string; attempts: number }>();

    for (const q of results) {
      try {
        const body = await api.matchText(q.region, q.match_id);
        const computed = computeMatch(JSON.parse(body).data);
        await env.DB.batch(ingestStatements(env.DB, computed, body));
        out.processed++;
      } catch (e) {
        if (e instanceof HenrikError && e.status === 429) throw e;
        const attempts = q.attempts + 1;
        const msg = e instanceof Error ? e.message : String(e);
        out.failed++;
        out.errors.push(`${q.match_id}: ${msg}`);
        await env.DB.prepare(`UPDATE match_queue SET attempts = ?, status = ?, error = ?, updated_at = ? WHERE match_id = ?`)
          .bind(attempts, attempts >= MAX_ATTEMPTS ? "error" : "pending", msg.slice(0, 500), Date.now(), q.match_id)
          .run();
      }
    }
  } catch (e) {
    if (e instanceof HenrikError && e.status === 429) out.rateLimited = true;
    else throw e;
  }

  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM match_queue WHERE status = 'pending'`).first<{ n: number }>();
  out.pending = row?.n ?? 0;
  await env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('last_sync', ?)`).bind(String(Date.now())).run();
  return out;
}

/**
 * 保存済みの生データから集計値を作り直す。指標の定義を変えたときに使う保守用の処理。
 * 試合ごとに JSON をパースするので重い。HTTP からは呼ばず、ローカルのスクリプトから実行する。
 */
export async function recomputeAll(env: Env): Promise<number> {
  await ensureSchema(env.DB);
  let after = "";
  let n = 0;
  for (;;) {
    const { results } = await env.DB.prepare(
      `SELECT match_id, body FROM match_raw WHERE match_id > ? ORDER BY match_id LIMIT 5`,
    )
      .bind(after)
      .all<{ match_id: string; body: string }>();
    if (!results.length) return n;
    for (const row of results) {
      await env.DB.batch(ingestStatements(env.DB, computeMatch(JSON.parse(row.body).data), null));
      n++;
    }
    after = results[results.length - 1].match_id;
  }
}
