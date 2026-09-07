# Project structure

Every path is under `src/` unless noted. Aliases: `@shared` → `src/shared`,
`@renderer` → `src/renderer/src`, `@webui` → `src/webui/src`, `@admin` → `src/admin`.

## Top-level layout
```
src/
  main/       Electron main process (Node)
  preload/    contextBridge → window.ld
  renderer/   Desktop/admin control-center UI components (React)
  admin/      Browser admin panel shell + HTTP window.ld shim
  webui/      Client web PWA (React + Uppy/tus)
  server/     Embedded HTTP/WebDAV server + all backend logic
  shared/     Types + IPC contract shared across all of the above
electron.vite.config.ts   Build config for main/preload/renderer
vite.webui.config.ts      Build config for the web PWA (+ PWA/service worker)
vite.admin.config.ts      Build config for the /admin SPA (no service worker)
tsconfig.node.json        Type-check project for main/preload/server/shared
tsconfig.web.json         Type-check project for renderer + webui + admin
build/                    App icon + tray template images (packaged as resources)
scripts/                  Native helper build and isolated backup regression runner
```

## `src/main` — Electron main process
- **`index.ts`** — the whole main process. Responsibilities:
  - Window (`hiddenInset` title bar, `contextIsolation: true`, preload bridge) and tray
    (menu with start/stop/restart, tooltip). Closing the window **hides to tray**; the app
    quits only via the tray "Quit" or `app.quit()` with `isQuitting`.
  - Single‑instance lock; `second-instance`/`activate` re‑show the window.
  - `watchVolumes()` — `fs.watch('/Volumes')` (override: `LOCALDRIVE_VOLUMES_DIR`),
    debounced re‑`syncDrives()` + notify the renderer on plug/unplug.
  - `registerIpc()` — every `ipcMain.handle(...)`; see [ipc-api.md](ipc-api.md).
  - First‑run bootstrap + optional auto‑start; forwards `bus` events to the renderer;
    prints the live connection banner in headless mode; supports `--reset-admin` recovery;
    `before-quit` → `manager.shutdown()`.
  - Error resilience: `uncaughtException`/`unhandledRejection` and startup failures are
    appended to `<configDir>/logs/main.log` (packaged apps have no terminal).

## `src/preload`
- **`index.ts`** — builds the `LocalDriveApi` object (thin `ipcRenderer.invoke` wrappers +
  `on/removeListener` for push events) and `contextBridge.exposeInMainWorld('ld', api)`.
  The typed surface is `LocalDriveApi` in `src/shared/ipc.ts`. **Edit these three files
  together** when changing the IPC contract.

## `src/renderer` — desktop control center
- **`main.tsx`** — React entry; wraps `<App/>` in `ToastProvider`.
- **`App.tsx`** — top bar (server status + Start/Stop/Restart), first‑run bootstrap banner,
  tabs (`Dashboard`, `Drives`, `Users`, `Connect`, `Settings`) with a pending badge that
  includes account and drive access requests; subscribes to `window.ld`
  status/drives/registration/access events.
- **`components.tsx`** — the tab panels: `DrivesPanel`, `DashboardPanel`, `UsersPanel`
  (+ `UserRow`, `AddUserModal`, `ResetPasswordModal`, drive access request cards),
  `ConnectPanel`, `SettingsPanel`.
- **`ui.tsx`** — reusable primitives: `ToastProvider`/`useToast`, `Modal`, `ConfirmDialog`,
  `Switch`, `Avatar`, `Menu`, `PasswordInput`.
- **`util.ts`**, **`global.d.ts`** — helpers and the `window.ld` type declaration.


## `src/admin` — browser admin control panel
- **`index.html`** — Vite entry served under `/admin` (script `./main.tsx`).
- **`main.tsx`** — installs the HTTP `LocalDriveApi` shim as `window.ld`, wraps the shared
  renderer `<App/>` in `ToastProvider`, imports `@renderer/styles.css`, and gates access:
  `GET /api/auth/me`, `AdminLogin` via `POST /api/auth/login`, non-admin logout +
  "Administrators only", and an `ld:reconnect` banner after server moves/restarts.
- **`admin.css`** — login and reconnect-banner styles only; the app shell reuses desktop
  renderer CSS.
- **`ld-http.ts`** — HTTP/SSE-backed implementation of `LocalDriveApi` (`platform: 'web'`)
  so `/admin` and the desktop control center share the same components.

## `src/webui` — client PWA (served to browsers)
- **`index.html`**, **`public/`** — HTML shell + icons/manifest assets.
- **`src/main.tsx`** — React entry; imports `./styles.css` (only).
- **`src/App.tsx`** — the entire client app: login/register screen, drive switcher with
  locked non‑granted drives, request‑access panel, admin view toggle, file list/grid,
  breadcrumb, selection + bulk actions, search modal, preview modal, styled prompt/confirm
  dialogs, and the custom `UploadModal` (Uppy core + tus). Inline SVG icons.
- **`src/api.ts`** — typed `fetch` client for `/api/*` (`credentials: 'include'`), including
  `requestAccess`, plus `fileUrl`/`zipUrl` helpers and response types.
- **`src/utils.ts`** — `formatBytes`, `formatDate`, `parentPath`, `joinPath`, `iconFor`,
  `isTextLike`.
- **`src/styles.css`** — design tokens + all component/responsive styles.

## `src/server` — embedded backend
Entry/lifecycle:
- **`index.ts`** — `ServerManager` (start/stop/restart/shutdown, dual HTTP/HTTPS, socket
  draining, WebDAV rebuild on drive changes) + `getServerManager()` singleton.
