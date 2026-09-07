# Security & access control

This is the most important page to internalize before touching auth, files, uploads,
or WebDAV. The model has three layers: **authentication** (who are you),
**authorization / RBAC** (what may you do), and **confinement / scoping** (what root do
you even see). All three are enforced for **both** the web API and WebDAV.

## Authentication (`src/server/auth.ts`, `http/middleware.ts`)
- **Passwords**: bcrypt (`bcryptjs`, cost 10). Never logged or returned.
- **Web sessions**: a JWT (`jsonwebtoken`, 30‑day expiry, signed with `config.jwtSecret`)
  delivered as an **httpOnly** cookie named `ld_token` (`SameSite=Lax`, `Path=/`, `Secure`
  only on TLS requests so HTTP logins still work in dual mode). `POST /api/auth/login`
  sets it; `POST /api/auth/logout` clears it.
- **Bearer**: `Authorization: Bearer <jwt>` is also accepted (same token).
- **WebDAV**: HTTP **Basic** auth, validated against the same bcrypt accounts.
- **Resolution order** (`resolveUserRaw`): `Bearer` → `Basic` → `ld_token` cookie.
- **Pending accounts are blocked everywhere**: `resolveUser` returns a user only if
  `status === 'active'`. This single choke point blocks web, bearer, **and** WebDAV Basic
  for accounts awaiting approval.
- **Middleware**: `attachUser` (sets `req.user`), `requireAuth` (401), `requireAdmin`
  (403), `requirePermission(need)` (reads `drive` + `path` from query/body and checks RBAC).

## First-run admin
`bootstrapAdmin()` runs once when the users table is empty: it creates an `admin` with a
random one‑time password and returns it (shown once in the desktop app / standalone log).
Admins have `home = ''` and implicit `admin` permission everywhere.

## Self-registration & approval (`http/routes/auth.ts`)
- `GET /api/auth/config` → `{ registrationEnabled }` (login screen shows/hides sign‑up).
- `POST /api/auth/register` (gated by `config.registrationEnabled`):
  - Validates: username ≥ 3 chars and sanitizes to a non‑empty home; password ≥ 6 chars;
    case‑insensitive duplicate check.
  - If `autoApproveRegistrations`: create an **active** user, sign them in (set cookie),
    emit `registrationsChanged{pending:false}`. They still have no non‑admin drive access
    until requesting a drive (unless drive access auto‑approval grants it).
  - Else: create a **pending** user (no drive ACL yet), emit
    `registrationsChanged{pending:true}` → the desktop app shows a notification + badge.
- Admin approves from the desktop Users tab (or `POST /api/users/:id/approve`), which flips
  status to `active`. Drive access remains opt‑in per drive.
- User home names are deterministic: `homeNameFor(username) = sanitizeHomeName(username)`.
  `createUser` rejects sanitized home collisions (`isHomeTaken`) so registration returns
  `409` instead of silently suffixing; suffixing is retained only as a legacy backfill
  fallback.

## RBAC — ACLs & effective permission (`src/server/auth.ts`)
- Permissions rank: `read (1) < write (2) < admin (3)`.
- An **ACL** = `(user, drive_uuid, path_prefix, permission)`. `path_prefix = ''` = whole
  drive.
- **`effectivePermission(user, drive, path)`**:
  - Admins → `admin` everywhere (short‑circuit).
  - Otherwise, among the user's ACLs on that drive, the **most specific** matching prefix
    wins (specificity = number of path segments; `''` = 0). Ties break toward the **higher**
    permission. Returns `null` if nothing matches.
- **`hasPermission(user, drive, path, need)`** = `effectivePermission ≥ need`.

## Per-user home & confinement (`http/scope.ts`, `util/fs-safe.ts`)
This is why a normal user "sees their own files as the drive root":
- **`getUserHome(user, drive)`** → `''` for admins; the user's `home` folder if they have
  an ACL for it on that drive; otherwise `null` (no granted access).
- **Admin web view mode**: `viewModeFor(req, user)` reads the lightweight `ld_view` cookie
  (`admin` \| `user`; absent = `admin`). Admin + admin mode scopes to the whole share
  (`home=''`); admin + user mode scopes to `homeNameFor(username)` and ensures that folder.
  Non‑admins are always effectively user mode and ACL‑gated, so the cookie can only
  restrict an admin and can never widen a non‑admin's access. WebDAV has no toggle:
  admins stay whole‑share.
- **`driveScope(req, drive)`** → `null` if no access, else `{ home, in(clientPath),
  out(fullPath) }`:
  - **`in`** = `scopeIn(home, p)`: prefixes `home`, normalizes, returns `null` on `../`
    escape. Maps a client (home‑relative) path to a full drive path.
  - **`out`** = `scopeOut(home, full)`: strips the `home` prefix so responses stay
    relative to the user's private root.
- **`safeResolve(root, rel)`** (`fs-safe.ts`) is the last line of defense: resolves a
  relative path against a trusted root and returns `null` if it escapes. `resolveInDrive`
  uses it for every physical access.

**Rule:** never build a filesystem path from client input without `scopeIn`/`scopeOut`
(logical confinement) **and** `safeResolve`/`resolveInDrive` (physical confinement). Route
handlers additionally block operating on the home root itself (e.g. you can't rename or
delete your own home folder: `full === scope.home` is rejected).

