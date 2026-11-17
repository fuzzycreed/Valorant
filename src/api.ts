import { ensureSchema, type Env } from "./db";

const SUM_COLS = [
  "rounds", "rounds_won", "rounds_lost", "score", "kills", "deaths", "assists",
  "headshots", "bodyshots", "legshots", "damage_dealt", "damage_received",
  "fk", "fd", "fk_wins", "fd_wins", "mk2", "mk3", "mk4", "mk5", "kast_rounds",
  "trade_kills", "traded_deaths", "clutch_attempts", "clutch_wins",
  "atk_rounds", "atk_wins", "def_rounds", "def_wins", "atk_kills", "atk_deaths", "def_kills", "def_deaths",
  "plants", "defuses", "pistol_rounds", "pistol_wins", "loadout_total",
];
const SUMS = [
  `COUNT(*) AS games`,
  `SUM(won = 1) AS wins`,
  `SUM(won = 0) AS losses`,
  `SUM(won IS NULL) AS draws`,
  ...SUM_COLS.map((c) => `SUM(${c}) AS ${c}`),
].join(", ");

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

/** クエリ文字列の絞り込み条件を、player_matches 用の CTE（f）に変換する。 */
function filterCte(q: URLSearchParams, alias = "") {
  const a = alias ? `${alias}.` : "";
  const where = [`${a}puuid = ?`];
  const params: unknown[] = [q.get("puuid") ?? ""];
  const queue = q.get("queue") ?? "competitive";
  if (queue === "all") where.push(`${a}round_based = 1`);
  else {
    where.push(`${a}queue = ?`);
    params.push(queue);
  }
  for (const key of ["season", "agent", "map"]) {
    const v = q.get(key);
    if (v) {
      where.push(`${a}${key} = ?`);
      params.push(v);
    }
  }
  const last = Math.max(0, Math.min(10000, Number(q.get("last")) || 0));
  return { where: where.join(" AND "), params, last };
}

function cte(q: URLSearchParams) {
  const f = filterCte(q);
  const limit = f.last ? ` LIMIT ${f.last}` : "";
  return { sql: `WITH f AS (SELECT * FROM player_matches WHERE ${f.where} ORDER BY started_at DESC${limit})`, params: f.params };
}

async function players(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT puuid, name, tag, region, rank_json, rank_updated_at, discovered_at FROM players ORDER BY created_at`,
  ).all<any>();
  const tracked = (env.RIOT_IDS ?? "").toLowerCase().split(",").map((s) => s.trim());
  return json(
    results
      .filter((p) => tracked.includes(`${p.name}#${p.tag}`.toLowerCase()))
      .map((p) => ({ ...p, rank: p.rank_json ? JSON.parse(p.rank_json) : null, rank_json: undefined })),
  );
}

async function stats(env: Env, q: URLSearchParams) {
  const c = cte(q);
  const puuid = q.get("puuid") ?? "";
  const db = env.DB;
  const [totals, byAgent, byMap, weapons, clutches, mates, options] = await db.batch<any>([
    db.prepare(`${c.sql} SELECT ${SUMS} FROM f`).bind(...c.params),
    db.prepare(`${c.sql} SELECT agent, MAX(agent_id) AS agent_id, ${SUMS} FROM f GROUP BY agent ORDER BY games DESC`).bind(...c.params),
    db.prepare(`${c.sql} SELECT map, ${SUMS} FROM f GROUP BY map ORDER BY games DESC`).bind(...c.params),
    db.prepare(
      `${c.sql} SELECT j.key AS weapon, SUM(j.value) AS kills, COUNT(DISTINCT f.match_id) AS games
       FROM f, json_each(f.weapons) j GROUP BY j.key ORDER BY kills DESC`,
    ).bind(...c.params),
    db.prepare(`${c.sql} SELECT j.key AS vs, SUM(j.value) AS n FROM f, json_each(f.clutches) j GROUP BY j.key ORDER BY j.key`).bind(...c.params),
    db.prepare(
      `${c.sql} SELECT o.puuid, o.name, o.tag, COUNT(*) AS games, SUM(f.won = 1) AS wins, SUM(f.won = 0) AS losses,
              MAX(o.started_at) AS last_played
       FROM f JOIN player_matches o ON o.match_id = f.match_id AND o.party_id = f.party_id AND o.puuid != f.puuid
       GROUP BY o.puuid ORDER BY games DESC, last_played DESC LIMIT 20`,
    ).bind(...c.params),
    db.prepare(
      `SELECT 'queue' AS kind, queue AS value, MAX(started_at) AS latest, COUNT(*) AS n FROM player_matches WHERE puuid = ?1 GROUP BY queue
       UNION ALL SELECT 'season', season, MAX(started_at), COUNT(*) FROM player_matches WHERE puuid = ?1 GROUP BY season
       UNION ALL SELECT 'agent', agent, MAX(started_at), COUNT(*) FROM player_matches WHERE puuid = ?1 GROUP BY agent
       UNION ALL SELECT 'map', map, MAX(started_at), COUNT(*) FROM player_matches WHERE puuid = ?1 GROUP BY map
       ORDER BY 3 DESC`,
    ).bind(puuid),
  ]);
  return json({
    totals: totals.results[0] ?? null,
    byAgent: byAgent.results,
    byMap: byMap.results,
    weapons: weapons.results,
    clutches: clutches.results,
    teammates: mates.results,
    options: options.results,
  });
}

