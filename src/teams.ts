// ウェブ版のチーム分け API。Discord を使わずに、サイト上で参加者を選んでチームを分ける。

import { ROLE_LABEL, type Role } from "./agents";
import { balance, rerollOptions, applyPairs, type Pair } from "./balance";
import { ensureSchema, type Env } from "./db";
import { Henrik } from "./henrik";
import { isStale, ratePlayers, refreshRanks, type Link, type Rated } from "./rating";
import { allowLookup, findAccount, recentMaps, saveLink, WEB_PREFIX } from "./roster";

const MAX_TEAM_PLAYERS = 10;
/** ウェブから追加できる人数の上限。 */
const MAX_WEB_PLAYERS = 60;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
const fail = (status: number, error: string) => json({ error }, status);

/** 同じアカウントが Discord とウェブの両方で登録されていたら、Discord 側を残す。 */
function dedupe(links: Link[]): Link[] {
  const by = new Map<string, Link>();
  for (const l of links) {
    const cur = by.get(l.puuid);
    if (!cur || cur.user_id.startsWith(WEB_PREFIX)) by.set(l.puuid, l);
  }
  return [...by.values()];
}

/** 画面に返す形。Discord のユーザーIDは外に出さず、puuid を ID として使う。 */
const view = (r: Rated, link: Link) => ({
  id: r.puuid,
  name: r.name,
  tag: r.tag,
  tier: r.tier,
  rr: r.rr,
  base: r.base,
  current: r.current,
  proven: r.proven,
  basis: r.basis,
  level: r.level,
  rrAdj: r.rrAdj,
  trend: r.trend,
  adj: r.adj,
  rating: r.rating,
  estimated: r.estimated,
  role: r.role,
  samples: r.samples,
  removable: link.user_id.startsWith(WEB_PREFIX),
});

async function allLinks(env: Env): Promise<Link[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM discord_links ORDER BY linked_at`).all<Link>();
  return dedupe(results);
}

async function listPlayers(env: Env) {
  const links = await allLinks(env);
  const rated = await ratePlayers(env, links);
  return json({
    players: rated.map((r, i) => view(r, links[i])).sort((a, b) => a.name.localeCompare(b.name, "ja")),
    maps: await recentMaps(env),
  });
}

async function addPlayer(req: Request, env: Env) {
  const body = (await req.json().catch(() => null)) as { riot_id?: unknown } | null;
  const riotId = typeof body?.riot_id === "string" ? body.riot_id.trim() : "";
  if (!riotId || riotId.length > 60 || !riotId.includes("#")) return fail(400, "Riot ID は「名前#タグ」の形式で入力してください。");

  const links = await allLinks(env);
  // fresh: 外部 API を呼んで新しく登録したか。画面側がまとめて追加するときの間隔調整に使う
  const respond = async (link: Link, fresh = false) => json({ player: view((await ratePlayers(env, [link]))[0], link), fresh });

  // すでに登録済みなら API を呼ばずに返す
  const known = links.find((l) => `${l.name}#${l.tag}`.toLowerCase() === riotId.toLowerCase());
  if (known) return respond(known);

  if (links.filter((l) => l.user_id.startsWith(WEB_PREFIX)).length >= MAX_WEB_PLAYERS) {
    return fail(400, `ウェブから追加できるのは ${MAX_WEB_PLAYERS} 人までです。使わない人を削除してください。`);
  }
  if (!(await allowLookup(env))) return fail(429, "検索の回数が多すぎます。10分ほど待ってからもう一度試してください。");

  const api = new Henrik(env.HENRIK_API_KEY);
  const found = await findAccount(api, riotId);
  if (!found.ok) {
    if (found.reason === "format") return fail(400, "Riot ID は「名前#タグ」の形式で入力してください。");
    if (found.reason === "not_found") return fail(404, `「${riotId}」が見つかりませんでした。綴りを確認してください。`);
    return fail(429, "API が混み合っています。1分ほど待ってからもう一度試してください。");
  }
  // Riot ID を変更した人など、同じアカウントが別名で登録済みの場合
  const same = links.find((l) => l.puuid === found.account.puuid);
  if (same) {
    await refreshRanks(env, api, [same]);
    return respond(same, true);
  }
  const { link } = await saveLink(env, api, WEB_PREFIX + found.account.puuid, found.account);
  return respond(link, true);
}

