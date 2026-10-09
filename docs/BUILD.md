# Bahi ERP — Build, package and release

## 1. Toolchain

| Tool | Version | Used for |
|---|---|---|
| Node.js | ≥ 22.18 (type stripping on by default) | scripts, tests, core |
| Electron | ^44 (devDependency) | desktop runtime (bundles Chromium + Node with `node:sqlite`) |
| esbuild | ^0.25 | bundles `src/main` (main thread + core worker) and `src/preload` to CommonJS |
| Vite + @vitejs/plugin-react | ^7 / ^5 | builds the React renderer |
| TypeScript | ^6 | typechecking only (`noEmit`) — code runs via esbuild/Vite or Node type stripping |
| electron-builder | ^26 | Windows NSIS installer |
| Playwright | ^1.55 | Electron end-to-end tests |
| @electron/fuses | ^1.8 | flips and verifies the Electron fuses on the packaged binary |

All dependencies are `devDependencies`: everything the app needs at runtime is bundled into `out/`,
so the installer ships no `node_modules`. There are **no native modules** (SQLite comes from
`node:sqlite` inside Electron), so no Visual Studio / Python / `electron-rebuild` is required.

## 2. Scripts

| Command | What it does |
|---|---|
| `npm run dev` | `scripts/dev.mjs`: Vite dev server on `http://127.0.0.1:5173` (HMR), esbuild watch for main, the core worker and preload, launches Electron with `BAHI_DEV_SERVER_URL`; restarts Electron when main/core-worker/preload code (incl. `src/core`) changes; `Ctrl+C` stops everything |
| `npm run build` | `scripts/build.mjs`: cleans `out/`, bundles main, the core worker and preload (minified, no source maps), checks the preload only requires `electron` and the core worker only `node:*`, builds the renderer with Vite |
| `node scripts/build.mjs --dev` | same, but unminified main/preload with linked source maps |
| `npm start` | runs `electron .` against the existing `out/` |
| `npm run typecheck` | `tsc` for core, node (main/preload/core worker), web (renderer) and e2e (`tsconfig.e2e.json`: Playwright specs + `playwright.config.ts`) projects |
| `npm test` | `node --test "src/**/*.test.ts"` (core, shared and main-process unit tests) |
| `npm run e2e` | Playwright end-to-end suite against `out/` — **run `npm run build` first** (see §5.1) |
| `npm run dist:win` | build + `electron-builder --win --x64` → `release/Bahi-ERP-Setup-<version>.exe` |
| `npm run dist:dir` | build + unpacked app in `release/win-unpacked/` (fast packaging check) |
| `npm run check:fuses` | reads the fuses back from `release/win-unpacked/Bahi ERP.exe`; fails if any is not hardened |
| `pwsh scripts/smoke-installed.ps1 -Installer <setup.exe>` | Windows: silent install, launch the installed app in smoke mode, check exit code + log, uninstall |
| `node scripts/make-icon.mjs` | regenerates `build/icon.png` (512 px) and `build/icon.ico` (16–256 px) |

## 3. Build pipeline

```
src/main/index.ts ──esbuild (cjs, node22, external electron + node:*)──▶ out/main/index.cjs
src/main/core-worker.ts ──esbuild (cjs, node22, external node:* only)─▶ out/main/core-worker.cjs
src/preload/index.ts ──esbuild (cjs)───────────────────────────────────▶ out/preload/index.cjs
src/renderer/index.html ──vite build (chrome130, base './')────────────▶ out/renderer/**
```

**The core runs on a worker thread.** `out/main/index.cjs` (the Electron main thread) owns windows,
menus, dialogs and IPC only. At start-up it spawns `out/main/core-worker.cjs` on a `node:worker_threads`
thread, where the whole accounting core runs (node:sqlite works there). `src/main/core-proxy.ts`
implements the core's `Runtime` interface for main: every `bahi:api` call becomes a
`{ type: 'call', id, route, input }` message, answered by exactly one reply with the same id
(protocol: `src/main/core-protocol.ts`). So a 5-second integrity check or a 2-minute import never
freezes the window ("Not Responding"), and an out-of-memory export kills only the worker, which is
restarted (no company open; the window is told and returns to the company list). Calls are bounded
(30 min), shutdown is bounded (30 s, then the thread is terminated), slow round trips (≥ 500 ms) are
logged as `Slow route`. The worker may import only `node:*` builtins — never `electron` — and the
build fails otherwise. In a packaged app it is shipped unpacked (`electron-builder.yml → asarUnpack`,
loaded from `resources/app.asar.unpacked/out/main/`) because worker threads cannot read scripts from
inside `app.asar`.

