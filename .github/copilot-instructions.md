# LocalDrive — Copilot working brief

> Auto-loaded into every Copilot session. Keep it short; deep detail lives in
> [`docs/`](../docs/README.md). Read the relevant `docs/` page before changing an area.

## What this is
A **macOS Electron app** that turns an external USB/HDD/SSD (or any folder) into a
**private Wi‑Fi/LAN network drive**. Devices on the same network access it via a
**browser PWA** and via **WebDAV** (mount in Finder/Explorer/Android). It supports
multiple drives with hot‑plug, per‑user private home folders with RBAC, resumable
uploads, thumbnails/preview, search, optional self‑signed HTTPS, self‑registration
with admin approval, and **graceful no‑data‑loss restart**. The desktop control
center is **also served as a browser‑based admin control panel** (`/admin`, admins
only), and the app can run **headless** (no window) from a terminal.

A companion **native mobile app** (Flutter iOS/Android) lives in the sibling repo
`LocalDrive-App` and is a pure client of this server's HTTP API. It relies on a few
**backward‑compatible** additions here — the `_localdrive._tcp` mDNS service, user‑scoped
SSE `GET /api/events/user`, the `GET /api/changes` polling feed, and recoverable tus
backup jobs/receipts (`backgroundBackupTus = 1`). Keep them additive and documented
in [`docs/http-api.md`](../docs/http-api.md) and
[`docs/background-backup.md`](../docs/background-backup.md).

## Tech stack
- **Electron 33** (main + preload + renderer), **React 18**, **TypeScript (strict, ESM)**.
- Build: **electron-vite** (app) + **Vite** (web PWA) + **electron-builder** (DMG/zip).
- Server: **Express 4**, **better-sqlite3** (WAL), **webdav-server**, **@tus/server**
  (resumable uploads), **sharp** (thumbnails), **archiver** (ZIP), **bonjour-service**
  (mDNS), **node-forge** (local CA/TLS), **bcryptjs** + **jsonwebtoken** (auth).
- Web client uploads via **Uppy core + @uppy/tus** (custom on‑brand UI, not the Uppy Dashboard).

## Repo map (see `docs/project-structure.md`)
```
src/main/      Electron main: tray, window, IPC handlers, /Volumes hot‑plug watcher, lifecycle
src/preload/   contextBridge — exposes window.ld (typed by src/shared/ipc.ts)
src/renderer/  Desktop control center (React): Dashboard/Drives/Users/Connect/Settings tabs
src/admin/     Admin control panel (browser): reuses src/renderer UI via an HTTP-backed
               window.ld (src/admin/ld-http.ts); built to out/admin, served under /admin
src/webui/     Client PWA served to browsers (React + Uppy/tus); App.tsx is the root
src/server/    Embedded HTTP/WebDAV server: auth/RBAC, drives registry+detect, file ops,
               tus uploads, search (SQLite FTS), discovery, TLS, config, db, lifecycle
src/shared/    Cross-process contracts: ipc.ts (IPC channels + LocalDriveApi) and types.ts
```
The server runs **inside** the Electron main process (via `ServerManager`), and can
also run standalone (`npm run server:dev`) with no Electron for fast iteration. The
packaged app also runs **headless** (`LocalDrive --headless` or `LOCALDRIVE_HEADLESS=1`):
no window/tray, serving the web UI + `/admin` and printing a **live‑updating connection
banner** (reprinted on status/port/HTTPS/LAN‑address changes).

## Golden-path commands
```bash
npm run dev            # run the desktop app (electron-vite) in development
npm run server:dev     # run ONLY the server (tsx watch), no Electron — fastest loop
npm run typecheck      # tsc for node + web (run the matching one after edits)
npm run build          # build web PWA + admin panel + electron bundles into out/
npm run dist           # produce release/ DMG + zip (electron-builder)
```
- After **web UI** edits: `npm run typecheck:web` then `npm run build`.
- After **server/main** edits: `npm run typecheck:node`.
- After **admin panel / renderer** edits: `npm run typecheck:web` then `npm run build:admin`.
- Run the installed app headless: `/Applications/LocalDrive.app/Contents/MacOS/LocalDrive --headless`.
- Only run targeted checks/builds relevant to what you changed.

## Non‑negotiable invariants (details in `docs/conventions.md` + `docs/security-rbac.md`)
- **No data loss on restart.** Writes are atomic (temp on same FS → `rename`); the DB is
  WAL with a checkpoint on stop; `ServerManager.stop()` drains in‑flight requests. Never
  write user files directly to their final path — use `finalizeUpload`/`moveAtomic`.
