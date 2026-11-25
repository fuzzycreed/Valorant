// 分析用の保管庫（R2）。D1 に取り込んだ試合の集計結果を1試合1ファイルで書き出し、
// 別の環境（分析用の作業環境など）から、合言葉つきの API でまとめて取り出せるようにする。
//
//   matches/<match_id>.json   … matches の1行と、その試合の player_matches の全行
//   people/<YYYY-MM-DD>.json  … その日の players と登録者（ランク・過去の実績・RR の動き）の控え
//   crawl/...                 … 分析側が集めた追加データ（PUT で置ける）
//
// R2 のバインディング（ARCHIVE）が無ければ何もしない。API は ARCHIVE_TOKEN が設定されているときだけ有効。

import type { Env } from "./db";

const FORMAT = 1;
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

/** まだ書き出していない試合を limit 件まで R2 に書き出す。書き出した件数を返す。 */
export async function archiveStep(env: Env, limit: number, now = Date.now()): Promise<number> {
  const bucket = env.ARCHIVE;
  if (!bucket) return 0;
  const { results: ms } = await env.DB.prepare(`SELECT * FROM matches WHERE archived = 0 ORDER BY match_id LIMIT ?`).bind(limit).all<Record<string, unknown>>();
  if (ms.length) {
    const ids = ms.map((m) => m.match_id as string);
    const { results: ps } = await env.DB.prepare(`SELECT * FROM player_matches WHERE match_id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(ids))
      .all<Record<string, unknown>>();
    await Promise.all(
      ms.map((m) => {
        const { archived: _archived, ...match } = m;
        const body = JSON.stringify({ format: FORMAT, match, players: ps.filter((p) => p.match_id === m.match_id) });
        return bucket.put(`matches/${m.match_id}.json`, body, { httpMetadata: { contentType: "application/json" } });
      }),
    );
    await env.DB.prepare(`UPDATE matches SET archived = 1 WHERE match_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).run();
  }
  await snapshotPeople(env, bucket, now);
  return ms.length;
}

/** 1日1回、players と登録者の状態を控える（レートの元になる値が日ごとにどう動いたかを後から追えるようにする）。 */
async function snapshotPeople(env: Env, bucket: R2Bucket, now: number): Promise<void> {
  const day = new Date(now).toISOString().slice(0, 10);
  const last = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'archive_people'`).first<{ value: string }>();
  if (last?.value === day) return;
  const [players, links] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(`SELECT * FROM players`),
    env.DB.prepare(`SELECT * FROM discord_links`),
  ]);
  // Discord のユーザーID は外に出さない（登録の経路だけ残す）
  const people = links.results.map(({ user_id, ...l }) => ({ ...l, via: String(user_id).startsWith("web:") ? "web" : "discord" }));
  await bucket.put(`people/${day}.json`, JSON.stringify({ format: FORMAT, day, players: players.results, links: people }), {
    httpMetadata: { contentType: "application/json" },
  });
  await env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('archive_people', ?)`).bind(day).run();
}

async function sameToken(given: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(given)), crypto.subtle.digest("SHA-256", enc.encode(expected))]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const BATCH_MAX = 25;
/** 収集対象の人数の上限（sync.ts の TRACK_MAX と同じ値）。 */
const TRACK_LIMIT = 400;
const PUT_MAX_BYTES = 5_000_000;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,200}$/;

/**
 * 保管庫の読み出し API（/api/archive/...）。Authorization: Bearer <ARCHIVE_TOKEN> が必要。
 *   GET  list?prefix=&cursor=&limit=   キーの一覧
 *   GET  get?key=                      1ファイルをそのまま返す
 *   POST batch  {"keys":[...]}         最大25ファイルを、1行1ファイルの NDJSON（{"key","body"}）で返す
 *   PUT  put?key=crawl/...             分析側が集めたデータを置く（crawl/ の下だけ）
 *   GET  errors                        取り込みに失敗して止まっている試合の一覧
 *   GET/POST track                     収集対象（試合を拾い続ける人）の一覧・追加（{"players":[{puuid,name,tag}]}）
 */