- `package.json` → `"main": "out/main/index.cjs"`. The `.cjs` extension matters because the package is
  `"type": "module"`.
- esbuild defines `process.env.NODE_ENV`, `__BAHI_VERSION__` (from package.json) and maps
  `import.meta.url/dirname/filename` for CommonJS. Shared options live in `scripts/build-config.mjs`.
- The preload is bundled self-contained: sandboxed preloads may only `require('electron')`. The build
  fails if anything else appears in `out/preload/index.cjs`.
- The renderer is served at runtime from `app://bahi/` (not `file://`), which is why Vite uses a
  relative `base: './'`. Production builds contain no source maps (set `BAHI_SOURCEMAP=1` for a local
  debugging build).
- `npm run dev` watches all three bundles and restarts Electron when any of them changes.
- Unpackaged runs (`npm run dev`, `npm start`, E2E) use a separate profile `%APPDATA%\Bahi ERP Dev` and
  default data folder `Documents\Bahi ERP Dev`, so development never touches an installed copy's data.

## 4. Building the Windows installer locally

On Windows 10/11 x64 with Node 22.18+:

```powershell
npm install
npm run dist:win
# → release\Bahi-ERP-Setup-0.1.0.exe
```

What `electron-builder.yml` produces:

- **NSIS assisted installer** (not one-click): per-user by default (no admin), option to install for all
  users (elevates), choice of install directory, desktop + Start-menu shortcuts named *Bahi ERP*.
- `requestedExecutionLevel: asInvoker`; `deleteAppDataOnUninstall: false` — uninstall keeps settings
  (`%APPDATA%\Bahi ERP`) and of course the data folder.
- `asar: true`, only `out/**` and `package.json` packed, `.map` files excluded, `npmRebuild: false`,
  only `en-US`/`en-GB` Chromium locales kept.
