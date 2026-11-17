import type { ComputedMatch } from "./stats";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  HENRIK_API_KEY: string;
  RIOT_IDS: string;
  REGION: string;
  PLATFORM: string;
  /** Discord 連携（任意）。3つとも設定されているときだけ bot が有効になる。 */
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_APP_ID?: string;
  DISCORD_BOT_TOKEN?: string;
  /** テスト用。既定は https://discord.com/api/v10 */
  DISCORD_API_BASE?: string;
}

/** player_matches の列。順序は INSERT とスキーマの両方で使う。 */
const PM_NUM_COLS_V1 = [
  "tier", "score", "kills", "deaths", "assists", "headshots", "bodyshots", "legshots",
  "damage_dealt", "damage_received", "rounds", "rounds_won", "rounds_lost", "won",
  "fk", "fd", "fk_wins", "fd_wins", "mk2", "mk3", "mk4", "mk5", "kast_rounds",
  "trade_kills", "traded_deaths", "clutch_attempts", "clutch_wins",
  "atk_rounds", "atk_wins", "def_rounds", "def_wins", "atk_kills", "atk_deaths", "def_kills", "def_deaths",
  "plants", "defuses", "pistol_rounds", "pistol_wins", "loadout_total",
] as const;
/** 現在の列。V1 以降に追加した列は、テーブル作成（DDL_V1）ではなく後続のスキーマ変更で足す。 */
export const PM_NUM_COLS = [...PM_NUM_COLS_V1, "dmg_rounds"] as const;
const PM_TEXT_COLS = ["name", "tag", "team", "party_id", "agent", "agent_id", "tier_name", "clutches", "weapons"] as const;

