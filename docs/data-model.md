# Data model & persistence

LocalDrive persists three kinds of state: a **SQLite metadata DB** and a **config
file** (both in the app‑support dir), and the **actual files** on each shared drive.
Everything needed to restore after a restart lives outside the process, so a
stop/crash/restart never loses data.

## Locations
| What | Path |
| --- | --- |
| App‑support dir (`configDir`) | `~/Library/Application Support/LocalDrive/` (override: `LOCALDRIVE_HOME`) |
| Config file | `<configDir>/config.json` |
| SQLite DB | `<configDir>/localdrive.db` (+ `-wal`, `-shm`) |
| Logs | `<configDir>/logs/main.log` |
| TLS material | `<configDir>/tls/` (`ca.crt`, `ca.key`, `server.crt`, `server.key`, `leaf.json`) |
| In‑progress uploads (tus) | `<configDir>/uploads/` |
| Backup intent/receipt metadata | SQLite `backup_uploads` (no backup JSON sidecar) |
| Per‑drive share root | `<mount>/LocalDrive/` (name = `config.shareRootName`) |
| Per‑user home | `<mount>/LocalDrive/<home>/` |
| Per‑drive app data | `<mount>/.localdrive/` |

Paths are created on demand by `getPaths()` / `ensureDriveLayout*()`.

## SQLite schema (`src/server/db/index.ts`)
Opened with `journal_mode = WAL`, `synchronous = NORMAL`, `foreign_keys = ON`. WAL is
flushed to the main DB file via `checkpoint()` on every server stop.

### `users`
| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `username` | TEXT UNIQUE | case‑insensitive uniqueness via `idx_users_username_nocase` |
| `password_hash` | TEXT | bcrypt |
| `role` | TEXT | `admin` \| `user` (default `user`) |
| `created_at` | TEXT | `datetime('now')` |
| `home` | TEXT | migration v2 — private folder name; `''` for admins |
| `status` | TEXT | migration v3 — `active` \| `pending` |

### `drives` — the drive registry
| Column | Type | Notes |
| --- | --- | --- |
| `uuid` | TEXT PK | Volume UUID, `name:<hash>` fallback, or `folder:<hash>` for custom folders |
| `label` | TEXT | volume name / folder basename |
| `last_mount_path` | TEXT | last known mount path (for offline reattach + custom folders) |
| `filesystem` | TEXT | e.g. APFS/exFAT, or `Folder` |
| `external` | INTEGER | 1 = external/removable |
| `registered` | INTEGER | 1 = shared by the admin |
| `first_seen` / `last_seen` | TEXT | timestamps |

### `acls` — per‑folder RBAC
`(id, user_id→users, drive_uuid, path_prefix, permission)` with
`UNIQUE(user_id, drive_uuid, path_prefix)` and `ON DELETE CASCADE`.
`path_prefix = ''` means the whole drive; `permission ∈ {read, write, admin}`.
For non‑admins, a `write` ACL on their deterministic home path is the source of truth for
approved drive access.

### `access_requests` — per-drive access workflow
| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `user_id` | INTEGER FK → `users(id)` | `ON DELETE CASCADE` |
| `drive_uuid` | TEXT | registered drive being requested |
| `status` | TEXT | `pending` \| `approved` \| `denied`, default `pending` |
| `requested_at` | TEXT | request timestamp |
| `decided_at` | TEXT | approval/denial timestamp, nullable |
| `decided_by` | INTEGER | admin user id, nullable |

Constraints/indexes: `UNIQUE(user_id, drive_uuid)` and `idx_access_status`. This table is
the source of truth for `pending` and `denied`; granted/approved access is determined by
the user's home ACL on that drive.

### `shares` — public share links *(schema present; API not yet wired — see features.md)*
`(id, token UNIQUE, drive_uuid, path, permission, password_hash, expires_at, created_by,
created_at)`.

### `backup_uploads` — resumable backup intents and receipts

Additive `CREATE TABLE IF NOT EXISTS`; existing users, ACLs and ordinary tus
sidecars are unchanged.

| Columns | Purpose |
| --- | --- |
| `owner_id`, `job_id` | Composite primary key; owner FK → users (`ON DELETE CASCADE`), UUID logical job |
| `upload_id` | Unique opaque tus resource ID |
| `drive_uuid`, `share_root`, `home`, `path` | Immutable drive, configured share root and private scoped destination |
| `requested_filename`, `filename` | Original immutable name and actual collision-safe publication intent/receipt name |
| `size`, `sha256` | Immutable byte count and content identity |
| `state` | `uploading` / `finalizing` / `complete` / `failed` |
| `stage_created` | Creation intent (`0`) versus durably initialized stage (`1`) |
| `error_code` | Controlled error code, never a raw exception/request/credential |
| `created_at`, `updated_at`, `completed_at` | ISO timestamps (`completed_at` nullable) |

Backup-specific transactions temporarily use `synchronous=FULL`: persist creation
before touching the stage, finalization intent before publishing, then atomically
commit completion together with counters/activity/change feed before cleanup.
Offsets come from staged file size, not an independently drifting DB counter.
No tokens, cookies or arbitrary client metadata are stored.

Unfinished data is not expired; an offline drive is resumable. Receipts are
historical/idempotent even if an owner later moves/deletes the completed file.
For the crash-boundary algorithm and retention limits see
[background-backup.md](background-backup.md).