- `asarUnpack: out/main/core-worker.cjs` — the core worker ships next to the archive (see §3).
- `scripts/after-pack.cjs` flips the Electron fuses listed in `scripts/fuses.cjs` and reads them back
  (see [SECURITY.md §3.7](SECURITY.md#37-packaged-binary--scriptsafter-packcjs-scriptsfusescjs)). It
  **fails the build** if `@electron/fuses` (a declared devDependency) cannot be loaded, a fuse is
  unknown, flipping fails or the read-back differs. `BAHI_ALLOW_UNFUSED=1` turns that into a warning
  for a throw-away local build only — such a build must never be distributed.
- `build/installer.nsh` adds an uninstall log note that data was kept.

Cross-building the Windows installer from Linux/macOS needs Wine; use the CI job instead.

## 5. Continuous integration (`.github/workflows/ci.yml`)

Runs on every push and pull request. Third-party actions are pinned to commit SHAs; Dependabot
(`.github/dependabot.yml`) proposes npm and action updates as pull requests. Every job installs with
`npm ci` when `package-lock.json` is committed and matches `package.json` (`scripts/lockfile-sync.mjs`),
and otherwise with `npm install` plus a warning annotation (see §5.2).

1. **verify** (ubuntu-latest, Node 22): install (Electron binary download skipped), `npm run typecheck`
   (including the e2e specs), `npm test`, `npm run build`; uploads `out/`.
2. **windows-installer** (windows-latest, needs verify): `npm test` on Windows (paths, file locking,
   CRLF and case-insensitivity are exercised on every push, not first at release time),
   `npm run dist:win` (fails if the fuses cannot be applied), `npm run check:fuses`, `SHA256SUMS.txt`,
   uploads the **Bahi-ERP-Windows-Installer** artifact (kept 30 days).
3. **windows-smoke** (windows-latest, needs windows-installer): `scripts/smoke-installed.ps1` installs
   the uploaded installer silently, starts the *installed* `Bahi ERP.exe` with `BAHI_SMOKE_TEST=1`
   (window opens → `app.state` through preload/IPC/core worker/node:sqlite → verdict in the log → quit
   with exit code 0/1, see `src/main/smoke.ts`), checks exit code and log, uninstalls. This is the
   only check of the real packaged binary: Playwright cannot drive it because the
   `EnableNodeCliInspectArguments` fuse is off. The app log is uploaded on failure.
4. **electron-node** (ubuntu-latest, needs verify): the whole unit suite again *inside Electron's
   bundled Node* (`ELECTRON_RUN_AS_NODE=1 npx electron --test …`). The packaged app runs the core on
   that newer runtime, which validates some `node:sqlite`/`node:*` arguments more strictly than Node 22
   (e.g. `backup({ rate: -1 })` passed every Node 22 test but made every backup fail in the app).
5. **e2e** (matrix: ubuntu-latest under `xvfb-run` with unprivileged user namespaces re-enabled for
   Chromium's sandbox, and windows-latest): `npm run build`, then `npx playwright test` against `out/`
   with the unfused Electron from `node_modules`. On failure the Playwright report, the window
   screenshot of every failing test and `trace.zip` (open with `npx playwright show-trace`) are
   uploaded as `playwright-report-<os>`, and the failing test's alerts, toasts, top-screen text and
   focused element are printed to the job log (`e2e/support.ts`).

A run already in progress on a branch always finishes; newer pushes queue and only the newest waiting
run is kept (pull requests cancel superseded runs).

npm, Electron and electron-builder downloads are cached (keys include the lockfile).

### 5.1 End-to-end suite (`e2e/`)

| Spec | Covers |
|---|---|
| `e2e/smoke.spec.ts` | bridge and security invariants: product title, `app://bahi` origin, exact `window.bahi` shape, `app.state` over IPC, no Node in the renderer, malformed IPC rejected, no network |
| `e2e/first-day.spec.ts` | a new user's first day, keyboard first: first-run data folder → Create Company wizard → party ledger → stock item → F8 sales invoice → Day Book → voucher view → Print Preview → Balance Sheet → GSTR-1 → backup |

- `npm run build` **must** run before `npm run e2e`: the specs launch `out/main/index.cjs`.
- `e2e/support.ts` launches the app with a throw-away `BAHI_USER_DATA`/`BAHI_DATA_DIR`, records a trace
  (kept only when a test fails), attaches a screenshot to each failing test and fails loudly if the
  app does not quit within 45 s of `app.close()`.
- The figures typed in `first-day.spec.ts` are pinned by its API-level twin
  `src/core/testing/e2e/first-day.test.ts` (same masters, same routes, same amounts), which runs in
  `npm test`. **Edit the two together.**
- Flows that open native dialogs must stub them in the main process before triggering them, e.g.
  ```ts
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
  }, someFolder);
  ```
  (`showSaveDialog`/`showMessageBox` likewise). Never let a spec wait on a real modal dialog.

### 5.2 Lockfile (`.github/workflows/lockfile.yml`)

npm is not available in the development container, so `package-lock.json` is produced by CI: whenever
`package.json` changes on a branch (or on demand: *Actions › Lockfile › Run workflow*), the job runs
`npm install --package-lock-only --ignore-scripts` (registry metadata only — nothing is downloaded or
executed), commits `package-lock.json` back to the branch with `GITHUB_TOKEN` (`contents: write`) and
starts CI for that commit (pushes made with `GITHUB_TOKEN` do not trigger workflows by themselves).
From then on every job uses `npm ci`. With npm available locally, `npm install` followed by committing
`package-lock.json` is equivalent. The job skips its own commits (no loop) and Dependabot's branches
(Dependabot updates the lockfile itself, and its runs get a read-only token).

`node scripts/lockfile-sync.mjs` compares the lockfile's root entry with `package.json` without any
network access (exit 0 in sync, 1 out of date, 2 missing). CI uses it to choose `npm ci` (in sync) or
`npm install` with a `::warning::` (the short window between a `package.json` push and the Lockfile
workflow's commit, which re-runs CI). **A release never falls back**: `release.yml` fails unless the
tagged commit has a matching lockfile, so the same tag always installs the same dependency tree.

## 6. Releasing

1. Bump `"version"` in `package.json` (semver; use a pre-release suffix like `0.2.0-beta.1` for betas).
2. Commit, then tag and push:
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```
3. `.github/workflows/release.yml` runs three jobs:
   - **build** (windows-latest, read-only token): checks the tag equals `v<package.json version>`,
     installs dependencies with `npm ci` from the committed lockfile (fails if it is missing or stale,
     §5.2), typechecks and tests **with no secrets in the environment**, builds, then
     packages (and signs, if configured) in a single step that alone sees the certificate, verifies the
     fuses and writes `SHA256SUMS.txt`;
   - **smoke** (windows-latest): installs and launches the installer exactly like CI's windows-smoke;
   - **publish** (ubuntu-latest, the only job with `contents: write`; no checkout, no npm): verifies
     the checksums and publishes a GitHub Release with `Bahi-ERP-Setup-<version>.exe` and
     `SHA256SUMS.txt` (tags containing `-` are marked pre-release).

Verifying a download on Windows:

```powershell
Get-FileHash .\Bahi-ERP-Setup-0.2.0.exe -Algorithm SHA256   # compare with SHA256SUMS.txt
```

## 7. Code signing

Unsigned installers work, but Windows **SmartScreen** shows *"Windows protected your PC"* until the
file builds reputation, and some corporate policies block unsigned software. To sign:

1. Obtain a **code-signing certificate** for Windows: an OV certificate (cheaper; SmartScreen
   reputation builds over time) or an EV certificate (immediate reputation; usually on a hardware token
   or cloud HSM). Since 2023 CAs issue new code-signing keys only on hardware/HSMs, so for CI you will
   typically use a cloud signing service (e.g. **Azure Trusted Signing**, DigiCert KeyLocker,
   SSL.com eSigner) rather than a `.pfx` file.
2. **With a `.pfx` file** (legacy/OV exported keys): add repository secrets
   `WIN_CSC_LINK` (base64 of the `.pfx`, or an https URL) and `WIN_CSC_KEY_PASSWORD`. The release
   workflow passes them **only to the packaging step** (never to `npm install`, typecheck or tests),
   and electron-builder signs `Bahi ERP.exe`, the uninstaller and the installer automatically.
3. **With a cloud HSM/Trusted Signing:** configure electron-builder's `win.azureSignOptions` (Azure
   Trusted Signing) or a custom `win.signtoolOptions.sign` script that calls the vendor's signing tool,
   and provide credentials as repository secrets.
4. Once signed, set `win.signtoolOptions.publisherName` to the certificate subject.

Fuses are flipped in `afterPack`, i.e. **before** signing, so signatures stay valid.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `npm run dev` says port 5173 is in use | another Vite server is running; stop it (strictPort is on by design) |
| Electron starts but the window is blank in dev | check the terminal for Vite errors; the window loads `http://127.0.0.1:5173/` |
| Electron behaves like plain Node | an `ELECTRON_RUN_AS_NODE` variable is set in your shell; `dev.mjs` removes it, `npm start` does not |
| E2E fails on Linux with a sandbox error | run `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` (Ubuntu 23.10+) |
| Rendering glitches on a specific PC | start with `BAHI_DISABLE_GPU=1` |
| electron-builder cannot download NSIS/winCodeSign | proxy/firewall; set `ELECTRON_BUILDER_BINARIES_MIRROR` or run in CI |
| `Electron fuses could not be applied` | run `npm install` (installs `@electron/fuses`); for a throw-away local build only, `BAHI_ALLOW_UNFUSED=1` |
| "The accounting engine failed to start" / `Cannot find module …core-worker.cjs` | `out/main/core-worker.cjs` missing (rebuild), or in a packaged app `asarUnpack` was removed from `electron-builder.yml` |
| windows-smoke fails | download the `windows-smoke-evidence` artifact (the app's `bahi.log`); look for `Smoke test failed:` and `Quit:` lines |
| E2E `afterAll` reports the app did not quit | the `[electron]` output shows the `Quit:` steps (`src/main/quit.ts`); the app exits at the latest 40 s after its last window closed |