const DDL_V1 = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS players (
     puuid TEXT PRIMARY KEY, name TEXT NOT NULL, tag TEXT NOT NULL, region TEXT NOT NULL, platform TEXT NOT NULL,
     rank_json TEXT, rank_updated_at INTEGER DEFAULT 0, discovered_at INTEGER DEFAULT 0,
     backfilled INTEGER DEFAULT 0, created_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS match_queue (
     match_id TEXT PRIMARY KEY, region TEXT NOT NULL, started_at INTEGER DEFAULT 0, queue TEXT,
     status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER DEFAULT 0, error TEXT, updated_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS match_queue_status ON match_queue (status, started_at)`,
  `CREATE TABLE IF NOT EXISTS matches (
     match_id TEXT PRIMARY KEY, started_at INTEGER, queue TEXT, queue_name TEXT, mode_type TEXT, map TEXT, season TEXT,
     game_length_ms INTEGER, rounds INTEGER, round_based INTEGER, cluster TEXT, score TEXT, winner TEXT,
     detail TEXT, ingested_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS match_raw (match_id TEXT PRIMARY KEY, body TEXT)`,
  `CREATE TABLE IF NOT EXISTS player_matches (
     match_id TEXT NOT NULL, puuid TEXT NOT NULL,
     started_at INTEGER, queue TEXT, mode_type TEXT, map TEXT, season TEXT, round_based INTEGER,
     ${PM_TEXT_COLS.map((c) => `${c} TEXT`).join(", ")},
     ${PM_NUM_COLS_V1.map((c) => `${c} INTEGER`).join(", ")},
     PRIMARY KEY (match_id, puuid))`,
  `CREATE INDEX IF NOT EXISTS pm_puuid_started ON player_matches (puuid, started_at)`,
  `CREATE INDEX IF NOT EXISTS pm_party ON player_matches (match_id, party_id)`,
  `CREATE TABLE IF NOT EXISTS mmr_history (
     puuid TEXT NOT NULL, match_id TEXT NOT NULL, date INTEGER, tier INTEGER, tier_name TEXT,
     rr INTEGER, rr_change INTEGER, elo INTEGER, map TEXT, season TEXT,
     PRIMARY KEY (puuid, match_id))`,
];

const DDL_V2 = [
  // Discord ユーザーと Riot アカウントの紐付け。ランクは問い合わせ結果のキャッシュ。
  `CREATE TABLE IF NOT EXISTS discord_links (
     user_id TEXT PRIMARY KEY, puuid TEXT NOT NULL, name TEXT, tag TEXT, region TEXT, platform TEXT,
     tier INTEGER, rr INTEGER, elo INTEGER, rank_updated_at INTEGER DEFAULT 0,
     discovered_at INTEGER DEFAULT 0, linked_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS discord_links_puuid ON discord_links (puuid)`,
  `CREATE TABLE IF NOT EXISTS lobbies (
     lobby_id TEXT PRIMARY KEY, guild_id TEXT, channel_id TEXT, host_id TEXT,
     state TEXT NOT NULL DEFAULT 'open', variant INTEGER DEFAULT 0, map TEXT, flip INTEGER DEFAULT 0, created_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS lobby_members (
     lobby_id TEXT NOT NULL, user_id TEXT NOT NULL, joined_at INTEGER, PRIMARY KEY (lobby_id, user_id))`,
];

const DDL_V3 = [
  // source: 'config' = RIOT_IDS に書かれた本人（全履歴を取り込み、生データも保存）
  //         'lookup' = サイトで検索された人（直近の試合だけ取り込み、見られている間だけ更新）
  `ALTER TABLE players ADD COLUMN source TEXT NOT NULL DEFAULT 'config'`,
  `ALTER TABLE players ADD COLUMN last_viewed_at INTEGER DEFAULT 0`,
  // puuid: この試合を取り込み待ちに積んだプレイヤー（その人のページを開いているとき優先して取り込む）
  // keep_raw: 生データも保存するか。容量を抑えるため、本人の試合だけ保存する
  `ALTER TABLE match_queue ADD COLUMN puuid TEXT`,
  `ALTER TABLE match_queue ADD COLUMN keep_raw INTEGER NOT NULL DEFAULT 0`,
  `UPDATE match_queue SET keep_raw = 1`,
  `CREATE INDEX IF NOT EXISTS match_queue_puuid ON match_queue (puuid, status)`,
];

const DDL_V4 = [
  // ADR の分母。ダメージが記録されていない試合（カスタムなど）は 0 にして、ADR の計算から外す
  `ALTER TABLE player_matches ADD COLUMN dmg_rounds INTEGER`,
  `UPDATE player_matches SET dmg_rounds = CASE WHEN match_id IN (
     SELECT match_id FROM player_matches GROUP BY match_id
     HAVING SUM(damage_dealt) > 0 OR SUM(headshots + bodyshots + legshots) > 0) THEN rounds ELSE 0 END`,
  // カスタムゲームのキューIDは空文字で保存されていた。絞り込みで選べるよう "custom" に揃える
  `UPDATE matches SET queue = 'custom' WHERE queue = ''`,
  `UPDATE player_matches SET queue = 'custom' WHERE queue = ''`,
];

const DDL_V5 = [
  // カスタムを「通常ルールの 5対5」と「それ以外」に分ける（判定は stats.ts の classifyQueue と同じ）
  `UPDATE matches SET queue = 'custom5v5' WHERE queue = 'custom' AND mode_type = 'Standard' AND match_id IN (
     SELECT match_id FROM player_matches GROUP BY match_id
     HAVING COUNT(*) = 10 AND SUM(team = 'Red') = 5 AND SUM(team = 'Blue') = 5)`,
  `UPDATE player_matches SET queue = 'custom5v5' WHERE queue = 'custom'
     AND match_id IN (SELECT match_id FROM matches WHERE queue = 'custom5v5')`,
];

const DDL_V6 = [
  // アクトごとの到達ランクと生涯最高ランク（skill.ts の RankHistory を JSON で保存）
  `ALTER TABLE discord_links ADD COLUMN history TEXT`,
  // 既存の登録者にも履歴が入るよう、次の機会にランクを取り直させる
  `UPDATE discord_links SET rank_updated_at = 0`,
];

const DDL_V7 = [
  // ランクの記録がない人が、本当の初心者か経験者かを見分けるために使う
  `ALTER TABLE discord_links ADD COLUMN account_level INTEGER`,
  `UPDATE discord_links SET rank_updated_at = 0`,
];

const DDL_V8 = [
  // 直近のコンペで、勝ったとき・負けたときに RR がどれだけ動いたか（skill.ts の RrTrend を JSON で保存）
  `ALTER TABLE discord_links ADD COLUMN rr_trend TEXT`,
  `ALTER TABLE discord_links ADD COLUMN rr_updated_at INTEGER DEFAULT 0`,
];

/** 番号順に適用するスキーマ変更。追加するときは末尾に足す（既存の要素は書き換えない）。 */
const MIGRATIONS = [DDL_V1, DDL_V2, DDL_V3, DDL_V4, DDL_V5, DDL_V6, DDL_V7, DDL_V8];

let ready: Promise<void> | null = null;

/** テーブルが無ければ作る。デプロイ後に手動でマイグレーションを流す必要をなくすため、コード側で保証する。 */
export function ensureSchema(db: D1Database): Promise<void> {
  ready ??= (async () => {
    let current = 0;
    try {
      const row = await db.prepare(`SELECT value FROM meta WHERE key = 'schema'`).first<{ value: string }>();
      current = Number(row?.value) || 0;
    } catch {
      // meta テーブルがまだ無い
    }
    for (let v = current; v < MIGRATIONS.length; v++) {
      await db.batch([
        ...MIGRATIONS[v].map((sql) => db.prepare(sql)),
        db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)`).bind(String(v + 1)),
      ]);
    }
  })().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

