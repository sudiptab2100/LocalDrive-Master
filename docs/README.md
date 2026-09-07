# LocalDrive Knowledge Base

An engineer/AI-oriented reference for the LocalDrive codebase. It complements the
user-facing [`README.md`](../README.md) with the architecture, contracts, and
operational playbooks needed to make correct, safe changes.

> The concise, always-loaded brief lives at
> [`.github/copilot-instructions.md`](../.github/copilot-instructions.md).
> This folder is the deep detail it links to.

## What LocalDrive is (one paragraph)
A native macOS (Electron) app that turns an external drive or folder into a private
Wi‑Fi/LAN network drive. It embeds an Express HTTP + WebDAV server, a browser PWA, a
browser admin control panel, per‑user private home folders with role/permission-based
access control, resumable uploads, search, thumbnails, optional self‑signed HTTPS, and
self‑registration with admin approval, and owner-bound mobile backup receipts.
The server can also run headless, can
stop/crash/restart with no data loss, and drives can be hot‑added.

## Reading order
1. [architecture.md](architecture.md) — the runtime surfaces, `/admin`, headless mode,
   the embedded server, data flow, and the no‑data‑loss lifecycle.
2. [project-structure.md](project-structure.md) — what every file/module does.
3. [data-model.md](data-model.md) — SQLite schema, config, and on‑disk layout.
4. [security-rbac.md](security-rbac.md) — auth, ACLs, per‑user confinement, HTTPS.
5. [http-api.md](http-api.md) — REST + WebDAV endpoint reference.
6. [ipc-api.md](ipc-api.md) — Electron main ↔ renderer IPC contract (`window.ld`).
7. [frontend.md](frontend.md) — the web PWA and shared desktop/admin control center.
8. [build-deploy.md](build-deploy.md) — scripts, packaging, and the install/deploy playbook.
9. [features.md](features.md) — feature catalog and implemented‑vs‑roadmap status.
10. [conventions.md](conventions.md) — coding conventions, safety patterns, gotchas.
11. [glossary.md](glossary.md) — domain vocabulary.
12. [background-backup.md](background-backup.md) — recoverable tus jobs, durable
    receipts, no-clobber publication and isolated server regressions.

## Fast facts
| Thing | Value |
| --- | --- |
| Platform | macOS, Apple Silicon (arm64) |
| Language | TypeScript (strict, ESM) |
| UI | React 18 (shared desktop/admin renderer + web PWA) |
| Default HTTP port | `4820` |
| Default HTTPS port | `4843` (opt‑in) |
| Health check | `GET /api/health` → `{ ok: true, status, capabilities }`; `backgroundBackupTus = 1` |
| Mobile backup recovery | `/api/backup/uploads/:jobId`; owner-only receipts, bytes stay on tus `/api/upload` |
| Admin panel | `http://<host>:4820/admin` (admin-only) |
| WebDAV mount | `http://<host>:4820/dav/<DriveName>/` |
| Config + DB dir | `~/Library/Application Support/LocalDrive/` |
| On‑drive share root | `<mount>/LocalDrive/` (per‑user: `LocalDrive/<home>/`) |
| On‑drive app data | `<mount>/.localdrive/` (tmp, thumbs, trash, versions, users.json) |
| Git branch / remote | `main` @ `github.com/sudiptab2100/LocalDrive-Master` |

## Keeping this KB accurate
When you change behavior, update the affected page(s). The highest‑value pages to keep
current are `http-api.md`, `ipc-api.md`, `data-model.md`, and `security-rbac.md` — they
document contracts other code and clients depend on. Prefer durable facts (contracts,
invariants, workflows) over volatile specifics (exact line numbers, bundle hashes).