async function removePlayer(env: Env, puuid: string) {
  // Discord の /link で登録された人はここからは消せない（本人が /unlink する）
  const res = await env.DB.prepare(`DELETE FROM discord_links WHERE user_id = ?`).bind(WEB_PREFIX + puuid).run();
  return res.meta.changes ? json({ ok: true }) : fail(404, "ウェブから追加したプレイヤーではないか、すでに削除されています。");
}

const ROLES = new Set(Object.keys(ROLE_LABEL));
const MAX_PAIRS = 20;

async function split(req: Request, env: Env) {
  const body = (await req.json().catch(() => null)) as { ids?: unknown; guests?: unknown; pairs?: unknown } | null;
  const ids = Array.isArray(body?.ids) ? [...new Set(body!.ids.filter((x): x is string => typeof x === "string"))] : [];
  const guestsIn = Array.isArray(body?.guests) ? (body!.guests as any[]) : [];
  if (ids.length + guestsIn.length < 2) return fail(400, "チーム分けには2人以上が必要です。");
  if (ids.length + guestsIn.length > MAX_TEAM_PLAYERS) return fail(400, `一度に分けられるのは ${MAX_TEAM_PLAYERS} 人までです。`);

  const { results } = ids.length
    ? await env.DB.prepare(`SELECT * FROM discord_links WHERE puuid IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all<Link>()
    : { results: [] as Link[] };
  const links = dedupe(results);
  if (links.length !== ids.length) return fail(400, "登録されていないプレイヤーが含まれています。ページを読み込み直してください。");

  const stale = links.filter((l) => isStale(l));
  if (stale.length) {
    // ランクの取り直しに失敗しても、手元の値で分ける
    await refreshRanks(env, new Henrik(env.HENRIK_API_KEY), stale).catch((e) => console.warn("rank refresh failed", e));
  }
  const rated = await ratePlayers(env, links);
  const players = rated.map((r, i) => view(r, links[i]));

  // ゲスト: Riot ID を使わず、名前とランクを手入力した人
  const guests = guestsIn.map((g, n) => {
    const tier = Math.max(3, Math.min(27, Math.round(Number(g?.tier)) || 12));
    const role = typeof g?.role === "string" && ROLES.has(g.role) ? (g.role as Role) : null;
    const rating = (tier - 3) * 100 + 50;
    return {
      id: `guest:${n}`, name: String(g?.name ?? "").trim().slice(0, 24) || `ゲスト${n + 1}`, tag: "",
      tier, rr: null, base: rating, current: rating, proven: null, basis: "rank", level: null, rrAdj: 0, trend: null, adj: 0, rating, estimated: false, role, samples: 0, removable: false, guest: true,
    };
  });

  const everyone = [...players, ...guests];
  // ペアの指定（同じチームに / 別のチームに）。id は登録者の puuid か、ゲストの guest:<番号>
  const pairs: Pair[] = (Array.isArray(body?.pairs) ? (body!.pairs as any[]) : [])
    .filter((p) => typeof p?.a === "string" && typeof p?.b === "string" && (p.mode === "together" || p.mode === "apart"))
    .slice(0, MAX_PAIRS)
    .map((p) => ({ a: p.a, b: p.b, mode: p.mode }));
  const filtered = applyPairs(balance(everyone.map((p) => ({ id: p.id, rating: p.rating, role: p.role }))), pairs);
  const options = rerollOptions(filtered.splits);
  return json({
    players: everyone,
    // 指定をすべて満たす分け方が無かった場合は false（指定なしで分けている）
    pairsSatisfied: filtered.satisfied,
    options: options.map((o) => ({ a: o.a, b: o.b, diff: Math.round(o.diff), sumDiff: Math.round(o.sumDiff) })),
    maps: await recentMaps(env),
  });
}

export async function handleTeams(req: Request, env: Env, path: string): Promise<Response> {
  await ensureSchema(env.DB);
  if (path === "/team/players" && req.method === "GET") return listPlayers(env);
  if (path === "/team/players" && req.method === "POST") return addPlayer(req, env);
  if (path === "/team/split" && req.method === "POST") return split(req, env);
  const m = path.match(/^\/team\/players\/([0-9a-f-]{36})$/);
  if (m && req.method === "DELETE") return removePlayer(env, m[1]);
  return fail(404, "not found");
}
