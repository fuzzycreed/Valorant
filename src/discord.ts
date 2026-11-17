// Discord のチーム分け bot。常駐プロセスを持たず、Discord からの HTTP 呼び出し（Interactions）だけで動く。

import { ROLE_LABEL } from "./agents";
import { balance, rerollOptions } from "./balance";
import { ensureSchema, type Env } from "./db";
import { Henrik } from "./henrik";
import { isStale, ratePlayers, refreshRanks, type Link, type Rated } from "./rating";
import { findAccount, recentMaps, saveLink, WEB_PREFIX } from "./roster";
import { tierName } from "./tiers";

const COMMANDS_VERSION = "1";
const MAX_MEMBERS = 10;
const EPHEMERAL = 64;
const COLOR = 0x3987e5;

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
    const key = await crypto.subtle.importKey("raw", hex(publicKey.trim()), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, hex(sig), new TextEncoder().encode(ts + body));
  } catch {
    return false;
  }
}

/** スラッシュコマンドを Discord に登録する。内容が変わったときだけ送る。 */
export async function registerCommands(env: Env): Promise<boolean> {
  // 設定画面で貼り付けたときに前後へ空白や改行が入っていても動くようにする
  const appId = env.DISCORD_APP_ID?.trim(), token = env.DISCORD_BOT_TOKEN?.trim().replace(/^Bot\s+/i, "");
  if (!appId || !token) return false;
  await ensureSchema(env.DB);
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'discord_commands'`).first<{ value: string }>();
  if (row?.value === COMMANDS_VERSION) return false;
  const res = await fetch(`${apiBase(env)}/applications/${appId}/commands`, {
    method: "PUT",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(COMMANDS),
  });
  if (!res.ok) throw new Error(`Discord コマンド登録に失敗: ${res.status} ${(await res.text()).slice(0, 200)}`);
  await env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('discord_commands', ?)`).bind(COMMANDS_VERSION).run();
  return true;
}

/**
 * 設定の状態を返す（ブラウザで /api/discord を開いて確認するためのもの）。
 * 値そのものは返さず、設定されているか・形式が合っているかだけを示す。
 */
export async function discordStatus(env: Env, origin: string): Promise<Response> {
  const key = env.DISCORD_PUBLIC_KEY?.trim() ?? "";
  const appId = env.DISCORD_APP_ID?.trim() ?? "";
  const token = env.DISCORD_BOT_TOKEN?.trim() ?? "";
  const checks: Record<string, string> = {
    DISCORD_PUBLIC_KEY: !key ? "未設定" : /^[0-9a-f]{64}$/i.test(key) ? "OK" : `形式が違います（64文字の英数字のはずが ${key.length} 文字。General Information の Public Key を入れてください）`,
    DISCORD_APP_ID: !appId ? "未設定" : /^\d{17,20}$/.test(appId) ? "OK" : "形式が違います（数字だけのはず。General Information の Application ID を入れてください）",
    DISCORD_BOT_TOKEN: !token ? "未設定" : token.split(".").length === 3 ? "OK" : "形式が違います（Bot タブの Token を入れてください）",
  };
  let commands = "未登録";
  if (appId && token) {
    try {
      await registerCommands(env);
      commands = "登録済み";
    } catch (e) {
      commands = `登録に失敗: ${e instanceof Error ? e.message : String(e)}`;
    }
  } else commands = "未登録（DISCORD_APP_ID と DISCORD_BOT_TOKEN が必要）";
  const ready = checks.DISCORD_PUBLIC_KEY === "OK";
  const page = (data: unknown) =>
    new Response(JSON.stringify(data, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  return page({
    "設定": checks,
    "スラッシュコマンド": commands,
    "Interactions Endpoint URL に入れる値": `${origin}/api/discord`,
    "状態": ready
      ? "このページが表示されていて DISCORD_PUBLIC_KEY が OK なら、Discord 側で URL を保存できるはずです。保存できない場合は Public Key が別のアプリのものでないか確認してください。"
      : "DISCORD_PUBLIC_KEY を Secret として設定し、Deploy を押してからこのページを再読み込みしてください。",
  });
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

/** 最近遊ばれているマップから1つ選ぶ。except と違うものを優先する。 */
async function randomMap(env: Env, except: string | null): Promise<string | null> {
  const all = await recentMaps(env);
  const pool = all.length > 1 ? all.filter((m) => m !== except) : all;
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
}

// ---------- コマンド ----------

async function doLink(env: Env, userId: string, riotId: string): Promise<string> {
  const api = new Henrik(env.HENRIK_API_KEY);
  const found = await findAccount(api, riotId);
  if (!found.ok) {
    if (found.reason === "format") return "Riot ID は `名前#タグ` の形式で入力してください。";
    if (found.reason === "not_found") return `\`${riotId.trim()}\` が見つかりませんでした。綴りを確認してください。`;
    return "API が混み合っています。1分ほど待ってからもう一度試してください。";
  }
  const { link, queued } = await saveLink(env, api, userId, found.account);
  // ウェブから同じアカウントが追加されていた場合は、Discord 側の登録に一本化する
  await env.DB.prepare(`DELETE FROM discord_links WHERE user_id = ?`).bind(WEB_PREFIX + link.puuid).run();
  const rank = link.tier && link.tier >= 3 ? `${tierName(link.tier)} ${link.rr ?? 0}RR` : "ランクなし";
  return (
    `**${md(link.name)}#${md(link.tag)}** を登録しました。現在のランク: ${rank}` +
    (queued ? `\n直近 ${queued} 試合を取り込み待ちに追加しました。成績による補正とロールは、取り込みが進むと反映されます。` : "")
  );
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
