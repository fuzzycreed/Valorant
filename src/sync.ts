import { ensureSchema, ingestStatements, type Env } from "./db";
import { gunzip, gzip } from "./gz";
import { queueRecentMatches } from "./roster";
import { Henrik, HenrikError } from "./henrik";
import { refreshRanks, type Link } from "./rating";
import { computeMatch } from "./stats";

const DISCOVER_INTERVAL_MS = 5 * 60 * 1000;
const RANK_INTERVAL_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const HISTORY_PAGE = 20;
const HISTORY_MAX = 100;
/** Discord で登録された人の新着確認: 1人あたりの間隔と、1回の同期で確認する人数。 */
/** 本人のアカウントを、1回の同期で何人まで確認するか。 */
const CONFIG_PER_STEP = 3;
/** RIOT_IDS に書いたのに取得できなかった ID を、次に試し直すまでの間隔。 */
const MISSING_RETRY_MS = 60 * 60 * 1000;
const LINKED_INTERVAL_MS = 60 * 60 * 1000;
const LINKED_PER_STEP = 2;
/** サイトで検索された人: 最近見られた人だけ、間隔を空けて少人数ずつ新着を確認する。 */
const LOOKUP_INTERVAL_MS = 2 * 60 * 60 * 1000;
const LOOKUP_ACTIVE_MS = 14 * 24 * 60 * 60 * 1000;
const LOOKUP_PER_STEP = 2;
/** 検索された人について最初に遡る試合数（本人は取れるだけ遡る）。 */
const LOOKUP_HISTORY = 40;
/** 検索された人では取り込まないモード（ラウンド制ではなく、戦績の集計に使わない）。 */
const SKIP_QUEUES = new Set(["deathmatch", "hurm", "ggteam", "snowball"]);