async function matches(env: Env, q: URLSearchParams) {
  const c = cte(q);
  const limit = Math.max(1, Math.min(500, Number(q.get("limit")) || 50));
  const offset = Math.max(0, Number(q.get("offset")) || 0);
  const { results } = await env.DB.prepare(
    `${c.sql}
     SELECT f.match_id, f.started_at, f.queue, f.map, f.season, f.round_based, f.team, f.agent, f.agent_id, f.tier, f.tier_name,
            f.won, f.rounds, f.rounds_won, f.rounds_lost, f.score, f.kills, f.deaths, f.assists,
            f.headshots, f.bodyshots, f.legshots, f.damage_dealt, f.fk, f.fd, f.kast_rounds,
            f.mk3, f.mk4, f.mk5, f.clutch_wins, m.game_length_ms, h.rr_change, h.rr, h.tier_name AS rank_after
     FROM f JOIN matches m ON m.match_id = f.match_id
     LEFT JOIN mmr_history h ON h.match_id = f.match_id AND h.puuid = f.puuid
     ORDER BY f.started_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...c.params, limit, offset)
    .all();
  return json(results);
}

async function matchDetail(env: Env, id: string) {
  const db = env.DB;
  const [m, p] = await db.batch<any>([
    db.prepare(`SELECT * FROM matches WHERE match_id = ?`).bind(id),
    db.prepare(`SELECT * FROM player_matches WHERE match_id = ? ORDER BY team, score DESC`).bind(id),
  ]);
  const row = m.results[0];
  if (!row) return json({ error: "not found" }, 404);
  return json({
    ...row,
    score: JSON.parse(row.score ?? "{}"),
    detail: JSON.parse(row.detail ?? "null"),
    players: p.results.map((x: any) => ({
      ...x,
      weapons: JSON.parse(x.weapons ?? "{}"),
      clutches: JSON.parse(x.clutches ?? "{}"),
    })),
  });
}

async function mmr(env: Env, q: URLSearchParams) {
  const { results } = await env.DB.prepare(
    `SELECT match_id, date, tier, tier_name, rr, rr_change, elo, map, season FROM mmr_history WHERE puuid = ? ORDER BY date`,
  )
    .bind(q.get("puuid") ?? "")
    .all();
  return json(results);
}

async function status(env: Env) {
  const db = env.DB;
  const [queue, meta, count] = await db.batch<any>([
    db.prepare(`SELECT status, COUNT(*) AS n FROM match_queue GROUP BY status`),
    db.prepare(`SELECT value FROM meta WHERE key = 'last_sync'`),
    db.prepare(`SELECT COUNT(*) AS n FROM matches`),
  ]);
  const by: Record<string, number> = {};
  for (const r of queue.results) by[r.status] = r.n;
  return json({
    pending: by.pending ?? 0,
    done: by.done ?? 0,
    error: by.error ?? 0,
    matches: count.results[0]?.n ?? 0,
    last_sync: Number(meta.results[0]?.value ?? 0),
  });
}

export async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  await ensureSchema(env.DB);
  const path = url.pathname.replace(/^\/api/, "");
  const q = url.searchParams;
  if (req.method === "GET") {
    if (path === "/players") return players(env);
    if (path === "/stats") return stats(env, q);
    if (path === "/matches") return matches(env, q);
    if (path === "/mmr") return mmr(env, q);
    if (path === "/status") return status(env);
    const m = path.match(/^\/match\/([0-9a-f-]{36})$/);
    if (m) return matchDetail(env, m[1]);
  }
  return json({ error: "not found" }, 404);
}

export { json };
