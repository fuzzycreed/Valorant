// ローカル開発用: 本物の HenrikDev API から取得して、wrangler dev が使うローカル D1 に取り込む。
//   HENRIK_API_KEY=HDEV-xxxx npm run sync:local
// プロキシ環境では NODE_USE_ENV_PROXY=1 を付ける。
// 集計の定義を変えたあとは `npm run sync:local -- --recompute` で保存済みの生データから作り直せる。
import { getPlatformProxy } from "wrangler";
import type { Env } from "../src/db";
import { recomputeAll, syncStep } from "../src/sync";

const { env, dispose } = await getPlatformProxy<Env>();
const full: Env = { ...env, HENRIK_API_KEY: process.env.HENRIK_API_KEY ?? env.HENRIK_API_KEY };

try {
  if (process.argv.includes("--recompute")) {
    console.log(`${await recomputeAll(full)} 試合を再集計しました`);
    process.exit(0);
  }
  for (let i = 0; i < 200; i++) {
    const r = await syncStep(full, { maxMatches: 5, forceDiscover: i === 0 });
    console.log(`step ${i + 1}: +${r.processed} 取り込み / 残り ${r.pending} / 失敗 ${r.failed}`, r.errors.join("; "));
    if (r.rateLimited) {
      console.log("レート制限。60秒待機…");
      await new Promise((res) => setTimeout(res, 60_000));
      continue;
    }
    if (r.pending === 0 || (r.processed === 0 && r.failed === 0)) break;
    // 無料キーは 30 リクエスト/分
    await new Promise((res) => setTimeout(res, 11_000));
  }
} finally {
  await dispose();
}