export interface SyncResult {
  discovered: number;
  processed: number;
  failed: number;
  pending: number;
  /** focus で指定したプレイヤーの取り込み待ち件数 */
  focusPending: number;
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
  source: string;
  last_viewed_at: number;
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
  // 取得できなかった ID（長期間プレイしていないアカウントなど）は、しばらく間を空けてから試し直す
  const misses = new Map(
    (await env.DB.prepare(`SELECT key, value FROM meta WHERE key LIKE 'miss:%'`).all<{ key: string; value: string }>()).results.map((r) => [r.key, Number(r.value)]),
  );
  const out: PlayerRow[] = [];
  for (const id of ids) {
    const hit = results.find(
      (p) => p.name.toLowerCase() === id.name.toLowerCase() && p.tag.toLowerCase() === id.tag.toLowerCase(),
    );
    if (hit) {
      if (hit.source !== "config") {
        // 検索で登録済みだった人が RIOT_IDS に追加された: 本人扱いに切り替え、全履歴を遡り直す
        await env.DB.prepare(`UPDATE players SET source = 'config', backfilled = 0 WHERE puuid = ?`).bind(hit.puuid).run();
        hit.source = "config";
        hit.backfilled = 0;
      }
      out.push(hit);
      continue;
    }
    const missKey = `miss:${id.name.toLowerCase()}#${id.tag.toLowerCase()}`;
    if (Date.now() - (misses.get(missKey) ?? 0) < MISSING_RETRY_MS) continue;
    let acc: any;
    try {
      acc = (await api.account(id.name, id.tag)).data;
    } catch (e) {
      // 1つの ID が引けないだけで全体の同期を止めない（レート制限は呼び出し元で扱う）
      if (!(e instanceof HenrikError) || e.status === 429) throw e;
      console.warn("account lookup failed", id.name, id.tag, e.status);
      await env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).bind(missKey, String(Date.now())).run();
      continue;
    }
    const row: PlayerRow = {
      puuid: acc.puuid,
      name: acc.name,
      tag: acc.tag,
      region: acc.region ?? env.REGION,
      platform: env.PLATFORM,
      rank_updated_at: 0,
      discovered_at: 0,
      backfilled: 0,
      source: "config",
      last_viewed_at: 0,
    };
    // Riot ID を変更した場合も puuid は同じなので、名前だけ更新される
    await env.DB.prepare(
      `INSERT INTO players (puuid, name, tag, region, platform, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (puuid) DO UPDATE SET name = excluded.name, tag = excluded.tag, source = 'config', backfilled = 0`,
    )
      .bind(row.puuid, row.name, row.tag, row.region, row.platform, Date.now())
      .run();
    const existing = results.find((p) => p.puuid === row.puuid);
    out.push(existing ? { ...existing, name: row.name, tag: row.tag, source: "config", backfilled: 0 } : row);
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

/**
 * 新しい試合IDとランク履歴を取得してキューに積む。
 * 本人（config）は初回に取れるだけ過去へ遡り、生データも保存する。
 * 検索された人（lookup）は初回に直近 LOOKUP_HISTORY 試合まで、ラウンド制のモードだけを積む。
 */
/** discover を呼び、そのプレイヤーだけの失敗（アカウントが引けない等）なら次回まで見送って先へ進む。 */
async function safeDiscover(env: Env, api: Henrik, p: PlayerRow): Promise<number> {
  try {
    return await discover(env, api, p);
  } catch (e) {
    if (!(e instanceof HenrikError) || e.status === 429) throw e;
    console.warn("discover failed", p.name, p.tag, e.status);
    await env.DB.prepare(`UPDATE players SET discovered_at = ? WHERE puuid = ?`).bind(Date.now(), p.puuid).run();
    return 0;
  }
}

async function discover(env: Env, api: Henrik, p: PlayerRow): Promise<number> {
  const now = Date.now();
  const owner = p.source === "config";
  const found: { id: string; t: number; q: string | null }[] = [];

  const max = p.backfilled ? HISTORY_PAGE : owner ? HISTORY_MAX : LOOKUP_HISTORY;
  let total = HISTORY_PAGE;
  for (let start = 0; start < total && start < max; start += HISTORY_PAGE) {
    const h = (await api.matchHistory(p.region, p.puuid, start, start + HISTORY_PAGE)).data;
    for (const e of h?.History ?? []) {
      if (!owner && SKIP_QUEUES.has(e.QueueID)) continue;
      found.push({ id: e.MatchID, t: e.GameStartTime ?? 0, q: e.QueueID ?? null });
    }
    total = h?.Total ?? 0;
  }
  if (owner && !p.backfilled) {
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
      `INSERT OR IGNORE INTO match_queue (match_id, region, started_at, queue, updated_at, puuid, keep_raw)
       SELECT json_extract(value, '$.id'), ?1, json_extract(value, '$.t'), json_extract(value, '$.q'), ?2, ?4, ?5
       FROM json_each(?3)`,
    ).bind(p.region, now, JSON.stringify(found), p.puuid, owner ? 1 : 0),
    env.DB.prepare(
      `INSERT OR REPLACE INTO mmr_history (puuid, match_id, date, tier, tier_name, rr, rr_change, elo, map, season)
       SELECT ?1, json_extract(value, '$.match_id'), json_extract(value, '$.date'), json_extract(value, '$.tier'),
              json_extract(value, '$.tier_name'), json_extract(value, '$.rr'), json_extract(value, '$.rr_change'),
              json_extract(value, '$.elo'), json_extract(value, '$.map'), json_extract(value, '$.season')
       FROM json_each(?2)`,
    ).bind(p.puuid, JSON.stringify(mmr)),
  ];

