// Discord のチーム分け bot。常駐プロセスを持たず、Discord からの HTTP 呼び出し（Interactions）だけで動く。

import { ROLE_LABEL } from "./agents";
import { balance, rerollOptions } from "./balance";
import { ensureSchema, type Env } from "./db";
import { Henrik, HenrikError } from "./henrik";
import { isStale, ratePlayers, refreshRanks, type Link, type Rated } from "./rating";
import { tierName } from "./tiers";

const COMMANDS_VERSION = "1";
const MAX_MEMBERS = 10;
const EPHEMERAL = 64;
const COLOR = 0x3987e5;
const MAP_WINDOW_MS = 45 * 24 * 60 * 60 * 1000;
/** /link 時に取り込み待ちへ積む直近の試合数。 */
const LINK_BACKFILL = 10;
export const LINKED_QUEUES = new Set(["competitive", "unrated", "premier"]);

const COMMANDS = [
  {
    name: "link",
    description: "自分の Riot ID を登録する（チーム分けに参加するために必要）",
    options: [{ type: 3, name: "riot_id", description: "Riot ID（例: name#tag）", required: true }],
  },
  { name: "unlink", description: "Riot ID の登録を解除する" },
  { name: "rating", description: "チーム分けに使われる自分のレートを確認する" },
  { name: "custom", description: "カスタムの参加者を募集して、釣り合うようにチーム分けする" },
].map((c) => ({ ...c, type: 1, integration_types: [0], contexts: [0] }));

interface Lobby {
  lobby_id: string;
  host_id: string;
  state: string;
  variant: number;
  map: string | null;
  flip: number;
}

const apiBase = (env: Env) => env.DISCORD_API_BASE || "https://discord.com/api/v10";
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const message = (data: object) => json({ type: 4, data: { allowed_mentions: { parse: [] }, ...data } });
const ephemeral = (content: string) => message({ content, flags: EPHEMERAL });
const update = (data: object) => json({ type: 7, data: { allowed_mentions: { parse: [] }, ...data } });

function hex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Discord が付ける Ed25519 署名を検証する。検証に通らないリクエストは処理しない。 */
async function verify(req: Request, body: string, publicKey: string): Promise<boolean> {
  const sig = req.headers.get("X-Signature-Ed25519");
  const ts = req.headers.get("X-Signature-Timestamp");
  if (!sig || !ts || !/^[0-9a-f]{128}$/i.test(sig)) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hex(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, hex(sig), new TextEncoder().encode(ts + body));
  } catch {
    return false;
  }
}

/** スラッシュコマンドを Discord に登録する。内容が変わったときだけ送る。 */
export async function registerCommands(env: Env): Promise<boolean> {
  if (!env.DISCORD_APP_ID || !env.DISCORD_BOT_TOKEN) return false;
  await ensureSchema(env.DB);
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'discord_commands'`).first<{ value: string }>();
  if (row?.value === COMMANDS_VERSION) return false;
  const res = await fetch(`${apiBase(env)}/applications/${env.DISCORD_APP_ID}/commands`, {
    method: "PUT",
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(COMMANDS),
  });
  if (!res.ok) throw new Error(`Discord コマンド登録に失敗: ${res.status} ${(await res.text()).slice(0, 200)}`);
  await env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('discord_commands', ?)`).bind(COMMANDS_VERSION).run();
  return true;
}

/** 応答を保留にしたあと、元のメッセージを書き換える。 */
async function editOriginal(env: Env, i: any, data: object): Promise<void> {
  const res = await fetch(`${apiBase(env)}/webhooks/${i.application_id}/${i.token}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ allowed_mentions: { parse: [] }, ...data }),
  });
  if (!res.ok) console.error("discord edit failed", res.status, (await res.text()).slice(0, 200));
}

// ---------- 表示 ----------

/** プレイヤー名に含まれる記号が Discord の装飾として解釈されないようにする。 */
const md = (s: string) => s.replace(/([\\*_`~|>\[\]])/g, "\\$1");
const rankText = (r: Rated) =>
  r.tier == null ? "ランクなし（仮レート）" : r.estimated ? `${tierName(r.tier)}（過去）` : `${tierName(r.tier)} ${r.rr ?? 0}RR`;
