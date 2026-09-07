# Feature catalog & status

Legend: ✅ implemented & wired · 🟡 partial / backend‑only · 🗺️ roadmap (scaffolding
present, not wired). When you touch an area, **update this file** so the roadmap stays
honest.

## Core storage & sharing
| Feature | Status | Notes |
| --- | --- | --- |
| Turn an external drive/folder into a Wi‑Fi network drive | ✅ | HTTP browser UI + WebDAV |
| Multiple drives registered at once | ✅ | Each has its own `uuid`; switch in both UIs |
| Add a **custom folder** (not just `/Volumes`) as a drive | ✅ | Desktop only (`drives.addFolder`) |
| Hot‑plug detect / online‑offline | ✅ | `/Volumes` watcher → `drivesChanged`; WebDAV remounts without restart |
| Down/up with **no data loss** | ✅ | Atomic writes, WAL checkpoint, socket drain — see [conventions.md](conventions.md) |
| Opt‑in per‑drive private spaces | ✅ | Users request each drive; admin approval grants a private `LocalDrive/<home>/` |

## Access from client devices
| Feature | Status | Notes |
| --- | --- | --- |
| Browser file manager (list/upload/download/rename/move/copy/delete/mkdir) | ✅ | [http-api.md](http-api.md) |
| Installable **PWA** | ✅ | `vite-plugin-pwa`, add‑to‑home‑screen |
| **Resumable** chunked uploads | ✅ | tus + Uppy; survives network drops |
| Drag‑and‑drop upload | ✅ | Full‑window drop zone |
| ZIP download of a selection | ✅ | `/api/files/zip` |
| Image thumbnails / inline preview | ✅ | `sharp` WebP thumbs, cached |
| Full‑text **search** by filename | ✅ | SQLite FTS5, lazily indexed |
| Grid / list views, hidden‑file toggle, dark/light theme | ✅ | Persisted in `localStorage` |
| **WebDAV** mount (`/dav/<Drive>/`) | ✅ | Per‑user rooted; HTTP Basic; works on Android/desktop clients |
| Connect helper (URLs + **QR code**) | ✅ | `/api/connect`, desktop Connect tab |
| Phone photo/video/contact backup | ✅ | Native **LocalDrive-App**: account-owned durable queue, iOS BGProcessing/background URLSession and Android WorkManager; OS scheduling limits apply |
| Recoverable mobile tus jobs | ✅ | `backgroundBackupTus = 1`, owner-only receipts, SHA-256 verification, no-clobber publication and idempotent accounting; see [background-backup.md](background-backup.md) |
| Native **mobile app** (iOS/Android) | ✅ | Separate repo `LocalDrive-App`: mDNS/QR/manual connect, files, admin console, notifications, auto‑backup |
| mDNS service for native discovery | ✅ | `_localdrive._tcp` advertised alongside `_http._tcp` (TXT: path/api/https/httpsPort) |
| User‑scoped live events (SSE) | ✅ | `GET /api/events/user` (cookie **or** bearer) — `filesChanged`/`accessChanged`/`drivesChanged` for the app |
| Background changes feed | ✅ | `GET /api/changes?since=` compact polling feed for background notifications |

## Accounts, security, admin
| Feature | Status | Notes |
| --- | --- | --- |
| Username/password login (bcrypt + JWT cookie) | ✅ | [security-rbac.md](security-rbac.md) |
| First‑run auto‑created admin (one‑time creds) | ✅ | `bootstrap()` |
| **Self‑registration** with admin approval | ✅ | Pending users blocked until approved |
| **Auto‑approve** registrations toggle | ✅ | `autoApproveRegistrations` in Settings |
| Roles: admin / user | ✅ | Admins bypass ACLs |
| Per‑user home **confinement** | ✅ | `driveScope` + `safeResolve` |
| RBAC ACLs (`read`/`write`/`admin`, path‑prefix) | ✅ | Drive request/approve UI grants per‑user/per‑drive home ACLs; raw ACL endpoints remain admin‑only |
| **Auto‑approve** drive access toggle | ✅ | `autoApproveAccessRequests` in the Users tab |
| Admin web **view mode** | ✅ | Admin view (whole share) ↔ My space via restrict‑only `ld_view` cookie |
| Self‑signed **HTTPS** with local CA | ✅ | `tls.ts`; `/api/cert` to trust; auto‑reissue leaf |
| Activity log + transfer stats | ✅ | Dashboard |

### How multi-drive sharing actually works (important)
Sharing is opt‑in per drive:
- Registering a drive only shares it with the system; it does not grant any non‑admin user
  access.
- After login, non‑admins see all registered drives in the switcher, but locked drives show
  a request‑access panel instead of files. States are `none`, `pending`, `denied`, and
  `granted`.
- A request appears in the desktop Users tab's **Drive access requests** card. Approval
  grants a `write` ACL on the user's deterministic home path and creates or reuses
  `LocalDrive/<home>/`; denial records the request and revokes that home ACL.
- The **Auto‑approve drive access requests** switch (`autoApproveAccessRequests`) grants
  requests immediately, mirroring registration auto‑approval.
- Deterministic homes (`sanitizeHomeName(username)`) and `.localdrive/users.json` make
  userspaces portable across Macs: sharing the same physical drive from another PC
  reconnects the user to the existing folder.
- Admins implicitly access all drives. In the web UI they can switch between **Admin view**
  (whole share, default) and **My space** (their own `LocalDrive/<home>/`) via the
  restrict‑only `ld_view` cookie; WebDAV remains whole‑share for admins.
- Web clients aren't on the Electron event bus, so the web UI refetches the drive list on
  focus/visibility (+ a light interval); newly registered drives and access decisions
  appear without a reload.

## Roadmap / not‑yet‑wired (scaffolding present)
| Item | Status | Evidence |
| --- | --- | --- |
| Public **share links** | 🗺️ | `shares` table exists in the schema; no route/UI |
| **Trash** / recycle bin | 🗺️ | `.localdrive/trash/` dir reserved; deletes are permanent today |
| File **versioning** | 🗺️ | `.localdrive/versions/` dir reserved; not written |
| Selective arbitrary subfolder ACL management UI | 🗺️ | Home ACL request/approval is wired; arbitrary subfolder ACL UI is not |

> If you implement one of these, move it up the table and update
> [data-model.md](data-model.md) / [http-api.md](http-api.md) accordingly.

## Related
- Deep security semantics: [security-rbac.md](security-rbac.md)
- On‑disk layout & tables: [data-model.md](data-model.md)
