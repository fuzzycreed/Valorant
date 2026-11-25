// D1 の読み書き行数を、処理の種類ごとに記録する。
// D1 は読んだ行数に1日の上限があるので、「何がどれだけ読んでいるか」を推測でなく実測で追えるようにしておく。
// 記録は usage_log テーブルに、日付 × 処理 ×（重かった）SQL ごとに足し込む。

export interface Meter {
  reads: number;
  writes: number;
  /** SQL の先頭部分ごとの内訳 */
  bySql: Map<string, { reads: number; writes: number; calls: number }>;
}

/** これ未満の軽い呼び出しは、10回に1回だけ記録する（記録そのものが書き込みを使うため）。 */
const LIGHT_READS = 20;
/** SQL ごとの内訳を残すのは、1回の処理でこれ以上読んだ文だけ。 */
const HEAVY_SQL_READS = 100;
const SQL_PREFIX = 110;

const keyOf = (sql: string) => sql.replace(/\s+/g, " ").trim().slice(0, SQL_PREFIX);

/** D1 を包み、実行した文の rows_read / rows_written を meter に足し込む。使い方は元の D1 と同じ。 */
export function metered(db: D1Database): { db: D1Database; meter: Meter } {
  const meter: Meter = { reads: 0, writes: 0, bySql: new Map() };
  const raws = new WeakMap<object, { stmt: D1PreparedStatement; sql: string }>();
  const add = (sql: string, res: any) => {
    const r = Number(res?.meta?.rows_read ?? 0), w = Number(res?.meta?.rows_written ?? 0);
    meter.reads += r;
    meter.writes += w;
    const k = keyOf(sql);
    const e = meter.bySql.get(k) ?? { reads: 0, writes: 0, calls: 0 };
    e.reads += r; e.writes += w; e.calls++;
    meter.bySql.set(k, e);
    return res;
  };
  const wrap = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy: any = {
      bind: (...v: unknown[]) => wrap(stmt.bind(...v), sql),
      all: async () => add(sql, await stmt.all()),
      run: async () => add(sql, await stmt.run()),
      raw: (...a: any[]) => (stmt as any).raw(...a),
      // first() は行数を返さないので、all() で数えてから先頭の行を返す
      first: async (col?: string) => {
        const res: any = add(sql, await stmt.all());
        const row = res.results?.[0] ?? null;
        return col && row ? (row[col] ?? null) : row;
      },
    };
    raws.set(proxy, { stmt, sql });
    return proxy as D1PreparedStatement;
  };
  const out: any = {
    prepare: (sql: string) => wrap(db.prepare(sql), sql),
    batch: async (list: D1PreparedStatement[]) => {
      const inner = list.map((s) => raws.get(s as object) ?? { stmt: s, sql: "(batch)" });
      const res = await db.batch(inner.map((x) => x.stmt));
      res.forEach((r, i) => add(inner[i].sql, r));
      return res;
    },
    exec: (q: string) => db.exec(q),
    dump: () => (db as any).dump(),
    withSession: (...a: any[]) => (db as any).withSession(...a),
  };
  return { db: out as D1Database, meter };
}

/** URL のパスから、記録用の名前を作る（ID の部分は :id にまとめる）。 */
export const sourceOf = (method: string, pathname: string) =>
  `${method} ${pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id").slice(0, 60)}`;

/** 1回の処理ぶんを usage_log に足し込む。失敗しても本体の処理には響かせない。 */
export async function recordUsage(db: D1Database, source: string, meter: Meter, now = Date.now()): Promise<void> {
  if (!meter.reads && !meter.writes) return;
  // 軽い呼び出しは10回に1回だけ記録し、そのぶん10倍して数える
  const light = meter.reads < LIGHT_READS && meter.writes === 0;
  if (light && Math.random() >= 0.1) return;
  const scale = light ? 10 : 1;
  const day = new Date(now).toISOString().slice(0, 10);
  const up = (sql: string, calls: number, reads: number, writes: number) =>
    db
      .prepare(
        `INSERT INTO usage_log (day, source, sql, calls, reads, writes) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (day, source, sql) DO UPDATE SET calls = calls + ?4, reads = reads + ?5, writes = writes + ?6`,
      )
      .bind(day, source, sql, calls * scale, reads * scale, writes * scale);
  const heavy = [...meter.bySql.entries()].filter(([, e]) => e.reads >= HEAVY_SQL_READS).sort((a, b) => b[1].reads - a[1].reads).slice(0, 5);
  try {
    await db.batch([up("", 1, meter.reads, meter.writes), ...heavy.map(([sql, e]) => up(sql, e.calls, e.reads, e.writes))]);
  } catch (e) {
    console.warn("usage log failed", e);
  }
}