export async function handleArchive(req: Request, env: Env, url: URL): Promise<Response> {
  const bucket = env.ARCHIVE;
  if (!bucket || !env.ARCHIVE_TOKEN) return json({ error: "保管庫は設定されていません" }, 404);
  const given = /^Bearer (.+)$/.exec(req.headers.get("Authorization") ?? "")?.[1] ?? "";
  if (!given || !(await sameToken(given, env.ARCHIVE_TOKEN))) return json({ error: "認証に失敗しました" }, 401);

  const action = url.pathname.replace(/^\/api\/archive\//, "");
  const q = url.searchParams;
  if (req.method === "GET" && action === "list") {
    const limit = Math.min(1000, Math.max(1, Number(q.get("limit")) || 1000));
    const r = await bucket.list({ prefix: q.get("prefix") ?? undefined, cursor: q.get("cursor") ?? undefined, limit });
    return json({
      objects: r.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded.getTime() })),
      cursor: r.truncated ? r.cursor : null,
    });
  }
  if (req.method === "GET" && action === "get") {
    const o = await bucket.get(q.get("key") ?? "");
    if (!o) return json({ error: "見つかりません" }, 404);
    return new Response(o.body, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
  }
  if (req.method === "POST" && action === "batch") {
    const keys = ((await req.json().catch(() => null)) as { keys?: unknown } | null)?.keys;
    if (!Array.isArray(keys) || keys.length > BATCH_MAX || keys.some((k) => typeof k !== "string")) return json({ error: `keys は ${BATCH_MAX} 件までの文字列の配列で指定してください` }, 400);
    const lines = await Promise.all(
      (keys as string[]).map(async (key) => {
        const o = await bucket.get(key);
        // 保存してあるのは JSON なので、文字列のままつなげば NDJSON の1行になる
        return o ? `{"key":${JSON.stringify(key)},"body":${await o.text()}}` : `{"key":${JSON.stringify(key)},"body":null}`;
      }),
    );
    return new Response(lines.join("\n") + "\n", { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
  }
  if (action === "track") {
    if (req.method === "POST") {
      const players = ((await req.json().catch(() => null)) as { players?: unknown } | null)?.players;
      const ok = Array.isArray(players) && players.length <= 200 && players.every((p) => typeof p?.puuid === "string" && /^[0-9a-f-]{36}$/.test(p.puuid));
      if (!ok) return json({ error: "players は {puuid, name, tag} の配列（200件まで）で指定してください" }, 400);
      const now = Date.now();
      const res = await env.DB.prepare(
        `INSERT OR IGNORE INTO tracked (puuid, name, tag, region, added_at, origin)
         SELECT json_extract(value, '$.puuid'), json_extract(value, '$.name'), json_extract(value, '$.tag'), ?2, ?3, 'manual' FROM json_each(?1)
         WHERE (SELECT COUNT(*) FROM tracked) < ?4`,
      )
        .bind(JSON.stringify(players), env.REGION, now, TRACK_LIMIT)
        .run();
      return json({ added: res.meta.changes ?? 0 });
    }
    if (req.method === "GET") {
      const { results } = await env.DB.prepare(`SELECT puuid, name, tag, origin, added_at, checked_at FROM tracked ORDER BY added_at`).all();
      return json({ count: results.length, limit: TRACK_LIMIT, players: results });
    }
  }
  if (req.method === "GET" && action === "usage") {
    // D1 の読み書き行数の記録（処理ごと・重かった文ごと）。day を省くと今日（UTC）
    const day = q.get("day") ?? new Date().toISOString().slice(0, 10);
    const { results } = await env.DB.prepare(`SELECT source, sql, calls, reads, writes FROM usage_log WHERE day = ? ORDER BY reads DESC LIMIT 200`).bind(day).all();
    return json({ day, rows: results });
  }
  if (req.method === "GET" && action === "errors") {
    // 取り込みに失敗して止まっている試合（原因の確認用）
    const { results } = await env.DB.prepare(
      `SELECT match_id, queue, started_at, attempts, error, updated_at FROM match_queue WHERE status = 'error' ORDER BY updated_at DESC LIMIT 100`,
    ).all();
    return json({ errors: results });
  }
  if (req.method === "PUT" && action === "put") {
    const key = q.get("key") ?? "";
    if (!key.startsWith("crawl/") || !KEY_RE.test(key) || key.includes("..")) return json({ error: "key は crawl/ で始まる英数字のパスにしてください" }, 400);
    const body = await req.text();
    if (!body || body.length > PUT_MAX_BYTES) return json({ error: "本文が空か、大きすぎます" }, 400);
    try {
      JSON.parse(body.startsWith("{") || body.startsWith("[") ? body : body.split("\n", 1)[0]);
    } catch {
      return json({ error: "JSON（または1行1件の NDJSON）で送ってください" }, 400);
    }
    await bucket.put(key, body, { httpMetadata: { contentType: "application/json" } });
    return json({ ok: true, key, size: body.length });
  }
  return json({ error: "not found" }, 404);
}
