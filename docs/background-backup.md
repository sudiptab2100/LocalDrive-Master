# Recoverable background backup (server)

This is an opt-in extension of tus, **not** a whole-file PUT API. File bytes still
use `POST`/`HEAD`/`PATCH /api/upload`. Ordinary uploads keep their FileStore sidecars,
deferred-length support, termination and existing overwrite behavior.

## Fixed client contract

Public `GET /api/health` includes:

```json
{ "ok": true, "capabilities": { "backgroundBackupTus": 1 } }
```

The existing `status` field is also retained.

To create a recoverable upload, add these base64-encoded tus `Upload-Metadata`
entries alongside `filename`, `drive` and `path`:

- `backupJobId`: a UUID, stable across attempts. UUIDs are normalized to lowercase.
- `backupSha256`: exactly 64 lowercase hexadecimal characters.

Also send the `Upload-Length` **header** with the immutable, nonnegative,
safe-integer byte length; it is not an `Upload-Metadata` entry. Deferred length is
not supported for backup jobs; empty files are supported.

Send bearer authentication and `Cookie: ld_view=user`. The server binds the owner
from authentication, **never metadata**, and forces private user space even when
an administrator omits that cookie or sends `ld_view=admin`.
Backup requests require the bearer token: an expired/invalid token cannot fall
back to another account's `ld_token` cookie. Ordinary tus authentication is unchanged.

A new job returns tus `201` with a relative `Location: /api/upload/<id>`. A repeat
POST for the same owner/job returns `409`; changed length, hash, original filename
or destination is rejected rather than creating a second transfer. Recover via
the status endpoint, not another independent job. Another account may use the
same UUID, but it gets a different upload resource and private destination.

`GET /api/backup/uploads/:jobId` requires authentication and returns:

```json
{
  "jobId": "bd4e4c9c-61b1-4314-bb7a-711be27ed0a9",
  "state": "complete",
  "uploadUrl": "/api/upload/7e8d081b59e347968563d641a6569f61",
  "size": 123,
  "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "drive": "the-registered-drive-uuid",
  "path": "Backup/Photos",
  "filename": "actual-name.jpg",
  "remotePath": "Backup/Photos/actual-name.jpg",
  "offset": 123
}
```

- States: `uploading`, `finalizing`, `complete`, `failed`.
- Unknown jobs and other owners' jobs return identical `404` responses, including
  when the caller is an administrator.
- `path` is home-relative; the root is `""`. `filename` and `remotePath` describe
  the **actual** selected destination, which may differ from the requested name
  after collision resolution. Validate immutable size/hash/drive/path when recovering.
- Optional fields are `offset`, `error`, `errorCode`, and `retryable`.
- Responses use `Cache-Control: no-store`. This endpoint carries status/receipts,
  never file bytes. An authorized read can repair interrupted creation/finalization.
- Polling during an active PATCH returns the persisted state without interrupting
  the transfer; `offset` can be absent. Use tus HEAD for the authoritative partial
  offset before preparing a suffix PATCH.
- A `complete` receipt, **not** an offset equal to size, is proof of completion.
  Completed backup HEAD/PATCH requests return `410` and direct the client to the
  receipt. Re-reading that receipt neither recreates the file nor counts it again.
  The receipt records acceptance; it does not promise the owner has not subsequently
  moved or deleted the completed file.
- Backup resource GET/DELETE are disabled (`405`); cancellation should cancel a
  transport attempt while retaining the resumable logical job.

## Authorization and waiting states

