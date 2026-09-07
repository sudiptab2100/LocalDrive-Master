# Conventions, safety patterns & gotchas

Read this before changing server or main‑process code. These are the invariants that keep
LocalDrive safe (no data loss) and secure (no path escapes / privilege bypass).

## Language & module conventions
- **TypeScript `strict`, ESM everywhere.** Relative imports use explicit **`.js`**
  extensions (ESM resolution) even though sources are `.ts`. Shared code is imported via
  the **`@shared/*`** path alias.
- **Module boundaries:** the renderer talks only through `window.ld` (IPC); browsers talk
  only through `/api` + `/dav`. Never import server/Node modules into renderer/webui code,
  and keep secrets out of `AppConfigView`.
- Add IPC features in `shared/ipc.ts`, `preload`, and `main`, plus the matching HTTP
  route and `admin/ld-http.ts` shim. Preserve desktop/browser-admin parity; see
  [ipc-api.md](ipc-api.md) and [http-api.md](http-api.md).
- Type‑check with `npm run typecheck` before shipping. There is no separate lint gate.

## No‑data‑loss patterns (do not weaken)
- **Atomic writes.** Never write directly to a destination path. Write to a temp file on
  the **same filesystem**, then `rename` into place. `moveAtomic` does this and falls back
  to copy‑to‑temp‑then‑rename across devices (`EXDEV`). Uploads stage under
  `<configDir>/uploads/…` (tus) and are finalized with `finalizeUpload` → `moveAtomic`.
- **Backup publication must not clobber.** Recoverable jobs use durable intents,
  content verification, exclusive publication and an owner-bound receipt. Keep the
  packaged `rename-no-replace` helper; never replace its fallback with plain rename.
  Do not purge unfinished backup stages as generic tus cleanup.
- **SQLite WAL + checkpoint.** The DB runs in WAL mode; `ServerManager.stop()` runs a
  `checkpoint()` so the WAL is flushed and the DB is consistent for the next start. Keep
  DB writes inside the app's helpers, not ad‑hoc connections.
- **Graceful shutdown.** `stop(drainMs = 8000)` stops accepting new sockets and drains
  in‑flight ones before closing, so a restart doesn't truncate a transfer. The server can
  go **down and up with no data loss** — preserve this when editing lifecycle code.
- **Idempotent, additive migrations.** Schema changes in `db/index.ts` must be safe to run
  repeatedly on an existing DB (guard with `meta` version / `IF NOT EXISTS` / column
  checks). Never write a destructive migration.

## Security patterns (do not bypass)
- **Path confinement.** Every client‑supplied path is home‑relative and must pass through
  `driveScope` (`scopeIn`/`scopeOut`) + `safeResolve` / `resolveInDrive`, which reject
  `..` traversal and symlink escapes. Never `path.join` a raw client string onto a drive
  root yourself.
- **Refuse operating on the home root.** File mutations (rename/move/delete) must reject
  acting on a user's own home directory.
- **Check permission on the right node.** Read checks the target; mutations check
  **`write` on the parent**; copy checks read(source)+write(dest). Use `hasPermission` /
  `effectivePermission`; don't invent per‑route logic.
- **Pending users are blocked everywhere.** `resolveUser` rejects non‑`active` accounts on
  API, WebDAV, and uploads. Don't add an auth path that skips this.
- **`.localdrive/` is invisible.** Never list, index, serve, or share it. Dotfiles / macOS
  `._` sidecars are hidden unless `hidden=1`.
- **Secrets stay server‑side.** `jwtSecret` and `registeredDriveUuids` are in `AppConfig`
  but excluded from `AppConfigView`. The `ld_token` cookie is httpOnly; `Secure` only on
  TLS. `/api/cert` exposes only the **public** CA cert.

## Operational gotchas
- **Verify local packages.** Check the complete app signature and packaged native
  helper before activation. Use macOS's supported Open/Privacy & Security approval
  for trusted local builds; follow [build-deploy.md](build-deploy.md).
- **Stop gracefully.** Use the tray's Quit action or the terminal shutdown path, wait
  for transfers/database shutdown, and keep a rollback bundle before replacement.
  Never use SIGKILL as routine deployment. If an idle process remains after confirmed
  shutdown, target only its verified PID; name-based process killing is forbidden.
- **Detach DMGs before rebuilding.** Leftover `/Volumes/LocalDrive*` mounts break
  `npm run dist`; `hdiutil detach` them first.
- **`.local` vs LAN IP.** mDNS `*.local` names don't resolve on every client; the Connect
  panel also offers the raw LAN IP. Prefer the IP URL when a client can't find the host.
- **HTTPS trust is one‑time.** Clients install the **CA** from `/api/cert` once; the leaf
  cert auto‑reissues (on SAN drift / near‑expiry) **without** re‑trust because the CA is
  stable. Don't regenerate the CA casually — it forces every client to re‑trust.
- **Native modules are unpacked from asar.** `better-sqlite3`, `sharp`, `@img` are in
  `asarUnpack`; after changing native deps run `npm run rebuild`.
- **Verify the served bundle after deploy.** Confirm the hashed `index-*.js` the server
  returns matches `out/webui/assets/` — a stale bundle means the copy step didn't take.
- **`create` tool refuses existing paths**; the view tool may mask some words — don't paste
  masked text into an edit's `old_str`.

## Related
- Security internals: [security-rbac.md](security-rbac.md)
- Data‑loss‑relevant layout: [data-model.md](data-model.md)
- Deploy steps: [build-deploy.md](build-deploy.md)
- Backup recovery: [background-backup.md](background-backup.md)
