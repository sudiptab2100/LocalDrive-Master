# HTTP & WebDAV API reference

Base URL: `http://<host>:4820` (and `https://<host>:4843` when HTTPS is enabled).
All `/api/*` JSON routes are defined under `src/server/http/`. Unless noted, requests
authenticate via the `ld_token` cookie or `Authorization: Bearer <jwt>`; errors return
`{ "error": string }` with a 4xx/5xx status.

Common concepts:
- **`drive`** = a registered drive `uuid`.
- **`path`** = **home‑relative** POSIX path (what the client sees; `''`/`/` = the caller's
  root). The server maps it to a full drive path via `driveScope` and strips it back on
  the way out. For admins in the web UI, the `ld_view` cookie can restrict scope from
  whole‑share (`admin`, default/absent) to their own userspace (`user`); it never widens
  non‑admin access. See [security-rbac.md](security-rbac.md).
- **Hidden files**: dotfiles / macOS `._` sidecars are excluded unless `hidden=1`;
  `.localdrive` is *always* excluded.

## Auth — `/api/auth` (`routes/auth.ts`)
| Method | Path | Auth | Body / query | Returns |
| --- | --- | --- | --- | --- |
| POST | `/login` | public | `{ username, password }` | `{ token, user }` + sets `ld_token`; `401` invalid, `403 {pending:true}` if awaiting approval |
| GET | `/config` | public | — | `{ registrationEnabled }` |
| POST | `/register` | public | `{ username, password }` | `{ pending:true, message }` **or** `{ pending:false, token, user }` (auto‑approve). `403` if closed; `409` duplicate; `400` validation |
| POST | `/logout` | public | — | `{ ok:true }`, clears cookie |
| GET | `/me` | auth | — | `{ user }` |
| GET | `/bootstrap` | public | — | `{ created: {username,password} \| null }` (first‑run only) |

Validation on register: username ≥ 3 chars and sanitizes to a non‑empty home; password ≥ 6.