### Recoverable backup uploads

Opt-in `backupJobId`/`backupSha256` tus jobs bind ownership to the authenticated
numeric user ID. `privateDriveScope` always confines them to the owner's home,
including admins regardless of `ld_view`. Creation, status/receipt recovery,
HEAD/PATCH and finalization recheck active status, registered drive and current
directory write permission; metadata cannot select another owner. Backup operations
require a bearer token and cannot silently fall back to another cookie account.
Receipt lookups
for unknown/other-owner jobs return `404`, including to admins.

Backup directory traversal/internal paths and symlinked directory components are
rejected. Existing target symlinks are not followed for content adoption. Adoption
requires a verified regular file with exact size/SHA-256; otherwise publication
uses atomic no-replace operations and records a unique actual name.
See [background-backup.md](background-backup.md).

### Opt-in drive access (`src/server/access.ts`, `src/server/provisioning.ts`)
Drive access for non‑admins is explicit and per drive:
- `GET /api/drives` returns all registered drives but only annotates each with
  `access: 'granted' | 'pending' | 'denied' | 'none'`; it does not create folders or ACLs.
- A non‑admin calls `POST /api/drives/request-access` for one drive. `requestAccess()`
  creates/updates an `access_requests` row and emits `accessRequestsChanged`; if
  `config.autoApproveAccessRequests` is true, it grants immediately instead.
- Pending/denied decisions live in `access_requests`. A granted home ACL is the source of
  truth for approved access.
- Admin approval (`approveAccessRequest`) calls `grantDriveAccess`: add a `write` ACL on
  the user's home path, create or reuse `LocalDrive/<home>/` via `ensureUserHomeDir`,
  write the portable `.localdrive/users.json` manifest, mark the request approved, and
  emit `accessRequestsChanged`. Denial records `denied` and revokes the home ACL.
- `listPendingAccessRequests()` feeds the desktop Users tab and includes an `existingSpace`
  hint when the deterministic folder already exists on that registered drive.

`ensureUserHomeDir(uuid, home)` is reuse‑or‑create only; it never grants access by itself.
`backfillHomes()` runs at startup to assign/normalize deterministic homes, write manifests,
and avoid data moves or new ACL grants. Cross‑PC portability depends on the stable home
name and `.localdrive/users.json`: a physical drive shared from another Mac reconnects the
same username to the existing folder.

A one‑time reset migration in `getDb()` is guarded by `meta.access_model_reset`: on first
run of the new access model it deletes all ACLs for non‑admin users so everyone starts from
a clean slate and re‑requests drive access. It never touches file data and runs before
`backfillHomes()`.

## WebDAV specifics (`src/server/webdav.ts`)
- Each registered online drive is mounted at a stable, slugified URL segment shared by all
  users: `/dav/<DriveName>/` (collisions get a `-<uuid6>` suffix).
- A **per‑user** webdav-server is built lazily and cached, with each drive's filesystem
  **physically rooted at that user's home** (admins get the share root). So a user can
  never see outside their home over WebDAV — mirroring `driveScope`.
- A custom `PrivilegeManager` maps WebDAV privilege checks onto `hasPermission` (prefixing
  the home back on, since the FS is home‑rooted). The virtual root `/dav/` lists the
  caller's drives.
- Requests without valid Basic credentials get a mount‑less "anonymous" handler so
  protocol handshakes (OPTIONS → DAV headers) work and resource methods get a proper 401
  challenge. Pending/unknown users also get the anon handler (blocked).
- **History/gotcha**: normal users used to 401 because the old code mounted the whole share
  root and denied them at the drive‑root collection (they have no ACL for it). Keep mounts
  home‑rooted.

## Optional HTTPS / local CA (`src/server/tls.ts`)
- mkcert‑style: a long‑lived **root CA** (~10y) signs a short‑lived **leaf** server cert
  (397 days — the max iOS/Safari accept). Install the **root CA once per device** (Settings
  → reveal/download, or `GET /api/cert`) for a trusted padlock.
- The leaf's SubjectAltNames cover loopback, every LAN IPv4, `localhost`, the bare
  hostname, and `<name>.local`. `ensureLeaf` **auto‑reissues** the leaf when files are
  missing, the SANs drift (IP changed), or it's within 30 days of expiry — the CA is
  untouched, so clients never need to re‑trust.
- Material persists under `<configDir>/tls/` (private keys written `0600`). Enabling HTTPS
  is dual‑mode: HTTP stays up; a cert‑generation failure degrades to HTTP‑only.
- `GET /api/cert` is intentionally **unauthenticated** (the CA cert is public and needed
  before a device can trust the server).

## Threat-model notes
- Plain HTTP sends credentials in the clear on the LAN — HTTPS is the mitigation.
- `host` defaults to `0.0.0.0` (whole LAN); `127.0.0.1` restricts to the host Mac.
- Path traversal is defended in depth (`scopeIn` + `safeResolve` + `isSafeName`).
- `.localdrive/` and dotfiles/AppleDouble `._` are never listed/served/indexed (dotfiles
  only via explicit `?hidden=1`, and never `.localdrive`).

## Related
- Endpoint‑by‑endpoint auth notes: [http-api.md](http-api.md)
- Schema for `users`/`acls`/`shares`: [data-model.md](data-model.md)