### `activity` — audit log
`(id, ts, user_id, username, action, detail, ip)` with `idx_activity_ts (ts DESC)`.
Written by `logActivity(action, {...})`. Actions include `login`, `login_failed`,
`login_pending`, `register`, `register_pending`, `mkdir`, `delete`, `upload`,
`drive_register`, `drive_unregister`, `server_start`, `server_stop`, `https_error`,
`user_create`/`user_delete`/`user_approve`.

### `stats` — counters
`(key PRIMARY KEY, value INTEGER)`. Bumped via `bumpStat(key, by)`; read via `getStats()`.
Known keys: `bytes_in`, `bytes_out`, `uploads`, `downloads`.

### `file_index` + `file_fts` — search
- `file_index (drive_uuid, path, name, is_dir, size, mtime_ms, mime)`, PK
  `(drive_uuid, path)`, plus `idx_file_name`.
- `file_fts` — FTS5 virtual table `(name, path, drive_uuid UNINDEXED)`.
- Populated lazily: **every directory listing indexes its entries** (`indexEntries`);
  rename/move/delete prune stale rows (`removeFromIndex`). So search coverage grows as
  folders are browsed. `.localdrive` is never indexed.

### `meta`
`(key PRIMARY KEY, value)` — holds `schema_version` and one‑off migration flags such as
`access_model_reset`.

### Migrations
Additive and idempotent, run in `getDb()`: add `users.home` (v2), add `users.status` +
the case‑insensitive username index (v3), create `access_requests`, and run the one‑time
access reset guarded by `meta.access_model_reset`. The reset deletes non‑admin ACL rows so
users re‑request drive access under the opt‑in model; it never touches file data and runs
before `backfillHomes()`. New migrations should follow the same pattern (guard with
`PRAGMA table_info` / `IF NOT EXISTS` or `meta` flags; avoid destructive file changes).

## Config file (`src/server/config.ts`)
`config.json` is the persisted `AppConfig`. Loaded with `loadConfig()` (fills defaults,
generates + persists `jwtSecret` on first run) and written atomically via `saveConfig()`
(temp file + `rename`).

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | `4820` | HTTP listen port |
| `host` | `0.0.0.0` | bind address (`127.0.0.1` = this Mac only) |
| `jwtSecret` | generated | JWT signing secret (persisted, never shipped) |
| `registeredDriveUuids` | `[]` | (legacy hint; the DB `registered` flag is source of truth) |
| `shareRootName` | `LocalDrive` | share‑root folder name created on each drive |
| `autoStart` | `true` | start the server when the app launches |
| `httpsEnabled` | `false` | serve the encrypted HTTPS listener too |
| `httpsPort` | `4843` | HTTPS port when enabled |
| `registrationEnabled` | `true` | allow self‑registration from the web login |
| `autoApproveRegistrations` | `false` | activate self‑registrations immediately |
| `autoApproveAccessRequests` | `false` | grant drive access requests immediately |

`AppConfigView` (in `shared/ipc.ts`) is the subset exposed to the desktop Settings UI
(everything except `jwtSecret`/`registeredDriveUuids`) and includes
`autoApproveAccessRequests` for the Users tab's Drive access card.

## On-disk drive layout
When a drive is registered (`ensureDriveLayout*`), the share root and app data dirs are
created; per‑user homes are created or reused when access is granted:
```
<mount>/
  LocalDrive/                 ← share root (config.shareRootName)
    <home>/                   ← private folder for each approved user/admin My space
  .localdrive/                ← hidden app data, never listed/served/indexed
    tmp/                      ← same‑filesystem staging for atomic finalizes
    thumbs/                   ← cached WebP thumbnails (sha1 of path:mtime:size)
    trash/                    ← reserved (see features.md)
    versions/                 ← reserved (see features.md)
    users.json                ← portable, secret‑free user manifest (username/home/role)
```
`users.json` lets basic account info travel with the drive; it **never** contains
password hashes.

## Identity & confinement quick reference
- **Drive identity** is the stable `uuid` (survives remount/rename). Custom folders use a
  `folder:<sha1(path)>` UUID and are dropped from the registry on unregister (physical
  volumes keep a `registered=0` row).
- **User identity** for files is the deterministic `home` folder name
  (`homeNameFor(username) = sanitizeHomeName(username)`). New users are rejected on
  sanitized home collision; `-2`/`-3` suffixing is only a legacy backfill fallback.
  Non‑admins are confined to `LocalDrive/<home>/` only on drives where a home ACL grants
  access; admins have implicit access everywhere and `home = ''` for whole‑share mode.
  See [security-rbac.md](security-rbac.md).

## Related
- Access control & scoping: [security-rbac.md](security-rbac.md)
- Where these are read/written: [http-api.md](http-api.md), [architecture.md](architecture.md)

## Shared contract notes
- `DriveInfo.access?: 'granted' | 'pending' | 'denied' | 'none'` annotates registered drives
  returned to authenticated web clients. Admins are always `granted`; non‑admins are
  `granted` only when their home ACL exists.
- `AccessRequest` is `{ id, userId, username, driveUuid, driveLabel, requestedAt,
  existingSpace? }` and is used by the desktop Users tab for pending drive approvals.
