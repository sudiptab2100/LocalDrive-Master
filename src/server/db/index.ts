import Database from 'better-sqlite3'
import type { Database as DB } from 'better-sqlite3'
import { getPaths } from '../config.js'

/**
 * Central SQLite metadata store. Uses WAL mode for crash safety so a server
 * stop/crash/restart never corrupts metadata. Holds users, permissions,
 * drive registry, share links, activity log, transfer stats and a searchable
 * file index.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS drives (
  uuid TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  last_mount_path TEXT,
  filesystem TEXT,
  external INTEGER NOT NULL DEFAULT 1,
  registered INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS acls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  drive_uuid TEXT NOT NULL,
  path_prefix TEXT NOT NULL DEFAULT '',
  permission TEXT NOT NULL DEFAULT 'read',
  UNIQUE(user_id, drive_uuid, path_prefix),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS access_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  drive_uuid TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  decided_by INTEGER,
  UNIQUE(user_id, drive_uuid),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_access_status ON access_requests(status);

CREATE TABLE IF NOT EXISTS shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  drive_uuid TEXT NOT NULL,
  path TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'read',
  password_hash TEXT,
  expires_at TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity(ts DESC);

CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  kind TEXT NOT NULL,
  action TEXT NOT NULL,
  drive_uuid TEXT,
  path TEXT,
  user_id INTEGER,
  username TEXT
);
CREATE INDEX IF NOT EXISTS idx_changes_ts ON changes(ts DESC);

CREATE TABLE IF NOT EXISTS stats (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS file_index (
  drive_uuid TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  is_dir INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER NOT NULL DEFAULT 0,
  mime TEXT,
  PRIMARY KEY (drive_uuid, path)
);
CREATE INDEX IF NOT EXISTS idx_file_name ON file_index(name);

CREATE VIRTUAL TABLE IF NOT EXISTS file_fts USING fts5(
  name, path, drive_uuid UNINDEXED
);
`

let db: DB | null = null

export function getDb(): DB {
  if (db) return db
  const paths = getPaths()
  db = new Database(paths.dbFile)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)

  // --- Migrations -----------------------------------------------------------
  // v2: per-user private home directory folder name.
  const userCols = db.prepare('PRAGMA table_info(users)').all() as { name: string }[]
  if (!userCols.some((c) => c.name === 'home')) {
    db.exec("ALTER TABLE users ADD COLUMN home TEXT NOT NULL DEFAULT ''")
  }
  // v3: self-registration approval status ('active' | 'pending').
  if (!userCols.some((c) => c.name === 'status')) {
    db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'")
  }
  // v3: case-insensitive username uniqueness + lookups (non-destructive index).
  try {
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE)'
    )
  } catch {
    /* pre-existing case-duplicate usernames: keep startup resilient */
  }

  const version = (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
    | { value: string }
    | undefined)?.value
  if (!version) {
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version','1')").run()
  }

  // v4: switch from uniform sharing to opt-in per-drive access. Wipe the legacy
  // auto-granted per-drive ACLs for non-admins exactly once so every user
  // re-requests access to each drive. Only ACL rows are removed — file data on
  // the drives is never touched. Guarded by a meta flag so it runs a single time.
  const resetDone = db.prepare("SELECT value FROM meta WHERE key='access_model_reset'").get() as
    | { value: string }
    | undefined
  if (!resetDone) {
    db.prepare("DELETE FROM acls WHERE user_id IN (SELECT id FROM users WHERE role != 'admin')").run()
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('access_model_reset','1')").run()
  }
  return db
}

/** Flush the WAL to the main db file — call on graceful shutdown. */
export function checkpoint(): void {
  if (db) {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      /* ignore */
    }
  }
}

export function closeDb(): void {
  if (db) {
    checkpoint()
    db.close()
    db = null
  }
}

/** Increment a named counter (e.g. bytes_in, bytes_out, uploads, downloads). */
export function bumpStat(key: string, by = 1): void {
  getDb()
    .prepare(
      'INSERT INTO stats(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = value + excluded.value'
    )
    .run(key, by)
}

export function getStats(): Record<string, number> {
  const rows = getDb().prepare('SELECT key, value FROM stats').all() as {
    key: string
    value: number
  }[]
  const out: Record<string, number> = {}
  for (const r of rows) out[r.key] = r.value
  return out
}

export function logActivity(
  action: string,
  opts: { userId?: number | null; username?: string | null; detail?: string | null; ip?: string | null } = {}
): void {
  getDb()
    .prepare('INSERT INTO activity(user_id, username, action, detail, ip) VALUES(?,?,?,?,?)')
    .run(opts.userId ?? null, opts.username ?? null, action, opts.detail ?? null, opts.ip ?? null)
}

/** A recorded change, for the user-facing changes feed and live events. */
export interface ChangeRow {
  id: number
  ts: string
  kind: string
  action: string
  driveUuid: string | null
  path: string | null
  userId: number | null
  username: string | null
}

interface ChangeDbRow {
  id: number
  ts: string
  kind: string
  action: string
  drive_uuid: string | null
  path: string | null
  user_id: number | null
  username: string | null
}

function mapChange(r: ChangeDbRow): ChangeRow {
  return {
    id: r.id,
    ts: r.ts,
    kind: r.kind,
    action: r.action,
    driveUuid: r.drive_uuid,
    path: r.path,
    userId: r.user_id,
    username: r.username
  }
}

/**
 * Append a change record (file/access/drive mutation) and return the stored
 * row. Backs the `/api/changes` polling feed and the user-facing SSE stream.
 * `path` should be the full drive-relative path so consumers can permission-
 * check and map it back into each viewer's own scope.
 */
export function recordChange(c: {
  kind: string
  action: string
  driveUuid?: string | null
  path?: string | null
  userId?: number | null
  username?: string | null
}): ChangeRow {
  const info = getDb()
    .prepare(
      'INSERT INTO changes(kind, action, drive_uuid, path, user_id, username) VALUES(?,?,?,?,?,?)'
    )
    .run(c.kind, c.action, c.driveUuid ?? null, c.path ?? null, c.userId ?? null, c.username ?? null)
  const row = getDb()
    .prepare('SELECT * FROM changes WHERE id = ?')
    .get(info.lastInsertRowid) as ChangeDbRow
  return mapChange(row)
}

/** Recent changes strictly after `sinceIso` (ISO or SQLite datetime), oldest first. */
export function getChangesSince(sinceIso: string, limit = 300): ChangeRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM changes WHERE ts > datetime(?) ORDER BY ts ASC, id ASC LIMIT ?')
    .all(sinceIso, limit) as ChangeDbRow[]
  return rows.map(mapChange)
}