Creation, status/recovery, HEAD, PATCH and finalization check the current active
account, registered drive, private home and write permission on the scoped
destination directory. Changes to the owner's home or configured share-root name
block the old job rather than silently redirecting it. More-specific read-only
ACLs override a writable home. Ambiguous home ownership (including a legacy admin
name that sanitizes to another account's home) is denied. Destination directory symlinks are rejected,
including links into another user's space; a symlink at the target filename is
a collision, never content eligible for adoption.

| Condition | Behavior |
| --- | --- |
| No valid/active account | `401` |
| Access revoked / drive unregistered / unsafe directory | `403`; retain unfinished work |
| Partial upload, destination offline | status `uploading`, `errorCode: destination_offline`, `retryable: true`; HEAD still reports the local offset, PATCH returns `503` |
| All bytes received, destination offline | status `finalizing` with the same retryable error; retain the staged bytes |
| Same drive UUID remounts elsewhere | resolve its current mount, recheck access and resume/finalize on the next status/HEAD/PATCH |
| Full/read-only/unavailable destination | `destination_full` / `destination_unwritable` / `destination_unavailable`; retain work for retry (`507` or `503` on PATCH) |
| Missing native helper or unsupported no-replace primitive | `destination_atomic_publish_unsupported`; retain work, never use an overwriting fallback |
| Wrong content digest or invalid stage | `failed`, `checksum_mismatch` / `staging_invalid`; no successful receipt |
| Ready stage missing and no verified publication intent target | `failed`, `staging_missing`; never infer success from the filename or length alone |

After remount/access repair, recovery requires the same authenticated owner.
The server does not retain credentials or perform an unauthenticated background sweep.

## Crash-safe ordering

Implementation is separated into `server/backup-uploads.ts`,
`server/db/backup-uploads.ts`, and the existing scope/finalization/atomic helpers.
The installed `@tus/server` releases its datastore lock **before** invoking
`onUploadFinish`; backup requests therefore also hold a per-upload lock through
finalization. One serving process per `LOCALDRIVE_HOME` remains the supported model.

1. Commit the owner/job/upload mapping and immutable destination/content identity
   before FileStore creation. Backup metadata lives in SQLite, not a credentials-
   bearing request dump or a non-atomic tus JSON sidecar.
2. Exclusively create and sync the staged file, then commit `stage_created=1`.
   Recovery of an interrupted create never truncates an already-existing file.
   Each backup PATCH syncs its staged bytes; the file's size remains the tus offset.
3. Verify full size/SHA-256, then durably commit `finalizing` and the intended
   actual filename **before** publishing it. Persist a new intent before each
   collision rename. Source bytes remain available until the receipt is committed.
4. Adopt an existing regular file only after verifying its full size and digest.
   Otherwise publish atomically without replacement, selecting a unique filename
   on collision. A concurrent creator cannot be overwritten.
5. Verify/sync the published file and commit the receipt, transfer counters,
   audit entry and polling-feed change in **one transaction**. Intent/receipt
   transactions use SQLite `synchronous=FULL`, restoring the application's ordinary
   setting afterwards. Emit the live event only after that commit.
6. Remove only that upload's staged bytes/sidecar and owned part. Receipt replay
   retries cleanup but does not re-finalize, re-log or double-count.

A crash after publication but before the receipt is repaired by verifying the
persisted intent's target. If it is absent or contains different bytes, retained
source data can be safely republished under a new name. Without source data and
without a verified target, the job fails instead of claiming an arbitrary file.

## Atomic publication on removable filesystems

Hard links provide an atomic no-replace fast path. Cross-device copies first use
an owned `.localdrive/tmp/backup-<uploadId>.part` on the destination filesystem.
For filesystems without hard links, such as exFAT, a tiny macOS executable calls
`renamex_np(..., RENAME_EXCL)`. Node's plain `rename` and macOS `mv -n` are not safe
substitutes: check-then-rename can overwrite a concurrently-created file.

`npm run build:atomic-helper` builds a universal arm64/x86_64 executable with the
existing macOS compiler. `dev`, `server:dev`, `server:start` and the full build
invoke it automatically. Packaging copies it to `Resources/native` and includes
it in the signing binary list. End users do **not** need a compiler.
Direct standalone source runs should build it first and run from the repository
root; trusted tooling may override its location with `LOCALDRIVE_ATOMIC_HELPER`.
A packaged app never searches the working directory for a missing helper.

## Isolated regressions

No new test framework or dependency rebuild is needed:

```bash
npm run typecheck:node

# SESSION_FILES must be an existing session-only artifacts directory.
ELECTRON_RUN_AS_NODE=1 TSX_DISABLE_CACHE=1 TMPDIR="$SESSION_FILES" \
  node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --import tsx \
  scripts/background-backup-regression.ts \
  --fixtures "$SESSION_FILES/background-backup-server-regression-check"
```

Use installed Electron in Node mode when `better-sqlite3` has Electron's ABI.
Do not rebuild shared user modules merely to run the test. A compatible Node
runtime can instead run the same script with `node --import tsx`.

The script refuses to reuse an existing fixture directory, uses explicit isolated
config and `127.0.0.1` ephemeral listeners, and never starts discovery or accesses
real drive registrations. Its fault injection exists only in the fixture child,
not in production routes. Only its own child processes and files are removed.

Coverage includes old-schema migration, legacy tus/cookie/Basic/deferred-length/overwrite,
duplicate/concurrent creation, account isolation, admin private scope, replay,
partial offsets, cancelled streaming PATCHes, process restarts, creation/receive/
publication/receipt crash boundaries and lost responses, wrong hashes, arbitrary
same-named targets, exact-content adoption, concurrent/long-name collisions,
current/nested/revoked-mid-transfer permissions, symlink confinement, unregistered
and offline/remounted destinations, out-of-space failures, missing helpers and
the real native no-hardlinks fallback.

Optional `--exfat` additionally tests an exFAT disk image under that fixture and
detaches only its own mount. If macOS prohibits image creation it reports an
explicit skip without requesting additional privileges. The forced native
fallback test does not by itself prove physical-drive behavior.

### Remaining operational limits

- Unfinished/failed jobs and receipts have no automatic expiry or retention UI;
  do not purge pending data as a generic tus cleanup. Deleted-owner orphan stages
  cannot be retrieved through tus but may require future administrative retention
  tooling. Completed destination files are never deleted by receipt cleanup.
- In-memory request locks do not support multiple serving processes sharing the
  same config/upload directory.
- Filesystem/device flush guarantees still apply. A hostile local process changing
  filesystem paths is outside the server's authenticated-client isolation boundary.
- Real USB unplug/power-loss and packaged signed-app execution are separate
  deployment validation; isolated HTTP/crash tests do not establish iOS scheduling.