## Drives — `/api/drives` (`routes/drives.ts`)
| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/` | auth | Returns **all registered drives** as `{ drives: DriveInfo[] }` (includes `totalBytes`/`freeBytes` and `access: 'granted' | 'pending' | 'denied' | 'none'`). Admins are all `granted`; non‑admins are `granted` only if `getUserHome(user,uuid) != null`, otherwise the state comes from `getAccessMap` or `none`. No self‑provisioning. |
| GET | `/all` | **admin** | Every detected drive (registered or not) for management. |
| POST | `/register` | **admin** | `{ uuid }` → registers the drive and emits drive changes; it does not grant user access. `400` if not found / unshareable. |
| POST | `/request-access` | auth | `{ uuid }` → non‑admins request that registered drive; returns `{ access: 'pending' }` or `{ access: 'granted' }` if auto‑approved. Admins return `{ access:'granted' }`. `400` on missing/invalid uuid. |
| POST | `/unregister` | **admin** | `{ uuid }` → unshare (custom folders are removed entirely). |
| POST | `/register-folder` | **admin** | `{ path }` → validates an **absolute** server path, registers it as a custom folder, returns `{ drive }`. |

Adding a **custom folder** is available to admins over HTTP via `register-folder`; revealing a
drive is desktop‑only (IPC/Finder) — see [ipc-api.md](ipc-api.md).

## Files — `/api/files` (`routes/files.ts`)
All require auth **and** an RBAC check (`hasPermission`) on the scoped path. Mutations
that target an entry check `write` on its **parent**, and refuse to act on the home root.

| Method | Path | Perm | Params | Notes |
| --- | --- | --- | --- | --- |
| GET | `/list` | read | `?drive&path&hidden` | `{ path, entries: FileEntry[] }`; folders first, then name sort; also refreshes the search index. |
| POST | `/mkdir` | write | `{ drive, path, name }` | Creates `path/name` (validated by `isSafeName`). |
| POST | `/rename` | write (parent) | `{ drive, path, newName }` | Refuses the home root. |
| POST | `/move` | write (dest + each source parent) | `{ drive, sources[], dest }` | Same drive; `dest=''` = root. |
| POST | `/copy` | read (source) + write (dest) | `{ drive, sources[], dest }` | Recursive copy. |
| POST | `/delete` | write (parent) | `{ drive, paths[] }` | Recursive delete; refuses the home root. |
| GET | `/download` | read | `?drive&path` | Streams as attachment; supports HTTP `Range` (206). |
| GET | `/raw` | read | `?drive&path` | Same but `Content-Disposition: inline` (for preview). |
| GET | `/zip` | read (each) | `?drive&paths` | `paths` = newline‑separated; streams a ZIP (archiver). |
| GET | `/thumb` | read | `?drive&path&size` | WebP thumbnail for images (sharp), `size` clamped 32–512, cached under `.localdrive/thumbs`. `415` for non‑images. |

`download`/`raw`/`zip` bump `bytes_out`/`downloads` stats on completion.

## Uploads (tus) — `/api/upload` (`routes/uploads.ts`)  {#uploads-tus}
Resumable, chunked uploads via the **tus** protocol (`@tus/server` + `FileStore`). Mounted
**before** the JSON body parser (needs the raw stream). The web client uses Uppy core +
`@uppy/tus`.

- **Metadata** the client must send: `filename`, `drive`, `path` (home‑relative dest dir).
- **Auth** (`onIncomingRequest`): every tus request (create/patch/head) must resolve to an
  active user, else `401`.
- **Authorization** (`onUploadCreate`): `drive` present, `getUserHome != null`, and
  `write` permission on the scoped destination, else `403`.
- **Finalize** (`onUploadFinish`): `finalizeUpload` moves the staged file
  (`<configDir>/uploads/<id>`) onto the drive **atomically** (`moveAtomic`: same‑FS
  `rename`, cross‑device copy‑to‑temp‑then‑rename), removes the tus sidecar, and bumps
  `bytes_in`/`uploads`. An interrupted upload can resume; a crash never leaves a partial
  file at the destination.

## Search — `/api/search` (`routes/search.ts`)
| Method | Path | Auth | Params | Notes |
| --- | --- | --- | --- | --- |
| GET | `/` | auth | `?q&drive?&hidden?` | FTS5 prefix match on filename over the lazily‑built index. |

Results are filtered to the caller's home and read permission, with the home prefix
stripped; `.localdrive` and (unless `hidden=1`) dotfiles are excluded. Capped at 100 hits.
Returns `{ query, hits: {drive,name,path,isDir}[] }`.

## Stats — `/api/stats` (`routes/stats.ts`)
| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/` | auth | The dashboard snapshot (`getDashboard`). Admin‑only fields (activity log, users count) are included only for admins. |

## Users & ACLs — `/api/users` (`routes/users.ts`, **admin‑only**)
| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/` | — | `{ users: (User & {acls})[] }` |
| POST | `/` | `{ username, password, role? }` | Create a user with deterministic home; no drive ACLs are granted. `409` on username or sanitized home collision. |
| DELETE | `/:id` | — | Delete (can't delete yourself; rejecting a pending user emits an event). |
| POST | `/:id/approve` | — | Activate a pending user; drive access remains opt‑in/requested separately. |
| POST | `/:id/password` | `{ password }` | Reset password. |
| POST | `/:id/role` | `{ role }` | `admin` \| `user`. |
| GET | `/acls` | — | List all ACLs. |
| POST | `/acls` | `{ userId, drive, pathPrefix?, permission }` | Upsert an ACL. *(Endpoint exists but no desktop UI calls it yet — see [features.md](features.md).)* |
| DELETE | `/acls/:id` | — | Remove an ACL. |

## Server control — `/api/server` (`routes/server.ts`, **admin-only**)
| Method | Path | Notes |
| --- | --- | --- |
| POST | `/start` | Starts the server and returns `{ status }`. |
| POST | `/stop` | Replies with `{ status }`, then stops on `setImmediate` so the response is not cut off. |
| POST | `/restart` | Replies with `{ status }`, then restarts on `setImmediate`. |

Stopping from the browser admin panel also stops the origin serving that panel; use
Restart for normal settings changes.

## Config — `/api/config` (`routes/config.ts`, **admin-only**)
| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/` | — | `AppConfigView` |
| PATCH | `/` | Partial `AppConfigView` | `{ config, restarted }` |

