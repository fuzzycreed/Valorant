import { handleApi, json } from "./api";
import { handleArchive } from "./archive";
import type { Env } from "./db";
import { discordStatus, handleDiscord, registerCommands } from "./discord";
import { boostPending, boostStep, syncStep, type SyncResult } from "./sync";
import { handleTeams } from "./teams";

/** 急ぎの取り込みを、1回の定期実行で何回まで回すか（1回2試合。API の 1分30回の制限に収める）。 */
const BOOST_CALLS_PER_TICK = 13;
/** 通常の同期（新着の検出など）を回す間隔（分）。定期実行そのものは毎分動く。 */
const SYNC_EVERY_MIN = 5;

/**
 * 毎分の定期実行。チーム分けに登録した人の試合が取り込み待ちに残っていれば、それを最優先で一気に取り込む。
 * 取り込みは1回ごとに自分自身を呼び直し、別の実行として処理する（1回の実行で使える CPU 時間が短いため）。
 * 残っていなければ、5分に1回だけ通常の同期を回す。
 */
async function tick(env: Env, scheduledTime: number): Promise<void> {
  let pending = await boostPending(env);
  if (pending > 0) {
    let processed = 0, limited = false;
    // 自分自身を呼べない環境（ローカルなど）では、この実行の中で1回だけ進める
    const calls = env.SELF ? BOOST_CALLS_PER_TICK : 1;
    for (let i = 0; i < calls && pending > 0 && !limited; i++) {
      const r: SyncResult = env.SELF
        ? await (await env.SELF.fetch("https://self/api/sync/boost", { method: "POST" })).json()
        : await boostStep(env);
      processed += r.processed;
      pending = r.pending;
      limited = r.rateLimited;
      if (!r.processed && !r.failed) break;
    }
    console.log("boost", JSON.stringify({ processed, pending, limited }));
    // 進んだか、API の制限で止まっただけなら、この回は急ぎの取り込みだけにする
    if (processed > 0 || limited) return;
  }
  if (new Date(scheduledTime).getUTCMinutes() % SYNC_EVERY_MIN !== 0) return;
  console.log("sync", JSON.stringify(await syncStep(env, { maxMatches: 2 })));
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      if (url.pathname === "/api/discord" && req.method === "POST") return await handleDiscord(req, env, ctx);
      if (url.pathname === "/api/discord" && req.method === "GET") return await discordStatus(env, url.origin);
      if (url.pathname.startsWith("/api/archive/")) return await handleArchive(req, env, url);
      if (url.pathname.startsWith("/api/team/")) return await handleTeams(req, env, url.pathname.slice(4));
      if (url.pathname === "/api/sync/boost" && req.method === "POST") return json(await boostStep(env));
      if (url.pathname === "/api/sync" && req.method === "POST") {
        // 画面の「更新」ボタン用。新着検出は内部で5分に1回までに抑えられている。
        const focus = url.searchParams.get("puuid") ?? undefined;
        return json(await syncStep(env, { maxMatches: 2, focus }));
      }
      return await handleApi(req, env, url);
    } catch (e) {
      console.error(e);
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      registerCommands(env).then(
        (done) => done && console.log("discord commands registered"),
        (e) => console.error("discord command registration failed", e),
      ),
    );
    ctx.waitUntil(tick(env, event.scheduledTime).catch((e) => console.error("sync failed", e)));
  },
} satisfies ExportedHandler<Env>;