  if (owner) {
    // 他の人の検索で先に取り込まれていた本人の試合は生データが無いので、取り直して保存する
    stmts.push(
      env.DB.prepare(
        `UPDATE match_queue SET keep_raw = 1, status = CASE WHEN status = 'done' THEN 'pending' ELSE status END
         WHERE keep_raw = 0 AND match_id IN (SELECT json_extract(value, '$.id') FROM json_each(?))`,
      ).bind(JSON.stringify(found)),
    );
  }

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
export async function syncStep(
  env: Env,
  opts: { maxMatches?: number; forceDiscover?: boolean; /** いま画面で開かれているプレイヤー。先に確認し、その人の試合を優先して取り込む */ focus?: string } = {},
): Promise<SyncResult> {
  const out: SyncResult = { discovered: 0, processed: 0, failed: 0, pending: 0, focusPending: 0, rateLimited: false, errors: [] };
  const focus = opts.focus ?? "";
  if (!env.HENRIK_API_KEY) throw new Error("HENRIK_API_KEY が設定されていません");
  await ensureSchema(env.DB);
  const api = new Henrik(env.HENRIK_API_KEY);
  const now = Date.now();

  try {
    const seen = new Set<string>();
    // 本人のアカウント: いま開かれている人を先頭に、確認が古い順に1回あたり数人まで（API の回数制限に収めるため）
    const tracked = await trackedPlayers(env, api);
    for (const p of tracked) seen.add(p.puuid);
    const dueOwn = tracked
      .filter((p) => opts.forceDiscover || now - (p.discovered_at ?? 0) >= DISCOVER_INTERVAL_MS)
      .sort((a, b) => Number(b.puuid === focus) - Number(a.puuid === focus) || (a.discovered_at ?? 0) - (b.discovered_at ?? 0));
    for (const p of opts.forceDiscover ? dueOwn : dueOwn.slice(0, CONFIG_PER_STEP)) {
      out.discovered += await safeDiscover(env, api, p);
    }

    // 検索された人: いま開かれている人を最優先、それ以外は最近見られた人を古い順に少しずつ
    const lookups = await env.DB.batch<PlayerRow>([
      env.DB.prepare(`SELECT * FROM players WHERE puuid = ?`).bind(focus),
      env.DB.prepare(
        `SELECT * FROM players WHERE source = 'lookup' AND last_viewed_at > ? AND discovered_at < ? ORDER BY discovered_at LIMIT ?`,
      ).bind(now - LOOKUP_ACTIVE_MS, now - LOOKUP_INTERVAL_MS, LOOKUP_PER_STEP),
    ]);
    const viewed = lookups[0].results[0];
    if (viewed) await env.DB.prepare(`UPDATE players SET last_viewed_at = ? WHERE puuid = ?`).bind(now, viewed.puuid).run();
    const due = [
      ...(viewed && now - (viewed.discovered_at ?? 0) >= DISCOVER_INTERVAL_MS ? [viewed] : []),
      ...lookups[1].results,
    ];
    for (const p of due) {
      if (seen.has(p.puuid)) continue;
      seen.add(p.puuid);
      out.discovered += await safeDiscover(env, api, p);
    }

    // Discord で登録された人は、確認が古い順に少人数ずつ見る（API のレート制限に収めるため）
    const linked = await env.DB.prepare(
      `SELECT * FROM discord_links WHERE discovered_at < ? ORDER BY discovered_at LIMIT ?`,
    )
      .bind(now - LINKED_INTERVAL_MS, LINKED_PER_STEP)
      .all<Link>();
    for (const l of linked.results) {
      out.discovered += await queueRecentMatches(env, api, l);
      await refreshRanks(env, api, [l]);
    }

    const { results } = await env.DB.prepare(
      `SELECT match_id, region, attempts, keep_raw FROM match_queue WHERE status = 'pending'
       ORDER BY (puuid = ?) DESC, started_at DESC LIMIT ?`,
    )
      .bind(focus, opts.maxMatches ?? 2)
      .all<{ match_id: string; region: string; attempts: number; keep_raw: number }>();

    for (const q of results) {
      try {
        const body = await api.matchText(q.region, q.match_id);
        const computed = computeMatch(JSON.parse(body).data);
        await env.DB.batch(ingestStatements(env.DB, computed, q.keep_raw ? body : null));
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

  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n, SUM(puuid = ?) AS mine FROM match_queue WHERE status = 'pending'`,
  )
    .bind(focus)
    .first<{ n: number; mine: number | null }>();
  out.pending = row?.n ?? 0;
  out.focusPending = row?.mine ?? 0;
  await env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('last_sync', ?)`).bind(String(Date.now())).run();
  // 試合を取り込まなかった回にだけ、未圧縮の生データを少しずつ圧縮する（処理の最後に置き、失敗しても同期には響かせない）
  if (!out.processed && !out.rateLimited) await compactRaw(env, COMPACT_PER_STEP).catch((e) => console.warn("compact failed", e));
  return out;
}

const COMPACT_PER_STEP = 2;

/** 未圧縮の生データを gzip で圧縮し直す。圧縮した件数を返す。 */
export async function compactRaw(env: Env, limit: number): Promise<number> {
  const { results } = await env.DB.prepare(`SELECT match_id, body FROM match_raw WHERE gz IS NULL AND body IS NOT NULL LIMIT ?`)
    .bind(limit)
    .all<{ match_id: string; body: string }>();
  for (const row of results) {
    await env.DB.prepare(`UPDATE match_raw SET gz = ?, body = NULL WHERE match_id = ?`).bind(await gzip(row.body), row.match_id).run();
  }
  return results.length;
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
      `SELECT match_id, body, gz FROM match_raw WHERE match_id > ? ORDER BY match_id LIMIT 5`,
    )
      .bind(after)
      .all<{ match_id: string; body: string | null; gz: ArrayBuffer | number[] | null }>();
    if (!results.length) return n;
    for (const row of results) {
      const body = row.body ?? (row.gz ? await gunzip(row.gz) : null);
      if (!body) continue;
      await env.DB.batch(ingestStatements(env.DB, computeMatch(JSON.parse(body).data), null));
      n++;
    }
    after = results[results.length - 1].match_id;
  }
}