Editable keys: `shareRootName`, `autoStart`, `registrationEnabled`,
`autoApproveRegistrations`, `autoApproveAccessRequests`, `port`, `host`, `httpsEnabled`,
`httpsPort`. Values are validated/coerced before saving. Changing a **restart key**
(`port`, `host`, `httpsEnabled`, `httpsPort`) triggers `ServerManager.restart()` and
returns `restarted: true`; other changes return `restarted: false`. Successful saves emit
`configChanged`.

## Access requests — `/api/access` (`routes/access.ts`, **admin-only**)
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/` | List pending drive access requests as `{ requests }`. |
| POST | `/:id/approve` | Approve the request using `approveAccessRequest`. |
| POST | `/:id/deny` | Deny the request using `denyAccessRequest`. |

## Server-Sent Events — `/api/events` (`routes/events.ts`)
`GET /api/events` (**admin-only**) opens an SSE stream for the browser admin panel.
EventSource cannot send custom headers, so it authenticates with the same-origin httpOnly
`ld_token` cookie set by `/api/auth/login`. Named events: `statusChanged`, `drivesChanged`,
`registrationsChanged`, `accessRequestsChanged`, and `configChanged`. The stream also sends
a keepalive comment about every 25 seconds.

`GET /api/events/user` (**auth**) is a **user-scoped** live stream for native clients (the
mobile app). It authenticates via cookie **or** `Authorization: Bearer <token>` like every
other route. After an initial `hello`, it emits:

| Event | Payload | When |
| --- | --- | --- |
| `filesChanged` | `{ drive, path, action, by, at }` | A file the caller can **read** changed. `path` is mapped into the caller's own scope (`scopeOut`); admins in `user` view see only their home, in `admin` view the whole share. Filtered by `hasPermission(read)`. |
| `accessChanged` | `{}` | A drive access request/grant changed — the client refetches `GET /api/drives`. |
| `drivesChanged` | `{}` | The drive registry changed — the client refetches drive lists. |

Keepalive comment every ~25 s. Used for real-time notifications while the app is foregrounded.

## Changes feed — `/api/changes` (`routes/changes.ts`)
`GET /api/changes?since=<iso>` (**auth**, cookie or bearer) is a compact polling feed for
**background sync** — the mobile app wakes periodically (WorkManager/BGTask) and surfaces
new activity as local notifications without holding an SSE connection.

- Without `since`, returns `{ changes: [], cursor }` where `cursor` is the current time, so
  a first poll never floods the client with history. Subsequent polls pass the previous
  `cursor` back as `since`.
- With `since`, returns `{ changes, cursor }` where each change is either a **file** the
  caller can read — `{ id, kind:'file', action, drive, path, by, at }` with `path` mapped
  into the caller's scope and gated by `hasPermission(read)` — or a generic
  `{ id, kind:'access'|'drive', action, at }` ping. Capped at 300 rows.

Backed by the `changes` table (`db/index.ts`: `recordChange`/`getChangesSince`); file
mutations record a change via `fileChanged()` (`server/changes.ts`) which also emits on the
event bus for `/api/events` and `/api/events/user`.

## Utility routes (in `app.ts`)
| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/api/health` | public | `{ ok:true, status: ServerStatus }` — used by the deploy health poll. |
| GET | `/api/cert` | public | Root CA cert (`application/x-x509-ca-cert`) for client trust install; `404` if HTTPS never enabled. |
| GET | `/api/connect` | auth | `{ urls, hostname, qr, addresses, httpsEnabled, port, httpsPort }` — structured pieces so the client composes a URL (protocol · host · service) and renders the QR locally; `urls`/`qr` kept as fallback. |

## WebDAV — `/dav` (`src/server/webdav.ts`)
- Mount a drive at `http://<host>:4820/dav/<DriveName>/` with a WebDAV client, signing in
  with a LocalDrive username + password (HTTP Basic).
