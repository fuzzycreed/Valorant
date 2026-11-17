import { handleApi, json } from "./api";
import type { Env } from "./db";
import { syncStep } from "./sync";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      if (url.pathname === "/api/sync" && req.method === "POST") {
        // 画面の「更新」ボタン用。新着検出は内部で5分に1回までに抑えられている。
        return json(await syncStep(env, { maxMatches: 2 }));
      }
      return await handleApi(req, env, url);
    } catch (e) {
      console.error(e);
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      syncStep(env, { maxMatches: 2 }).then(
        (r) => console.log("sync", JSON.stringify(r)),
        (e) => console.error("sync failed", e),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
