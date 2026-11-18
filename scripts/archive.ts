// 分析用の保管庫（R2）とローカル D1 のあいだでデータをやり取りする。
//   ARCHIVE_TOKEN=xxxx npm run archive -- pull [控えの保存先ディレクトリ]   本番の保管庫 → ローカル D1（wrangler dev が使うもの）
//   ARCHIVE_TOKEN=xxxx npm run archive -- push                              ローカルにだけある試合 → 保管庫の crawl/ 以下
// 接続先は ARCHIVE_URL（既定は https://valorant.just404.com）。プロキシ環境では NODE_USE_ENV_PROXY=1 を付ける。
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { getPlatformProxy } from "wrangler";
import { ensureSchema, type Env } from "../src/db";

export type Call = (path: string, init?: RequestInit) => Promise<Response>;
type Row = Record<string, unknown>;
interface MatchFile { format: number; match: Row; players: Row[] }

const BATCH = 25;
const PUSH_PER_FILE = 20;

async function ok(res: Response): Promise<Response> {
  if (!res.ok) throw new Error(`保管庫 API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

async function listKeys(call: Call, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  for (let cursor: string | null = ""; cursor !== null; ) {
    const r = (await (await ok(await call(`list?prefix=${encodeURIComponent(prefix)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`))).json()) as {
      objects: { key: string }[]; cursor: string | null;
    };
    keys.push(...r.objects.map((o) => o.key));
    cursor = r.cursor;
  }
  return keys;
}

async function columns(db: D1Database, table: string): Promise<Set<string>> {
  return new Set((await db.prepare(`SELECT name FROM pragma_table_info(?)`).bind(table).all<{ name: string }>()).results.map((r) => r.name));
}

/** 取り出した試合をローカル D1 に入れる（列はテーブルに存在するものだけ使う）。 */
async function store(db: D1Database, files: MatchFile[], mCols: Set<string>, pCols: Set<string>): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  const insert = (table: string, row: Row, cols: Set<string>) => {
    const keys = Object.keys(row).filter((k) => cols.has(k));
    stmts.push(db.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).bind(...keys.map((k) => row[k] ?? null)));
  };
  for (const f of files) {
    insert("matches", { ...f.match, archived: 1 }, mCols);
    for (const p of f.players) insert("player_matches", p, pCols);
  }
  for (let i = 0; i < stmts.length; i += 80) await db.batch(stmts.slice(i, i + 80));
}

/** 保管庫にある試合のうち、ローカルに無いものを取り込む。people/ の控えは dir に保存する。 */
export async function pull(db: D1Database, call: Call, dir?: string): Promise<{ matches: number; people: number }> {
  const have = new Set((await db.prepare(`SELECT match_id FROM matches`).all<{ match_id: string }>()).results.map((r) => r.match_id));
  const [mCols, pCols] = [await columns(db, "matches"), await columns(db, "player_matches")];
  const idOf = (key: string) => key.replace(/^.*\//, "").replace(/\.json$/, "");
  let matches = 0;
  const single = (await listKeys(call, "matches/")).filter((k) => !have.has(idOf(k)));
  const packed = await listKeys(call, "crawl/");
  for (let i = 0; i < single.length; i += BATCH) {
    const text = await (await ok(await call("batch", { method: "POST", body: JSON.stringify({ keys: single.slice(i, i + BATCH) }) }))).text();
    const files = text.split("\n").filter(Boolean).map((l) => JSON.parse(l).body as MatchFile | null).filter((f): f is MatchFile => !!f);
    await store(db, files, mCols, pCols);
    matches += files.length;
  }
  for (const key of packed) {
    const body = (await (await ok(await call(`get?key=${encodeURIComponent(key)}`))).json()) as MatchFile | MatchFile[];
    const files = (Array.isArray(body) ? body : [body]).filter((f) => f?.match && !have.has(f.match.match_id as string));
    await store(db, files, mCols, pCols);
    matches += files.length;
  }
  let people = 0;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    for (const key of await listKeys(call, "people/")) {
      writeFileSync(`${dir}/${idOf(key)}.json`, await (await ok(await call(`get?key=${encodeURIComponent(key)}`))).text());
      people++;
    }
  }
  return { matches, people };
}

/** ローカルにあって保管庫に無い試合を、crawl/ 以下にまとめて置く。 */
export async function push(db: D1Database, call: Call): Promise<number> {
  const remote = new Set((await listKeys(call, "matches/")).map((k) => k.replace(/^.*\//, "").replace(/\.json$/, "")));
  for (const key of await listKeys(call, "crawl/")) {
    const body = (await (await ok(await call(`get?key=${encodeURIComponent(key)}`))).json()) as MatchFile | MatchFile[];
    for (const f of Array.isArray(body) ? body : [body]) remote.add(f.match.match_id as string);
  }
  const ids = (await db.prepare(`SELECT match_id FROM matches ORDER BY match_id`).all<{ match_id: string }>()).results.map((r) => r.match_id).filter((id) => !remote.has(id));
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  for (let i = 0; i < ids.length; i += PUSH_PER_FILE) {
    const part = JSON.stringify(ids.slice(i, i + PUSH_PER_FILE));
    const [ms, ps] = await db.batch<Row>([
      db.prepare(`SELECT * FROM matches WHERE match_id IN (SELECT value FROM json_each(?))`).bind(part),
      db.prepare(`SELECT * FROM player_matches WHERE match_id IN (SELECT value FROM json_each(?))`).bind(part),
    ]);
    const files = ms.results.map(({ archived: _a, ...match }) => ({ format: 1, match, players: ps.results.filter((p) => p.match_id === match.match_id) }));
    await ok(await call(`put?key=crawl/${stamp}-${String(i / PUSH_PER_FILE).padStart(4, "0")}.json`, { method: "PUT", body: JSON.stringify(files) }));
  }
  return ids.length;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const base = (process.env.ARCHIVE_URL ?? "https://valorant.just404.com").replace(/\/$/, "");
  const token = process.env.ARCHIVE_TOKEN ?? "proxy-injected";
  const call: Call = (path, init) => fetch(`${base}/api/archive/${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  const { env, dispose } = await getPlatformProxy<Env>();
  try {
    await ensureSchema(env.DB);
    const [cmd, dir] = process.argv.slice(2);
    if (cmd === "pull") console.log("取り込み:", JSON.stringify(await pull(env.DB, call, dir)));
    else if (cmd === "push") console.log(`${await push(env.DB, call)} 試合を保管庫に置きました`);
    else console.log("使い方: npm run archive -- pull [控えの保存先] | push");
  } finally {
    await dispose();
  }
}