const playerLine = (r: Rated) =>
  `<@${r.userId}> **${md(r.name)}#${md(r.tag)}** ・ ${rankText(r)} ・ ${r.role ? ROLE_LABEL[r.role] : "ロール不明"} ・ レート ${r.rating}`;
const button = (label: string, id: string, style: number, disabled = false) => ({ type: 2, label, custom_id: id, style, disabled });

function lobbyMessage(lobby: Lobby, rated: Rated[]) {
  const lines = rated.map((r, n) => `${n + 1}. ${playerLine(r)}`);
  return {
    content: "",
    embeds: [
      {
        title: `カスタム募集（${rated.length}/${MAX_MEMBERS}）`,
        color: COLOR,
        description: lines.join("\n") || "まだ参加者がいません。",
        footer: { text: "/link で Riot ID を登録すると参加できます ・ 2人以上でチーム分け" },
      },
    ],
    components: [
      {
        type: 1,
        components: [
          button("参加", `lobby:join:${lobby.lobby_id}`, 1, rated.length >= MAX_MEMBERS),
          button("抜ける", `lobby:leave:${lobby.lobby_id}`, 2),
          button("チーム分け", `lobby:split:${lobby.lobby_id}`, 3, rated.length < 2),
        ],
      },
    ],
  };
}

function splitMessage(lobby: Lobby, rated: Rated[]) {
  const options = rerollOptions(balance(rated.map((r) => ({ id: r.userId, rating: r.rating, role: r.role }))));
  const index = lobby.variant % options.length;
  const s = options[index];
  const byId = new Map(rated.map((r) => [r.userId, r]));
  const [atk, def] = lobby.flip ? [s.b, s.a] : [s.a, s.b];
  const team = (ids: string[]) => {
    const members = ids.map((id) => byId.get(id)!).sort((x, y) => y.rating - x.rating);
    const avg = Math.round(members.reduce((a, r) => a + r.rating, 0) / members.length);
    return { avg, value: members.map(playerLine).join("\n") };
  };
  const a = team(atk), d = team(def);
  return {
    content: "",
    embeds: [
      {
        title: `チーム分け（案 ${index + 1}/${options.length}）`,
        color: COLOR,
        description:
          (lobby.map ? `マップ: **${lobby.map}**\n` : "") +
          (atk.length === def.length
            ? `平均レートの差: **${Math.round(s.diff)}**`
            : `人数が違うので、合計レートが釣り合うように分けています（合計の差: **${Math.round(s.sumDiff)}**）`),
        fields: [
          { name: `アタッカー側 ・ 平均 ${a.avg}`, value: a.value },
          { name: `ディフェンダー側 ・ 平均 ${d.avg}`, value: d.value },
        ],
        footer: { text: "レート = ランク（100RRで1段階）＋ 直近の成績による補正（最大±150）" },
      },
    ],
    components: [
      {
        type: 1,
        components: [
          button("振り直し", `lobby:reroll:${lobby.lobby_id}`, 1, options.length < 2),
          button("マップ変更", `lobby:remap:${lobby.lobby_id}`, 2, !lobby.map),
          button("募集に戻る", `lobby:reopen:${lobby.lobby_id}`, 2),
        ],
      },
    ],
  };
}

// ---------- データ ----------

async function lobbyLinks(env: Env, lobbyId: string): Promise<Link[]> {
  const { results } = await env.DB.prepare(
    `SELECT l.* FROM lobby_members m JOIN discord_links l ON l.user_id = m.user_id WHERE m.lobby_id = ? ORDER BY m.joined_at`,
  )
    .bind(lobbyId)
    .all<Link>();
  return results;
}

