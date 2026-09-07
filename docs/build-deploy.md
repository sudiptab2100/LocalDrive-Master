# Build, run & deploy

`localdrive` v0.1.0 · Electron entry `./out/main/index.cjs` · packaged with
electron‑builder (appId `com.localdrive.app`, `productName` **LocalDrive**), **mac arm64**
DMG + zip into `release/`.

## npm scripts (`package.json`)
| Script | Command | Use |
| --- | --- | --- |
| `dev` | `electron-vite dev` | Run the full desktop app (main+preload+renderer) with HMR |
| `build:webui` | `vite build --config vite.webui.config.ts` | Build the web PWA → `out/webui` |
| `build:atomic-helper` | `node scripts/build-atomic-helper.mjs` | Universal macOS no-replace rename helper → `out/native` |
| `build` | atomic helper, webui, admin, then `electron-vite build` | Full production build of all bundles |
| `server:dev` | `tsx watch src/server/standalone.ts` | Run **just the server** (no Electron), auto‑reload |
| `server:start` | `tsx src/server/standalone.ts` | Run the server once, standalone |
| `typecheck:node` | `tsc -p tsconfig.node.json` | Type‑check main/preload/server/shared |
| `typecheck:web` | `tsc -p tsconfig.web.json` | Type‑check renderer + webui |
| `typecheck` | both of the above | **Run before shipping** |
| `rebuild` | `electron-builder install-app-deps` | Rebuild native modules for Electron's ABI |
| `package` | `build` then `electron-builder --dir` | Unpacked app (no installer) |
| `dist` | `build` then `electron-builder` | **DMG + zip** in `release/` |
| `postinstall` | `electron-builder install-app-deps` | Runs automatically after `npm install` |

Standalone server env vars: `LOCALDRIVE_HOME` (data/config dir) and `LOCALDRIVE_WEBUI`
(path to a built web UI to serve).

`dev`, `server:dev` and `server:start` have a pre-hook to build the macOS atomic
publication helper. This uses the existing Command Line Tools compiler; no compiler
is needed by the packaged app. The helper supplies `RENAME_EXCL` for background
backup destinations without hard links (for example exFAT). For focused checks,
`build:atomic-helper -- --output <session-fixture-path>` keeps compiled artifacts
isolated. See [background-backup.md](background-backup.md) for server regressions.

## Build system
Two Vite configs, by design:
- **`electron.vite.config.ts`** — three targets (main, preload, renderer). Main/preload
  emit CommonJS **`.cjs`** (hence `main: out/main/index.cjs`); renderer is a normal web
  bundle → `out/renderer`.
- **`vite.webui.config.ts`** — the standalone PWA. Uses `vite-plugin-pwa`
  (`registerType: autoUpdate`) with `navigateFallbackDenylist` for `/api` and `/dav` so
  the service worker never shadows server routes. Output → `out/webui`.

TS project split: **`tsconfig.node.json`** (Node/Electron/server + `src/shared`) and
**`tsconfig.web.json`** (browser code). Both are `strict`, ESM, path alias `@shared/*`.

## Packaging (electron-builder)
- `asar: true`, but **`asarUnpack`** for native modules that can't run from the archive:
  `better-sqlite3`, `sharp`, `@img/**`.
- **`extraResources`** copies `out/webui` → `Resources/webui` (the server serves it in
  production) and `build` → `Resources/build`.
- `out/native` → `Resources/native` contains `rename-no-replace`; it is explicitly
  included in the macOS signing binary list. Do not omit it from a server update.
- `files`: `out/**/*` + `package.json`. Mac target: dmg + zip, **arm64**, icon
  `build/icon.png`.
- Signing uses an available configured local identity; an unsigned build needs
  explicit local trust. Local signing does not imply notarization. Check the
  packaging output rather than assuming either condition.

## Deploy playbook
Use this for an authorized local application update. Docs-only changes do not
require deployment; committing or pushing is a separate, explicitly requested action.

1. **Build without publishing:** `npm run package -- --publish never` produces
   `release/mac-arm64/LocalDrive.app`; use `npm run dist -- --publish never` only
   when installers are needed.
2. **Stage the update before downtime:** copy the complete bundle to an unused,
   explicitly named staging path. Verify its signature when signed and the
   executable `Contents/Resources/native/rename-no-replace`.
3. **Quiesce and quit:** wait for active transfers to finish, then use the tray's
   **Quit LocalDrive**, which sets the quit flag and runs server shutdown.
   Closing the window only hides it. Wait for the old listener and process to
   exit; never use SIGKILL as the normal shutdown path during uploads.
4. **Preserve rollback:** rename the old application bundle to an unused backup
   path, then move the staged bundle to `/Applications/LocalDrive.app`. Do not
   remove or replace `LOCALDRIVE_HOME`, its database/configuration, drive data,
   or any drive's `.localdrive` metadata.
5. **Start and inspect:** `open -a /Applications/LocalDrive.app`, then confirm
   `GET http://127.0.0.1:4820/api/health` returns `200`. Confirm the configured
   HTTPS listener too when enabled.
6. **Confirm the expected update:** background backup requires
   `capabilities.backgroundBackupTus = 1` on health. For web UI changes, compare
   the served asset hash with `out/webui/assets/`. Keep the previous application
   bundle available until the replacement is working.

## Repo / CI facts
- Git repo: `github.com/sudiptab2100/LocalDrive-Master`, default branch **`main`**.
- No CI workflows configured; typecheck + the deploy verification above are the gates.

## Related
- What each output file is: [project-structure.md](project-structure.md).
- Runtime wiring the build produces: [architecture.md](architecture.md).