- Each account is **rooted at its own home** (admins get the whole share); permissions use
  the same RBAC as the API. Pending accounts are rejected.
- Returns `503` when no drives are registered. See
  [security-rbac.md](security-rbac.md#webdav-specifics-srcserverwebdavts) for internals.

## Static PWA
Any non‑`/api`, non‑`/dav` path serves the built web app (`out/webui`) with an
`index.html` SPA fallback.


## IPC ↔ HTTP parity map
The browser admin panel installs an HTTP-backed `window.ld` shim (`src/admin/ld-http.ts`)
for the same `LocalDriveApi` used by the desktop preload bridge.

| `window.ld` method | Electron IPC channel | Admin HTTP/SSE mapping |
| --- | --- | --- |
| `server.status()` | `server:status` | `GET /api/health` → `status` (public health route) |
| `server.start()` | `server:start` | `POST /api/server/start` |
| `server.stop()` | `server:stop` | `POST /api/server/stop` |
| `server.restart()` | `server:restart` | `POST /api/server/restart` |
| `server.bootstrap()` | `server:bootstrap` | Desktop-only; returns `null` on web |
| `server.onStatus(cb)` | `evt:status` | SSE `statusChanged` from `GET /api/events` |
| `drives.listAll()` | `drives:listAll` | `GET /api/drives/all` |
| `drives.register(uuid)` | `drives:register` | `POST /api/drives/register`, then refreshes `GET /api/drives/all` |
| `drives.addFolder(path?)` | `drives:addFolder` | `POST /api/drives/register-folder` with typed absolute `path`, then refreshes `GET /api/drives/all` |
| `drives.unregister(uuid)` | `drives:unregister` | `POST /api/drives/unregister`, then refreshes `GET /api/drives/all` |
| `drives.reveal(uuid)` | `drives:reveal` | Desktop-only Finder reveal; no-op/hidden on web |
| `drives.onChange(cb)` | `evt:drivesChanged` | SSE `drivesChanged` |
| `users.list()` | `users:list` | `GET /api/users` |
| `users.create(username,password,role)` | `users:create` | `POST /api/users` |
| `users.remove(id)` | `users:delete` | `DELETE /api/users/:id` |
| `users.approve(id)` | `users:approve` | `POST /api/users/:id/approve` |
| `users.setPassword(id,password)` | `users:setPassword` | `POST /api/users/:id/password` |
| `users.setRole(id,role)` | `users:setRole` | `POST /api/users/:id/role` |
| `users.setAcl(userId,drive,pathPrefix,permission)` | `acl:set` | `POST /api/users/acls` |
| `users.removeAcl(id)` | `acl:remove` | `DELETE /api/users/acls/:id` |
| `users.onRegistrationsChanged(cb)` | `evt:registrationsChanged` | SSE `registrationsChanged` |
| `access.list()` | `access:list` | `GET /api/access` |
| `access.approve(id)` | `access:approve` | `POST /api/access/:id/approve` |
| `access.deny(id)` | `access:deny` | `POST /api/access/:id/deny` |
| `access.onChange(cb)` | `evt:accessRequestsChanged` | SSE `accessRequestsChanged` |
| `dashboard()` | `app:dashboard` | `GET /api/stats` |
| `connect()` | `app:connect` | `GET /api/connect` |
| `config.get()` | `config:get` | `GET /api/config` |
| `config.set(patch)` | `config:set` | `PATCH /api/config`; SSE `configChanged` may follow |
| `revealCert()` | `cert:reveal` | Desktop-only Finder reveal; no-op/hidden on web (`GET /api/cert` is the download route) |
| `openExternal(url)` | `app:openExternal` | `window.open(url, '_blank', 'noopener')` |
| `platform` | — | Desktop: `process.platform`; web/admin: `'web'` |

## Related
- Client wrapper for these routes: `src/webui/src/api.ts` (see [frontend.md](frontend.md)).
- Auth/permission semantics: [security-rbac.md](security-rbac.md).