/** 追跡中のプレイヤーが最近コンペで遊んだマップから1つ選ぶ（現行のマッププールの近似）。 */
async function randomMap(env: Env, except: string | null): Promise<string | null> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT map FROM matches WHERE queue = 'competitive' AND started_at > ? AND map != ''`,
  )
    .bind(Date.now() - MAP_WINDOW_MS)
    .all<{ map: string }>();
  const pool = results.map((r) => r.map).filter((m) => m !== except || results.length === 1);
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
}

// ---------- コマンド ----------

async function doLink(env: Env, userId: string, riotId: string): Promise<string> {
  const at = riotId.lastIndexOf("#");
  const name = riotId.slice(0, at).trim(), tag = riotId.slice(at + 1).trim();
  if (at < 1 || !name || !tag) return "Riot ID は `名前#タグ` の形式で入力してください。";
  const api = new Henrik(env.HENRIK_API_KEY);
  let acc: any;
  try {
    acc = (await api.account(name, tag)).data;
  } catch (e) {
    if (e instanceof HenrikError && e.status === 404) return `\`${name}#${tag}\` が見つかりませんでした。綴りを確認してください。`;
    if (e instanceof HenrikError && e.status === 429) return "API が混み合っています。1分ほど待ってからもう一度試してください。";
    throw e;
  }
  const link: Link = {
    user_id: userId, puuid: acc.puuid, name: acc.name, tag: acc.tag,
    region: acc.region ?? env.REGION, platform: env.PLATFORM, tier: null, rr: null, elo: null, rank_updated_at: 0,
  };
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO discord_links (user_id, puuid, name, tag, region, platform, linked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET puuid = excluded.puuid, name = excluded.name, tag = excluded.tag,
       region = excluded.region, platform = excluded.platform, tier = NULL, rr = NULL, elo = NULL,
       rank_updated_at = 0, discovered_at = 0, linked_at = excluded.linked_at`,
  )
    .bind(userId, link.puuid, link.name, link.tag, link.region, link.platform, now)
    .run();
  await refreshRanks(env, api, [link]);
  let queued = 0;
  try {
    queued = await queueRecentMatches(env, api, link);
  } catch (e) {
    if (!(e instanceof HenrikError)) throw e;
  }
  const rank = link.tier && link.tier >= 3 ? `${tierName(link.tier)} ${link.rr ?? 0}RR` : "ランクなし";
  return (
    `**${md(link.name)}#${md(link.tag)}** を登録しました。現在のランク: ${rank}` +
    (queued ? `\n直近 ${queued} 試合を取り込み待ちに追加しました。成績による補正とロールは、取り込みが進むと反映されます。` : "")
  );
}

/** 直近の試合IDを取り込み待ちに積み、次回の確認時刻を更新する。 */
export async function queueRecentMatches(env: Env, api: Henrik, link: Pick<Link, "user_id" | "puuid" | "region">): Promise<number> {
  const h = (await api.matchHistory(link.region, link.puuid, 0, 20)).data;
  const found = ((h?.History ?? []) as any[])
    .filter((e) => LINKED_QUEUES.has(e.QueueID))
    .slice(0, LINK_BACKFILL)
    .map((e) => ({ id: e.MatchID, t: e.GameStartTime ?? 0, q: e.QueueID }));
  const now = Date.now();
  const res = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO match_queue (match_id, region, started_at, queue, updated_at)
       SELECT json_extract(value, '$.id'), ?1, json_extract(value, '$.t'), json_extract(value, '$.q'), ?2 FROM json_each(?3)`,
    ).bind(link.region, now, JSON.stringify(found)),
    env.DB.prepare(`UPDATE discord_links SET discovered_at = ? WHERE user_id = ?`).bind(now, link.user_id),
  ]);
  return res[0]?.meta?.changes ?? 0;
}

async function ratingText(env: Env, userId: string): Promise<string> {
  const link = await env.DB.prepare(`SELECT * FROM discord_links WHERE user_id = ?`).bind(userId).first<Link>();
  if (!link) return "まだ Riot ID が登録されていません。`/link` で登録してください。";
  const [r] = await ratePlayers(env, [link]);
  return [
    `**${md(r.name)}#${md(r.tag)}** のレート: **${r.rating}**`,
    `・ランク由来: ${r.base}（${rankText(r)}${r.estimated && r.tier == null ? "、参加者の平均で仮置き" : ""}）`,
    `・直近の成績による補正: ${r.adj >= 0 ? "+" : ""}${r.adj}（取り込み済みの直近 ${r.samples} 試合。各試合の10人の平均 ACS と比べた値）`,
    `・よく使うロール: ${r.role ? ROLE_LABEL[r.role] : "不明（取り込み済みの試合がまだ無い）"}`,
  ].join("\n");
}

