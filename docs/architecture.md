# Architecture

LocalDrive is one Electron app made of five runtime surfaces plus an embedded
server. The server runs **inside the Electron main process**, so "start the app"
and "start the server" are the same process (the server can also run standalone
for development).

## Runtime surfaces

```
┌─────────────────────────── Electron app (one process tree) ───────────────────────────┐
│                                                                                        │
│  Main process (Node)                    Renderer (Chromium)                            │
│  src/main/index.ts                      src/renderer  ── Desktop control center (React)│
│   • Tray + window + lifecycle            │  tabs: Dashboard/Drives/Users/Connect/Setting│
│   • ipcMain.handle(...) handlers  ◄──────┘  calls window.ld.* (typed IPC)              │
│   • /Volumes hot‑plug watcher                    ▲                                      │
│   • owns ServerManager                           │ contextBridge                        │
│        │                                  src/preload/index.ts → exposes window.ld      │
│        ▼                                                                                │
│  Embedded server (src/server, same Node process)                                        │
│   Express app  ─ /api/*  REST                                                            │
│                ─ /dav/*  WebDAV (webdav-server)                                          │
│                ─ static  /admin (out/admin) + web PWA (out/webui)                         │
│   better-sqlite3 (WAL)  ·  tus uploads  ·  sharp thumbs  ·  bonjour mDNS  ·  node‑forge │
└────────────────────────────────────────────────────────────────────────────────────────┘
                         ▲ HTTP/HTTPS + WebDAV over the LAN
                         │
      Browsers (the PWA, src/webui) + Admin panel (/admin) + WebDAV clients
```

1. **Main process** (`src/main/index.ts`) — Node. Owns the tray, the control‑center
   window, app lifecycle (single‑instance lock, stay‑in‑tray on close, graceful quit),
   the `/Volumes` watcher for drive hot‑plug, all `ipcMain` handlers, and the
   `ServerManager` instance. In headless mode it hosts the server without creating the
   window, tray, or IPC bridge.
2. **Preload** (`src/preload/index.ts`) — a `contextBridge` that exposes a typed
   `window.ld` API to the renderer. It is the **only** bridge between renderer and main.
3. **Renderer** (`src/renderer`) — the desktop control center (React). Admin‑facing:
   start/stop server, share drives, manage users/approvals, view the dashboard, get the
   connect QR, change settings. Talks to main exclusively through `window.ld`.
4. **Web PWA** (`src/webui`) — the client app served to browsers on the LAN. End‑user
   file manager: browse/upload/download/preview/search within the caller's scope. Talks
   to the server over `/api/*` with a cookie session.
5. **Admin control panel** (`src/admin`) — browser SPA served at `/admin`. It reuses the
   exact desktop renderer components by installing an HTTP-backed `LocalDriveApi` as
   `window.ld`; desktop and web admin share one component codebase. It is admin-only and
   has full parity with the desktop control center, including lifecycle and settings.

The **embedded server** (`src/server`) is shared by all of the above. `getDashboard`,
drive registry, auth, and config are called both by HTTP routes and directly by IPC
handlers in the main process (no HTTP hop for the desktop UI).

## Server composition (`src/server/http/app.ts`)
`createApp()` wires middleware and routers in a **deliberate order**:

1. `attachUser` — resolve the caller (cookie / bearer / Basic) on every request; pending
   accounts resolve to unauthenticated.
2. `/api/upload` (**tus**) — mounted **before** the JSON body parser because tus needs
   the raw request stream.
3. **WebDAV gate** — any path starting with `/dav` is handed to the current WebDAV handler
   (or `503` if no drives are registered). Mounted at root so webdav-server sees the full
   `/dav/...` URL.
4. `express.json({ limit: '5mb' })` — for the REST routes below.
5. Unauthenticated utility routes: `GET /api/health`, `GET /api/cert`.
6. Feature routers: `/api/auth`, `/api/drives`, `/api/files`, `/api/search`, `/api/stats`,
   `/api/users`, `/api/server`, `/api/config`, `/api/access`, `/api/events`; plus
   `GET /api/connect` (auth’d, QR + URLs).
7. Static admin panel (`out/admin`) mounted at `/admin` with an SPA fallback that excludes
   `/api` and `/dav`; this is mounted before the client PWA catch-all.
8. Static PWA (`out/webui`) with an `index.html` SPA fallback that excludes `/api` and `/dav`.
9. JSON error handler.

See [http-api.md](http-api.md) for the full endpoint reference.

## Server lifecycle & no‑data‑loss restart (`src/server/index.ts`)
`ServerManager` owns the HTTP (and optional HTTPS) `http.Server` instances and the set
of open sockets.

**Start** (`start()`):
1. `loadConfig()` + `getDb()` (ensures schema/migrations).
2. `syncDrives()` — reconcile detected volumes with the persisted registry.
3. `backfillHomes()` — assign/normalize deterministic homes for legacy users and write
   portable manifests without granting ACLs or moving data.
4. `rebuildWebdav()` — build a WebDAV handler for the currently online registered drives.
5. Listen on `config.host:config.port`. If `httpsEnabled`, also load TLS material and
   listen on `httpsPort` (**degrades to HTTP‑only** if cert generation fails).
6. `startDiscovery()` (mDNS), compute `urls` (HTTPS first, then HTTP), `setStatus(...)`.

**Stop** (`stop(drainMs = 8000)`): stop discovery, `server.close()` to refuse new
connections, wait up to `drainMs` for in‑flight requests, then force‑destroy any lingering
sockets, **`checkpoint()`** the WAL to the main DB file, and mark status stopped. This is
what makes stop/restart lossless.

**Restart** = `stop()` then `start()`. **Shutdown** (app quit) = `stop(3000)` +
`closeDb()`. The main process calls `manager.shutdown()` in `before-quit` (guarded so it
runs once).