/** D1 の1行サイズ上限（2MB）に収まる場合だけ生データを保存する。 */
const RAW_MAX_BYTES = 1_800_000;

/** 1試合分の計算結果を保存する。json_each で10人分を1文にまとめ、クエリ数を抑える。 */
export function ingestStatements(db: D1Database, c: ComputedMatch, rawBody: string | null): D1PreparedStatement[] {
  const m = c.match;
  const now = Date.now();
  const cols = [...PM_TEXT_COLS, ...PM_NUM_COLS];
  const stmts = [
    db
      .prepare(
        `INSERT OR REPLACE INTO matches (match_id, started_at, queue, queue_name, mode_type, map, season,
           game_length_ms, rounds, round_based, cluster, score, winner, detail, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        m.match_id, m.started_at, m.queue, m.queue_name, m.mode_type, m.map, m.season,
        m.game_length_ms, m.rounds, m.round_based ? 1 : 0, m.cluster, JSON.stringify(m.score), m.winner,
        JSON.stringify(c.detail), now,
      ),
    db
      .prepare(
        `INSERT OR REPLACE INTO player_matches
           (match_id, puuid, started_at, queue, mode_type, map, season, round_based, ${cols.join(", ")})
         SELECT ?1, json_extract(value, '$.puuid'), ?2, ?3, ?4, ?5, ?6, ?7,
           ${cols.map((col) => `json_extract(value, '$.${col}')`).join(", ")}
         FROM json_each(?8)`,
      )
      .bind(m.match_id, m.started_at, m.queue, m.mode_type, m.map, m.season, m.round_based ? 1 : 0, JSON.stringify(c.players)),
    db
      .prepare(`UPDATE match_queue SET status = 'done', error = NULL, updated_at = ? WHERE match_id = ?`)
      .bind(now, m.match_id),
  ];
  if (rawBody && rawBody.length < RAW_MAX_BYTES) {
    stmts.push(db.prepare(`INSERT OR REPLACE INTO match_raw (match_id, body) VALUES (?, ?)`).bind(m.match_id, rawBody));
  }
  return stmts;
}