async function command(env: Env, ctx: ExecutionContext, i: any, userId: string): Promise<Response> {
  const name = i.data?.name;
  if (name === "link") {
    const riotId = String(i.data.options?.find((o: any) => o.name === "riot_id")?.value ?? "");
    // 外部 API を呼ぶので 3 秒の応答期限に間に合わない。いったん保留にして、あとから書き換える。
    ctx.waitUntil(
      doLink(env, userId, riotId)
        .catch((e) => {
          console.error(e);
          return "登録中にエラーが発生しました。少し待ってからもう一度試してください。";
        })
        .then((content) => editOriginal(env, i, { content })),
    );
    return json({ type: 5, data: { flags: EPHEMERAL } });
  }
  if (name === "unlink") {
    const res = await env.DB.batch([
      env.DB.prepare(`DELETE FROM discord_links WHERE user_id = ?`).bind(userId),
      env.DB.prepare(`DELETE FROM lobby_members WHERE user_id = ?`).bind(userId),
    ]);
    return ephemeral(res[0].meta.changes ? "Riot ID の登録を解除しました。" : "登録されている Riot ID はありません。");
  }
  if (name === "rating") return ephemeral(await ratingText(env, userId));
  if (name === "custom") {
    const lobby: Lobby = { lobby_id: i.id, host_id: userId, state: "open", variant: 0, map: null, flip: 0 };
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO lobbies (lobby_id, guild_id, channel_id, host_id, created_at) VALUES (?, ?, ?, ?, ?)`).bind(
        lobby.lobby_id, i.guild_id ?? null, i.channel_id ?? i.channel?.id ?? null, userId, now,
      ),
      // 募集した本人は、登録済みなら最初から参加者に入れる
      env.DB.prepare(
        `INSERT OR IGNORE INTO lobby_members (lobby_id, user_id, joined_at) SELECT ?1, user_id, ?3 FROM discord_links WHERE user_id = ?2`,
      ).bind(lobby.lobby_id, userId, now),
    ]);
    return message(lobbyMessage(lobby, await ratePlayers(env, await lobbyLinks(env, lobby.lobby_id))));
  }
  return ephemeral("不明なコマンドです。");
}

// ---------- ボタン ----------

async function component(env: Env, ctx: ExecutionContext, i: any, userId: string): Promise<Response> {
  const [scope, action, lobbyId] = String(i.data?.custom_id ?? "").split(":");
  if (scope !== "lobby" || !lobbyId) return ephemeral("不明な操作です。");
  const db = env.DB;
  const lobby = await db.prepare(`SELECT * FROM lobbies WHERE lobby_id = ?`).bind(lobbyId).first<Lobby>();
  if (!lobby) return ephemeral("この募集は見つかりませんでした。`/custom` で作り直してください。");
  const now = Date.now();

  if (action === "join") {
    if (lobby.state !== "open") return ephemeral("すでにチーム分け済みです。「募集に戻る」を押してから参加してください。");
    const linked = await db.prepare(`SELECT 1 FROM discord_links WHERE user_id = ?`).bind(userId).first();
    if (!linked) return ephemeral("先に `/link` で Riot ID を登録してください（例: `/link riot_id:name#tag`）。");
    const count = await db.prepare(`SELECT COUNT(*) AS n FROM lobby_members WHERE lobby_id = ?`).bind(lobbyId).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_MEMBERS) return ephemeral(`満員です（${MAX_MEMBERS}人）。`);
    await db.prepare(`INSERT OR IGNORE INTO lobby_members (lobby_id, user_id, joined_at) VALUES (?, ?, ?)`).bind(lobbyId, userId, now).run();
    return update(lobbyMessage(lobby, await ratePlayers(env, await lobbyLinks(env, lobbyId))));
  }
  if (action === "leave") {
    if (lobby.state !== "open") return ephemeral("チーム分け済みです。「募集に戻る」を押してから抜けてください。");
    await db.prepare(`DELETE FROM lobby_members WHERE lobby_id = ? AND user_id = ?`).bind(lobbyId, userId).run();
    return update(lobbyMessage(lobby, await ratePlayers(env, await lobbyLinks(env, lobbyId))));
  }

  const links = await lobbyLinks(env, lobbyId);
  if (userId !== lobby.host_id && !links.some((l) => l.user_id === userId)) {
    return ephemeral("この操作は募集した人か参加者だけができます。");
  }
  if (action === "reopen") {
    await db.prepare(`UPDATE lobbies SET state = 'open' WHERE lobby_id = ?`).bind(lobbyId).run();
    return update(lobbyMessage({ ...lobby, state: "open" }, await ratePlayers(env, links)));
  }
  if (action === "split" || action === "reroll" || action === "remap") {
    if (links.length < 2) return ephemeral("チーム分けには2人以上の参加者が必要です。");
    if (action === "split") {
      lobby.state = "split";
      lobby.variant = 0;
      lobby.flip = Math.random() < 0.5 ? 1 : 0;
      lobby.map = await randomMap(env, null);
    } else if (action === "reroll") {
      if (lobby.state !== "split") return ephemeral("先に「チーム分け」を押してください。");
      lobby.variant++;
    } else {
      lobby.map = await randomMap(env, lobby.map);
    }
    await db.prepare(`UPDATE lobbies SET state = ?, variant = ?, flip = ?, map = ? WHERE lobby_id = ?`)
      .bind(lobby.state, lobby.variant, lobby.flip, lobby.map, lobbyId)
      .run();

    const stale = links.filter((l) => isStale(l, now));
    if (!stale.length) return update(splitMessage(lobby, await ratePlayers(env, links)));
    // ランクが古い人がいる場合は取り直す。時間がかかるので応答を保留にしてから書き換える。
    ctx.waitUntil(
      (async () => {
        await refreshRanks(env, new Henrik(env.HENRIK_API_KEY), stale);
        await editOriginal(env, i, splitMessage(lobby, await ratePlayers(env, links)));
      })().catch((e) => console.error(e)),
    );
    return json({ type: 6 });
  }
  return ephemeral("不明な操作です。");
}

export async function handleDiscord(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.DISCORD_PUBLIC_KEY) return json({ error: "Discord 連携は設定されていません" }, 404);
  const body = await req.text();
  if (!(await verify(req, body, env.DISCORD_PUBLIC_KEY))) return new Response("invalid request signature", { status: 401 });
  const i = JSON.parse(body);
  if (i.type === 1) {
    // Discord が URL を確認するときの疎通確認。ついでにコマンドを登録しておく。
    ctx.waitUntil(registerCommands(env).catch((e) => console.error(e)));
    return json({ type: 1 });
  }
  await ensureSchema(env.DB);
  const userId: string | undefined = i.member?.user?.id ?? i.user?.id;
  if (!userId) return ephemeral("ユーザーを特定できませんでした。");
  try {
    if (i.type === 2) return await command(env, ctx, i, userId);
    if (i.type === 3) return await component(env, ctx, i, userId);
  } catch (e) {
    console.error(e);
    return ephemeral("エラーが発生しました。少し待ってからもう一度試してください。");
  }
  return ephemeral("未対応の操作です。");
}