`ServerManager` also listens on the app event bus: when `drivesChanged` fires it rebuilds
the WebDAV mounts on the fly (no restart needed to add/remove a drive). While running,
it polls `lanAddresses()`; if the LAN IP set changes, shared `computeUrls()` refreshes
`status.urls` and `statusChanged` is emitted so the terminal banner and web admin panel
update without a restart. `getServerManager({ adminDir })` also threads the admin panel
static directory into the HTTP app.

## Event bus (`src/server/events.ts`)
A tiny `EventEmitter` (`bus`) with these events:
- `statusChanged` → emitted by `ServerManager` after meaningful start/stop transitions
  and after the address watch recomputes URLs. Main forwards it to the renderer; `/admin`
  receives it over SSE.
- `configChanged` → emitted after config saves; headless/standalone banners reprint and
  `/admin` receives it over SSE.
- `drivesChanged` → ServerManager rebuilds WebDAV; main forwards to the renderer
  (`evt:drivesChanged`) to refresh the Drives tab.
- `registrationsChanged` → main forwards to the renderer (`evt:registrationsChanged`),
  updates the pending‑approvals badge, and shows a desktop notification for new account
  requests.
- `accessRequestsChanged` → main forwards to the renderer (`evt:accessRequestsChanged`),
  updates the Users tab badge, and shows "New access request — <user> wants <drive>" for
  new drive access requests.
- `filesChanged` → emitted by `fileChanged()` (`src/server/changes.ts`) on file mutations
  (mkdir/rename/move/copy/delete/upload). Fans out to the user-scoped SSE stream
  `GET /api/events/user` and is persisted to the `changes` table for the
  `GET /api/changes` polling feed. Consumed by native clients (the mobile app) for live and
  background notifications; see [http-api.md](http-api.md).

## LAN discovery (`src/server/discovery.ts`)
`startDiscovery()` publishes several Bonjour/mDNS services so LAN clients can find the
server without typing an address:
- **`_localdrive._tcp`** — a dedicated, unambiguous service type for native clients (the
  mobile app) with TXT records `path`, `api`, `https` (`0`/`1`), `httpsPort`. Preferred
  over scanning every HTTP host.
- **`_http._tcp`** / **`_webdav._tcp`** (name "LocalDrive") — generic advertisements for
  browsers and WebDAV clients; HTTPS variants (`_https._tcp`, `_webdavs._tcp`) are added
  when HTTPS is enabled. Discovery stops on `ServerManager.stop()`.

## Standalone server mode (`src/server/standalone.ts`)
`npm run server:dev` runs the server with **no Electron** (via `tsx watch`). It bootstraps
the admin, starts the manager, serves the web PWA and `/admin`, prints the shared
connection banner, reprints it on `statusChanged`/`configChanged`, and installs
SIGINT/SIGTERM graceful shutdown. Honors `LOCALDRIVE_HOME` (isolated config/data — used
for tests), `LOCALDRIVE_WEBUI`, and `LOCALDRIVE_ADMIN` (prebuilt static dirs). This is the
fastest loop for server‑only work; packaged headless uses Electron so native modules match
the shipped app.

## Headless mode (`src/main/index.ts`)
The packaged app can run without a window or tray via:

```bash
/Applications/LocalDrive.app/Contents/MacOS/LocalDrive --headless
```

`--headless` or `LOCALDRIVE_HEADLESS=1` skips the BrowserWindow, tray, and IPC
registration, hides the Dock icon when possible, and runs the same `ServerManager` serving
the web UI plus `/admin`. It prints `formatConnectionBanner(...)` with status, bind host,
ports, share name, config dir, active connections, client URLs, admin panel URLs, and
first-run admin credentials when created; the banner reprints live on `statusChanged` and
`configChanged`. When attached to a TTY, `r` restarts and `q`/Ctrl-C quits. SIGINT/SIGTERM
shut down gracefully. Use `--reset-admin` or `LOCALDRIVE_ADMIN_PASSWORD` on headless start
to reset and print admin credentials if the password is lost.

## Data flow examples
- **Browser lists a folder:** PWA `api.list()` → `GET /api/files/list?drive&path&hidden`
  → `driveScope` maps the home‑relative path to a full drive path and checks `read` →
  `listDirectory` reads the FS, refreshes the search index, and returns entries with the
  home prefix stripped back off (`scope.out`).
- **Browser uploads a file:** Uppy (tus) → `POST/PATCH /api/upload` → tus stages the file
  under `~/Library/Application Support/LocalDrive/uploads/`, authorizes via
  `onUploadCreate`, then `onUploadFinish` calls `finalizeUpload` which `moveAtomic`s it
  onto the drive. See [http-api.md](http-api.md#uploads-tus).
- **Desktop shares a drive:** renderer `window.ld.drives.register(uuid)` → IPC →
  `registerDrive` → `bus.emit(drivesChanged)` → WebDAV rebuilds and both UIs refresh.
  Non‑admins then request the drive individually.
- **User requests drive access:** PWA `api.requestAccess(uuid)` →
  `POST /api/drives/request-access` → `requestAccess` records `access_requests` (or grants
  immediately if `autoApproveAccessRequests`) → `bus.emit(accessRequestsChanged)` → main
  notifies/refreshes the desktop Users tab. Admin approval calls `approveAccessRequest` /
  `grantDriveAccess`, creating or reusing `LocalDrive/<home>/`, writing `users.json`, and
  granting the user's home `write` ACL.

## Related
- Module‑by‑module detail: [project-structure.md](project-structure.md)
- Persistence: [data-model.md](data-model.md)
- Access control: [security-rbac.md](security-rbac.md)