- **`standalone.ts`** — run the server without Electron (`npm run server:dev`).
- **`status.ts`** — in‑memory `ServerStatus` (`get/setStatus`).
- **`events.ts`** — the app event `bus` + `EVENTS`.
- **`config.ts`** — `AppConfig` defaults, `Paths`, `loadConfig`/`saveConfig` (atomic),
  `localHostname()`. Config dir = `~/Library/Application Support/LocalDrive`
  (override: `LOCALDRIVE_HOME`).

HTTP layer (`server/http/`):
- **`app.ts`** — `createApp()` (middleware/router wiring; `setWebdavHandler`; static
  `/admin` when `adminDir` is provided, before the PWA catch-all).
- **`middleware.ts`** — `attachUser`, `resolveUser(Raw)`, `requireAuth`, `requireAdmin`,
  `requirePermission`; the `ld_token` cookie name.
- **`scope.ts`** — `driveScope(req, driveUuid)` → `{ home, in(), out() }` confinement,
  including admin web view mode from the restrict‑only `ld_view` cookie.
- **`routes/`** — `auth.ts`, `drives.ts`, `files.ts`, `uploads.ts` (tus), `backup.ts`
  (owner-scoped recovery/receipts), `search.ts`,
  `stats.ts`, `users.ts`, `server.ts`, `config.ts`, `access.ts`, `events.ts`.

Auth / users / access:
- **`auth.ts`** — bcrypt hashing, JWT sign/verify, user CRUD, `createPendingUser`/
  `approveUser`, deterministic `homeNameFor`, home collision checks, RBAC
  (`setAcl`/`effectivePermission`/`hasPermission`), `getUserHome`, `bootstrapAdmin`.
- **`access.ts`** — opt‑in per‑drive access workflow: access maps, request/approve/deny,
  auto‑approval, pending counts, home ACL grant/revoke, and request change events.
- **`provisioning.ts`** — deterministic home folder reuse/creation, `userSpaceExists`,
  `users.json` manifest, `backfillHomes` startup normalization (no ACL grants).

Drives:
- **`drives/detect.ts`** — enumerate `/Volumes`, `diskutil info -plist` per volume, stable
  UUID, shareability classification (readonly/system/diskimage).
- **`drives/registry.ts`** — reconcile detected vs persisted drives; register/unregister;
  register a custom folder (`folder:` UUID); resolve share root / app dir; `resolveInDrive`
  (safe path resolution); ensure the on‑disk layout.

Files / uploads / search:
- **`files.ts`** — `listDirectory` (+ search indexing), `makeDir`, `renameEntry`,
  `moveEntries`, `copyEntries`, `deleteEntries`, `finalizeUpload`, `searchFiles` (FTS).
- **`http/routes/files.ts`** — REST for the above + `download`/`raw` (HTTP range),
  `zip` (streaming archiver), `thumb` (sharp, cached under `.localdrive/thumbs`).
- **`http/routes/uploads.ts`** — tus server config + auth/authorize/finalize hooks.
- **`backup-uploads.ts`** — backup-aware tus storage, receive/finalization locking,
  recovery and collision-safe publication.
- **`db/backup-uploads.ts`** — durable owner/job/upload mappings, publication intents,
  receipts and exactly-once completion accounting.

Networking / security / misc:
- **`webdav.ts`** — build a per‑user, home‑rooted WebDAV handler over the registered drives.
- **`discovery.ts`** — Bonjour/mDNS advertising + `qrDataUrl`.
- **`tls.ts`** — local CA + auto‑renewing leaf cert for the HTTPS listener.
- **`db/index.ts`** — SQLite (WAL) schema + migrations, `getDb`, `checkpoint`, `closeDb`,
  `bumpStat`/`getStats`, `logActivity`.
- **`dashboard.ts`** — assemble the dashboard payload (transfers, drives, status, activity).
- **`util/`** — `fs-safe.ts` (path confinement + name sanitizing), `atomic.ts`
  (`moveAtomic` and no-clobber backup publication), `rename-no-replace.c`
  (macOS exclusive-rename fallback), `net.ts` (LAN IPs, URL building, QR pick), `paths.ts` (`parentOf`),
  `report.ts` (shared headless/standalone connection banner).

## `src/shared` — cross-process contracts
- **`types.ts`** — domain types: `Role`, `Permission`, `UserStatus`, `User`, `DriveInfo`,
  `AccessRequest`, `FileEntry`, `Acl`, `ServerStatus`, `TransferStat`, `ActivityRecord`,
  `AuthResult`, `RegisterResult`.
- **`ipc.ts`** — the `IPC` channel‑name map, `LocalDriveApi` (the `window.ld` shape), and
  IPC view types (`UserWithAcls`, `DashboardData`, `ConnectInfo`, `AppConfigView`).

## Build outputs (`out/`, git‑ignored)
```
out/main/index.cjs        out/preload/index.cjs
out/renderer/…            out/webui/…  (index.html, assets/index-*.{js,css}, sw.js, workbox-*.js)
out/admin/…               (/admin SPA, no service worker)
out/native/rename-no-replace
```
`electron-builder` packages `out/**` into `release/` (DMG + zip). The web PWA and admin
panel are copied to the app bundle as extra resources (`webui`, `admin`), which the server
serves as static files.
The native helper is also copied to `Contents/Resources/native` and signed with the app.
`scripts/build-atomic-helper.mjs` builds it; `scripts/background-backup-regression.ts`
exercises recovery using isolated temporary accounts/storage, never the running NAS.