- **Path confinement is mandatory.** All user paths go through `safeResolve` /
  `scopeIn` / `scopeOut` (`src/server/util/fs-safe.ts` + `http/scope.ts`). Never join a
  client path onto a drive root without them.
- **Backup recovery stays tus.** Bytes use `/api/upload`; `/api/backup/uploads/:jobId`
  is owner-only status/recovery. Require bearer auth and private scope even for admins.
  Preserve immutable job/size/hash/destination identity and commit receipts/accounting
  once. Never infer completion from length or use an overwriting publication fallback.
  Ship the signed no-replace helper; retain unfinished stages across restarts/remounts.
- **Opt‑in per‑drive access.** After login, non‑admins see all registered drives but have
  no drive access by default; they request each drive and an admin approves in the desktop
  Users tab (or `autoApproveAccessRequests` grants instantly). Approval creates or reuses
  deterministic `LocalDrive/<home>/` and grants a `write` ACL; `GET /api/drives` only
  annotates access and never self‑provisions.
- **Per‑user home + RBAC.** Non‑admins are ACL‑gated and confined to `LocalDrive/<home>/`
  for drives they were granted. Admins implicitly access every drive; the web UI offers an
  `ld_view` cookie toggle (`admin` whole share by default, `user` = own space only) that
  can only restrict admins. WebDAV stays whole‑share for admins. Enforce with
  `hasPermission` / `driveScope` for **both** the web API and WebDAV.
- **Pending accounts cannot authenticate** anywhere — `resolveUser` treats non‑`active`
  users as unauthenticated (web, bearer, and WebDAV Basic).
- **`.localdrive/` is internal** (tmp/thumbs/trash/versions + `users.json`) and is never
  listed, indexed, or served. Dotfiles/AppleDouble `._` are hidden unless `?hidden=1`.
- **Keep the desktop app and admin panel in sync (default: always).** The admin control
  panel (`src/admin`) **reuses the desktop renderer** (`src/renderer/src`) via an
  HTTP-backed `LocalDriveApi` (`src/admin/ld-http.ts`), so the browser panel has **full
  parity** with the desktop (server lifecycle + every setting). Any change to the desktop
  app — a renderer panel, the `window.ld`/IPC surface, or admin-facing server behavior —
  **MUST be mirrored** to the admin panel **unless the request explicitly says desktop-only**.
  Concretely, changing `window.ld` means editing **together**: `src/shared/ipc.ts`,
  `src/preload/index.ts`, and `ipcMain.handle` in `src/main/index.ts` (desktop side) **and**
  the matching HTTP route under `src/server/http/routes/*` plus the HTTP shim
  `src/admin/ld-http.ts` (web side). Gate native-only affordances behind
  `ld().platform === 'web'` in the shared components rather than forking them — the single
  shared renderer is what guarantees the two never drift. See the IPC↔HTTP parity map in
  `docs/http-api.md`.

## Deploy / install (proven workflow — `docs/build-deploy.md`)
Docs-only changes need none of this. For an authorized local app update:
1. Build without publishing: `npm run package -- --publish never`.
2. Stage the complete bundle at an unused path; verify its signature and packaged
   `Contents/Resources/native/rename-no-replace` helper.
3. Wait for transfers to finish, then use the tray's **Quit LocalDrive**. Wait for
   server shutdown and process exit; never SIGKILL a running upload as routine deployment.
4. Keep the previous app bundle as rollback, activate the staged update, and
   `open -a /Applications/LocalDrive.app`. Preserve all configuration, database and drive data.
5. Confirm HTTP/HTTPS health and `capabilities.backgroundBackupTus = 1`. For web
   changes, also compare the served asset hash with the build.
6. Commit/push only when explicitly requested. See the full deploy playbook for details.

## Git
- Remote `github.com/sudiptab2100/LocalDrive-Master`, branch **`main`**. Rebase before push
  (`git fetch -q origin && git rebase origin/main && git push origin main`).
- Commit trailer (unless told otherwise):
  `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`

## Knowledge base index
Start at [`docs/README.md`](../docs/README.md). Key pages:
[architecture](../docs/architecture.md) ·
[project-structure](../docs/project-structure.md) ·
[data-model](../docs/data-model.md) ·
[security-rbac](../docs/security-rbac.md) ·
[http-api](../docs/http-api.md) ·
[ipc-api](../docs/ipc-api.md) ·
[frontend](../docs/frontend.md) ·
[build-deploy](../docs/build-deploy.md) ·
[background-backup](../docs/background-backup.md) ·
[features](../docs/features.md) ·
[conventions](../docs/conventions.md) ·
[glossary](../docs/glossary.md)
