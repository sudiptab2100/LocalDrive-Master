# LocalDrive

Turn an external USB/HDD/SSD into a **private WiFi network drive**, controlled from a
native macOS app. Any device on the same WiFi (iPhone, iPad, Android, Mac, Windows) can
browse, upload, download, and stream your files through a browser or by mounting the drive
over WebDAV, or use the companion native mobile app. Files and configuration persist
across restarts, with atomic publication and graceful write draining; new drives can
be added at any time.

## Highlights

- **Native macOS app** (Electron) — a menu‑bar/tray control center. No Xcode required.
- **Browser admin control panel** — open `/admin` to manage the server from the same
  Dashboard/Drives/Users/Connect/Settings UI as the desktop app (admin-only).
- **Headless mode** — run the packaged app without a window/tray while serving the web UI,
  WebDAV, and `/admin`.
- **Three client options**
  - **Web UI** — an installable, mobile‑first PWA with dark mode (open `http://<your-mac>.local:<port>`).
  - **WebDAV** — mount as a normal drive in Finder / Windows Explorer / Android; each
    account is rooted at its own private home folder (admins get the whole drive).
  - **Native mobile app** — [LocalDrive-App](https://github.com/sudiptab2100/LocalDrive-App)
    for iOS/Android: discovery/QR connection, multiple accounts, drive requests,
    file management and account-owned photo/video/contact backup.
- **Accounts + per‑folder permissions (RBAC)** — read / read‑write / admin per user, per folder.
- **Self‑service sign‑up with admin approval** — visitors can register from the web login
  screen; new accounts stay **pending** (can't sign in or use WebDAV) until an admin approves
  them from the desktop **Users** tab. Admins get a desktop notification and a pending badge,
  and can flip on **auto‑approve** or fully **close registrations**. Usernames are
  case‑insensitive.
- **Optional encrypted HTTPS** — one‑click self‑signed TLS with a built‑in local
  certificate authority; install the root certificate once per device for a trusted
  padlock, and the server cert auto‑renews as your Wi‑Fi IP changes.
- **Opt‑in per‑drive spaces** — users see shared drives after login but request access per
  drive; admins approve from the desktop **Users** tab (or enable auto‑approve). Approval
  creates or reuses the user's deterministic `LocalDrive/<username>/` folder, portable
  across Macs via the drive's `.localdrive/users.json` manifest.
- **Admin dual‑mode browsing** — admins implicitly access every drive and can switch the
  web UI between **Admin view** (whole share) and **My space** (their own folder); WebDAV
  remains whole‑share for admins.
- **Resumable, large uploads** (tus protocol via Uppy) — pause/resume, drag‑and‑drop, progress.
- **Recoverable mobile backups** — owner-bound tus jobs, durable completion receipts,
  checksum verification and collision-safe publication without overwriting unrelated files.
- **Bulk actions + streaming ZIP** download of selected files/folders.
- **Thumbnails & inline preview** for images, PDFs, text, audio, and video (HTTP range requests).
- **Search** across filenames (SQLite FTS).
- **Multi‑drive + hot‑add** — drives are identified by a stable ID, so unplug/replug and
  restarts reattach automatically. Offline drives are flagged, never lost.
- **Discovery + QR connect** — Bonjour/mDNS advertising and a QR code to connect phones fast.
- **Dashboard** — storage per drive, transfer stats, activity log, connected sessions.
- **Graceful, no‑data‑loss restart** — atomic writes, WAL database with checkpoint on stop,
  and a drain‑then‑close shutdown.

## Requirements

- macOS on Apple Silicon (arm64).
- Node.js 20+ and npm (for building from source).
- Xcode Command Line Tools for the small native atomic-publication helper when building
  from source. The packaged app includes the helper; end users do not need a compiler.
- An external USB/HDD/SSD to share.

## Getting started (from source)

```bash
npm install          # installs deps and rebuilds native modules for Electron
npm run dev          # run the desktop app in development
```

### Build a double‑clickable app

```bash
npm run package -- --publish never  # unpacked .app -> release/mac-arm64/LocalDrive.app
npm run dist -- --publish never     # DMG + zip -> release/
```

> Local packaging is not a notarized distribution workflow. For trusted local builds,
> macOS may require right-click → **Open** or approval in **Privacy & Security**.
> Follow [build/deploy instructions](docs/build-deploy.md) for signature/helper checks,
> graceful shutdown and rollback-preserving updates.

## Using it

1. Launch **LocalDrive**. On first run it creates an **admin** account and shows the
   one‑time password — save it.
2. Go to the **Drives** tab and **Share** the external drive you want to serve.
3. Press **Start server** (top‑right). The status bar shows your address, e.g.
   `http://MyMac.local:4820`.
4. On another device on the same WiFi:
   - Open the **Connect** tab and scan the **QR code**, or type the URL into a browser.
   - Or mount the WebDAV URL (`http://MyMac.local:4820/dav`) in a WebDAV‑capable file
     manager, signing in with your LocalDrive username and password. If `.local` doesn't
     resolve on your device (e.g. some Android/Windows clients), use the Mac's LAN IP
     instead, e.g. `http://192.168.1.62:4820/dav`.
5. Create users in the **Users** tab or let people **register their own account** from
   the web login page — account requests show up for **Approve**/**Reject** (or enable
   registration auto‑approve). After signing in, non‑admins can see all registered drives
   but must request access to each one; approve drive requests in the **Drive access
   requests** card (or enable **Auto‑approve drive access requests**).

Files are stored on the drive under a `LocalDrive/` folder. Approved users get a private,
deterministic `LocalDrive/<username>/` userspace that is reused when the same physical
drive is shared from another Mac; per‑drive metadata (index, thumbnails, in‑progress
uploads, portable `users.json` manifest) lives in a hidden `.localdrive/` folder on the
same drive. Admins see the whole `LocalDrive/` by default and can switch the web UI to
**My space** when they want only their own folder.
Central settings, accounts, and the drive registry live in
`~/Library/Application Support/LocalDrive/`. Admins can also open `http://<host>:<port>/admin`
to use the browser control panel.

### Native mobile backup

Install [LocalDrive-App](https://github.com/sudiptab2100/LocalDrive-App), sign in,
request drive access if needed, and configure a destination for that account.
Automatic preparation defaults to Wi-Fi and charging; **Back up now** bypasses
charging only. Backups use private user space even for administrators.

The server advertises `capabilities.backgroundBackupTus = 1` from `/api/health`.
File bytes continue to use tus `/api/upload`; the additive
`GET /api/backup/uploads/:jobId` endpoint recovers progress and durable completion
receipts after interruptions or lost responses. Existing browser/WebDAV clients
keep their normal behavior.

iOS schedules scanning windows and uses native transfers for prepared files; it does
not promise continuous execution or exact timing. Force-quitting the mobile app
prevents automatic relaunch until reopened. The Mac must remain awake/reachable and
the destination mounted. See the [backup protocol and durability limits](docs/background-backup.md)
and the [mobile guide](https://github.com/sudiptab2100/LocalDrive-App/blob/development/docs/notifications-backup.md).


### Headless mode
Run the packaged app without the desktop window/tray:

```bash
/Applications/LocalDrive.app/Contents/MacOS/LocalDrive --headless
```

Headless mode prints a live connection banner with client URLs, `/admin` URLs, status,
ports, config location, and first-run admin credentials when created. When attached to a
terminal, press `r` to restart or `q`/Ctrl-C to quit. If the admin password is lost, start
with `--reset-admin` or set `LOCALDRIVE_ADMIN_PASSWORD` to reset and print it.

## Project layout

```
src/
  main/        Electron main process (tray, window, IPC, drive hot‑plug watcher)
  preload/     contextBridge API exposed to the renderer (window.ld)
  renderer/    Shared desktop/admin control‑center UI (React)
  admin/       Browser admin panel shell + HTTP window.ld shim
  webui/       Client web PWA served to browsers (React + Uppy)
  server/      Embedded HTTP/WebDAV server, auth/RBAC, file ops, uploads, discovery
  shared/      Types and the IPC contract shared across all of the above
```

## Scripts

| Script                | What it does                                             |
| --------------------- | ------------------------------------------------------- |
| `npm run dev`         | Run the Electron app in development                     |
| `npm run build`       | Build the web PWA + admin panel + Electron bundles into `out/` |
| `npm run build:webui` | Build only the client PWA                               |
| `npm run build:admin` | Build only the browser admin panel                     |
| `npm run build:atomic-helper` | Build the universal no-replace publication helper (included in full builds) |
| `npm run server:dev`  | Run the server standalone (no Electron) with hot reload |
| `npm run typecheck`   | Type‑check the whole codebase                           |
| `npm run package`     | Produce an unpacked `.app`                              |
| `npm run dist`        | Produce a DMG + zip                                     |
| `npm run rebuild`     | Rebuild native modules for Electron                     |

## Security notes

- Web sessions use a signed, httpOnly cookie; WebDAV uses HTTP Basic/Digest.
- **Plain HTTP sends credentials in the clear on your LAN.** Turn on **Enable HTTPS**
  in **Settings** to serve an encrypted listener (default port `4843`) alongside HTTP.
  LocalDrive runs a small local certificate authority: install the root certificate
  once per device (**Settings ▸ Download certificate**, or `GET /api/cert`) for a
  trusted padlock. The server certificate auto‑renews when your LAN IP changes — no
  need to re‑trust anything. HTTPS also unlocks full PWA install/offline support,
  which browsers only allow over a secure origin.
- Bind address defaults to `0.0.0.0` (whole LAN). Switch to `127.0.0.1` in **Settings** to
  restrict access to this Mac only.

## Roadmap ideas

Public share links (expiry + password), trash/version history,
two‑way sync client, media transcoding, per‑user quotas + SMART health
alerts, duplicate finder, guest drop‑box links, and secure off‑LAN access (Tailscale/WireGuard).

## Documentation

Start with the [knowledge base](docs/README.md), [HTTP API](docs/http-api.md),
[background-backup contract](docs/background-backup.md), and
[Copilot working brief](.github/copilot-instructions.md).

## License

MIT
