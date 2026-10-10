# Pevqori — Build, package and release

## 1. Toolchain

| Tool | Version | Used for |
|---|---|---|
| Node.js | ≥ 22.18 (type stripping on by default) | scripts, tests, core |
| Electron | ^44 (devDependency) | desktop runtime (bundles Chromium + Node with `node:sqlite`) |
| esbuild | ^0.28 | bundles `src/main` (main thread, core worker, updater) and `src/preload` to CommonJS |
| Vite + @vitejs/plugin-react | ^8 / ^6 | builds the React renderer |
| TypeScript | ^7 | typechecking only (`noEmit`) — code runs via esbuild/Vite or Node type stripping |
| electron-builder | ^26 | Windows NSIS installer, `latest.yml` + `.blockmap` for the in-app updater |
| electron-updater | 6.6.2 (exact) | in-app updates; bundled into `out/main/updater.cjs` (see §3) |
| Playwright | ^1.55 | Electron end-to-end tests |
| @electron/fuses | ^2 | flips and verifies the Electron fuses on the packaged binary |

All dependencies are `devDependencies`: everything the app needs at runtime is bundled into `out/`,
so the installer ships no `node_modules`. There are **no native modules** (SQLite comes from
`node:sqlite` inside Electron), so no Visual Studio / Python / `electron-rebuild` is required.

## 2. Scripts

| Command | What it does |
|---|---|
| `npm run dev` | `scripts/dev.mjs`: Vite dev server on `http://127.0.0.1:5173` (HMR), esbuild watch for main, the core worker and preload, launches Electron with `PEVQORI_DEV_SERVER_URL`; restarts Electron when main/core-worker/preload code (incl. `src/core`) changes; `Ctrl+C` stops everything |
| `npm run build` | `scripts/build.mjs`: cleans `out/`, bundles main, the core worker and preload (minified, no source maps), checks the preload only requires `electron` and the core worker only `node:*`, builds the renderer with Vite |
| `node scripts/build.mjs --dev` | same, but unminified main/preload with linked source maps |
| `npm start` | runs `electron .` against the existing `out/` |
| `npm run typecheck` | `tsc` for core, node (main/preload/core worker), web (renderer) and e2e (`tsconfig.e2e.json`: Playwright specs + `playwright.config.ts`) projects |
| `npm test` | `node --test "src/**/*.test.ts"` (core, shared and main-process unit tests) |
| `npm run e2e` | Playwright end-to-end suite against `out/` — **run `npm run build` first** (see §5.1) |
| `npm run dist:win` | build + `electron-builder --win --x64` → `release/Pevqori-Setup-<version>.exe` |
| `npm run dist:dir` | build + unpacked app in `release/win-unpacked/` (fast packaging check) |
| `npm run check:fuses` | reads the fuses back from `release/win-unpacked/Pevqori.exe`; fails if any is not hardened |
| `pwsh scripts/smoke-installed.ps1 -Installer <setup.exe>` | Windows: silent install, launch the installed app in smoke mode, check exit code + log, uninstall (keeps data). Variants: `-Previous <old setup.exe>` (in-place upgrade), `-Scenario RunningApp` (installer leaves a running Pevqori alone, exit code 3), `-Scenario Downgrade` (exit code 4, `/ALLOWDOWNGRADE`) — see §6.2 |
| `node scripts/make-icon.mjs` | regenerates `build/icon.png` (512 px), `build/icon.ico` (16–256 px) and the installer bitmaps `build/installerSidebar.bmp` (164×314) / `build/installerHeader.bmp` (150×57); `--if-missing` only fills in missing files. Never edit these by hand: `src/main/make-icon.test.ts` compares the committed bitmaps with the generator |
| `node scripts/release-assets.mjs check release <version>` | after packaging: `latest.yml` names this version and installer with its sha512 and size, the `.blockmap` exists, the packaged app has `resources/app-update.yml` for this repository |
| `node scripts/release-assets.mjs notes <version> CHANGELOG.md [out.md]` | prints / writes the `## [<version>]` section of the changelog (the GitHub Release body) |

## 3. Build pipeline

```
src/main/index.ts ──esbuild (cjs, node22, external electron + node:*)──▶ out/main/index.cjs
src/main/core-worker.ts ──esbuild (cjs, node22, external node:* only)─▶ out/main/core-worker.cjs
src/main/updates/entry.ts ──esbuild (cjs, bundles electron-updater)───▶ out/main/updater.cjs
src/preload/index.ts ──esbuild (cjs)───────────────────────────────────▶ out/preload/index.cjs
src/renderer/index.html ──vite build (chrome130, base './')────────────▶ out/renderer/**
```

**The core runs on a worker thread.** `out/main/index.cjs` (the Electron main thread) owns windows,
menus, dialogs and IPC only. At start-up it spawns `out/main/core-worker.cjs` on a `node:worker_threads`
thread, where the whole accounting core runs (node:sqlite works there). `src/main/core-proxy.ts`
implements the core's `Runtime` interface for main: every `pevqori:api` call becomes a
`{ type: 'call', id, route, input }` message, answered by exactly one reply with the same id
(protocol: `src/main/core-protocol.ts`). So a 5-second integrity check or a 2-minute import never
freezes the window ("Not Responding"), and an out-of-memory export kills only the worker, which is
restarted (no company open; the window is told and returns to the company list). Calls are bounded
(30 min), shutdown is bounded (30 s, then the thread is terminated), slow round trips (≥ 500 ms) are
logged as `Slow route`. *Exit and long statements*: node:sqlite cannot interrupt a statement that is
running, and `Worker.terminate()` only takes effect once that statement returns to JavaScript, so a
quit during one long statement (a huge report query, the backup snapshot) waits for it — bounded by
the shutdown (30 s) and termination (3 s) limits and, at the latest, the main process's hard deadline
(`src/main/quit.ts` `QUIT_DEADLINE_MS`, 40 s), after which the process exits anyway; SQLite rolls back
the unfinished transaction on the next open, so nothing committed is lost. The worker may import only `node:*` builtins — never `electron` — and the
build fails otherwise. In a packaged app it is shipped unpacked (`electron-builder.yml → asarUnpack`,
loaded from `resources/app.asar.unpacked/out/main/`) because worker threads cannot read scripts from
inside `app.asar`.

- `out/main/updater.cjs` holds electron-updater and is loaded by main only on the first update check
  (never at start-up, never while updates are off); the build fails if electron-updater ends up in
  `index.cjs`. Everything under `out/` is packed, so the installer ships it with no `node_modules`.
- `package.json` → `"main": "out/main/index.cjs"`. The `.cjs` extension matters because the package is
  `"type": "module"`.
- esbuild defines `process.env.NODE_ENV`, `__PEVQORI_VERSION__` (from package.json) and maps
  `import.meta.url/dirname/filename` for CommonJS. Shared options live in `scripts/build-config.mjs`.
- The preload is bundled self-contained: sandboxed preloads may only `require('electron')`. The build
  fails if anything else appears in `out/preload/index.cjs`.
- The renderer is served at runtime from `app://pevqori/` (not `file://`), which is why Vite uses a
  relative `base: './'`. Production builds contain no source maps (set `PEVQORI_SOURCEMAP=1` for a local
  debugging build).
- `npm run dev` watches all three bundles and restarts Electron when any of them changes.
- Unpackaged runs (`npm run dev`, `npm start`, E2E) use a separate profile `%APPDATA%\Pevqori Dev` and
  default data folder `Documents\Pevqori Dev`, so development never touches an installed copy's data.

## 4. Building the Windows installer locally

On Windows 10/11 x64 with Node 22.18+:

```powershell
npm install
npm run dist:win
# → release\Pevqori-Setup-2.0.0.exe, Pevqori-Setup-2.0.0.exe.blockmap, latest.yml
```

What `electron-builder.yml` produces:

- **NSIS assisted installer** (not one-click): per-user by default (`perMachine: false`,
  `selectPerMachineByDefault: false`, no admin), option to install for all users (elevates), choice of
  install directory, desktop + Start-menu shortcuts named *Pevqori*. The welcome / finish pages and the
  page header show the generated brand bitmaps (`installerSidebar`, `uninstallerSidebar`,
  `installerHeader`).
- **Upgrades in place.** `appId: com.pevqori.app` and `productName: Pevqori` never change: the uninstall
  key is a GUID derived from `appId`, so a newer installer finds the existing installation (same folder,
  per-user or per-machine as before), removes the old program files and installs the new ones; data and
  settings are not touched. See [INSTALL.md §4](INSTALL.md#4-upgrading).
- **Update files.** Because `publish` names this repository's GitHub Releases (`provider: github`,
  `owner: JayPanchani1054`, `repo: billing`, `releaseType: release`), every build also writes
  `release/latest.yml` (version, file name, sha512, size, release date) and
  `Pevqori-Setup-<version>.exe.blockmap` (for differential downloads), and embeds
  `resources/app-update.yml` (provider, owner, repo) in the app — that is where the in-app updater
  (`src/main/updates`, [SECURITY.md §3.11](SECURITY.md#311-updates--srcmainupdates)) looks. Builds never
  publish anything themselves: every `electron-builder` run passes `--publish never` (`npm run dist:*`,
  `release.yml`); only the release workflow's publish job uploads (§6).
- `verifyUpdateCodeSignature` is left at its default: once installers are signed (§7) the updater also
  requires the downloaded installer to carry the running app's publisher. Unsigned builds rely on the
  sha512 in `latest.yml`.
- `requestedExecutionLevel: asInvoker`; `deleteAppDataOnUninstall: false` — uninstall keeps settings
  (`%APPDATA%\Pevqori`) and of course the data folder.
- `asar: true`, only `out/**` and `package.json` packed, `.map` files excluded, `npmRebuild: false`,
  only `en-US`/`en-GB` Chromium locales kept.
- `asarUnpack: out/main/core-worker.cjs` — the core worker ships next to the archive (see §3).
- `scripts/after-pack.cjs` flips the Electron fuses listed in `scripts/fuses.cjs` and reads them back
  (see [SECURITY.md §3.7](SECURITY.md#37-packaged-binary--scriptsafter-packcjs-scriptsfusescjs)). It
  **fails the build** if `@electron/fuses` (a declared devDependency) cannot be loaded, a fuse is
  unknown, flipping fails or the read-back differs. `PEVQORI_ALLOW_UNFUSED=1` turns that into a warning
  for a throw-away local build only — such a build must never be distributed.
- `build/installer.nsh` (warnings are errors: no `Var`/`Function`, registers and header macros only):
  - **Running app.** Pevqori is never closed by the installer. Interactive: *"Pevqori is open. Save your
    work and close it, then click Retry."* (Retry / Cancel). Silent (`/S`, also the in-app updater's run):
    waits up to 30 s for it to exit, then stops with **exit code 3** without changing anything. Checked in
    `customInit` (before any page) and in `customCheckAppRunning`, which electron-builder 26's template
    (`allowOnlyOneInstallerInstance.nsh`, `!ifmacrodef customCheckAppRunning`) runs instead of its own
    check — that one force-closes the app — in the installer and the uninstaller. A per-user
    installation counts only this account's `Pevqori.exe`; a per-machine one (`$installMode` "all")
    counts any account's.
  - **Downgrade guard** (`customInit`): reads `DisplayVersion` of the uninstall key (HKCU, then HKLM) and
    compares it with the installer's version without a pre-release suffix. A newer installed version →
    interactive Yes/No warning (*"A newer Pevqori (x) is installed. Installing y is not supported: a
    company opened by the newer version cannot be opened by this one. Continue anyway?"*); silent →
    **exit code 4** unless `/ALLOWDOWNGRADE` is passed. The app itself refuses to open a company written
    by a newer version anyway (`assertSupportedVersion`).
  - an uninstall log note that data and settings were kept.

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
   `npm run dist:win` (`--publish never`; fails if the fuses cannot be applied), `npm run check:fuses`,
   `node scripts/release-assets.mjs check` (latest.yml / blockmap / app-update.yml), `SHA256SUMS.txt`,
   uploads the **Pevqori-Windows-Installer** artifact (installer, blockmap, latest.yml; kept 30 days).
   CI builds are never published.
3. **windows-smoke** (windows-latest, needs windows-installer): `scripts/smoke-installed.ps1` installs
   the uploaded installer silently, starts the *installed* `Pevqori.exe` with `PEVQORI_SMOKE_TEST=1`
   (window opens → `app.state` through preload/IPC/core worker/node:sqlite → verdict in the log → quit
   with exit code 0/1, see `src/main/smoke.ts`), checks exit code and log, uninstalls and checks that the
   data and settings folders are kept. Then the **running-app** variant (a silent install while Pevqori
   is open exits with code 3 after 30 s, Pevqori keeps running, and the install succeeds once it is
   closed) and the **downgrade** variant (exit code 4 over a newer `DisplayVersion`, installed with
   `/ALLOWDOWNGRADE`). This is the only check of the real packaged binary: Playwright cannot drive it
   because the `EnableNodeCliInspectArguments` fuse is off. The app log is uploaded on failure.
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
| `e2e/smoke.spec.ts` | bridge and security invariants: product title, `app://pevqori` origin, exact `window.pevqori` shape, `app.state` over IPC, no Node in the renderer, malformed IPC rejected, no network |
| `e2e/first-day.spec.ts` | a new user's first day, keyboard first: first-run data folder → Create Company wizard → party ledger → stock item → F8 sales invoice → Day Book → voucher view → Print Preview → Balance Sheet → GSTR-1 → backup |
| `e2e/screens.spec.ts` | every screen renders: wizard company → **every** F11 feature on (Features screen) → masters and one voucher of each kind (API) → **every item of the Go To catalogue** opened through the palette and checked (visible `[data-screen]` with an h1, or a dialog with a heading; no error boundary — also one that replaced a dialog screen —, no "Something went wrong", no "This could not be loaded" / "You don't have access to this", no uncaught page error, no `[pevqori]` / React console error), Enter on the first row of each list (the id screens: alterations, drill-downs) checked the same way, Esc back to the Gateway; then Day Book → voucher view → Print Preview. Failures are collected and reported together |
| `e2e/parity.spec.ts` | the extended-feature flows: quotation → Quotation Register › Alt+V → Sales 1; print preview on A5 (sheet 148 mm wide) and on the 80 mm roll (Compact receipt); POS counter: scan a barcode, UPI ₹50 + cash ₹68, ₹100 handed over → change ₹32; purchase (F9, accounting invoice) with the TDS 194C auto-line ₹800; export invoice in US$ shown in both currencies; Manufacturing Journal from the default BOM; cheque print preview of a payment (voucher view › Alt+K) with the leaf number and the amount in words |
| `e2e/home.spec.ts` | the 2.0 shell: Home on Essentials for a new profile, Ctrl+2 / Ctrl+1, **Create ▾** › Sales invoice and › Customer (saved with Ctrl+S, the alias of Ctrl+A), the command bar (primary button, **More ▾** listing every other action with its key) and the optional shortcut bar |
| `e2e/keyboard-a11y.spec.ts` | Ctrl+S (the save alias of Ctrl+A) never answers a Yes/No question: Esc on a changed form → "Discard unsaved changes?" → Ctrl+S leaves the question and the form as they are; N keeps editing; Ctrl+S then saves |
| `e2e/onboarding.spec.ts` | Create Company › *Create with recommended settings* → Home (the Get started steps, *Show more insights*) → ⚙ Settings: topics, Ctrl+F search, keyboard between search, topics and settings, a setting opens its screen |
| `e2e/numbering.spec.ts` | Invoice Numbering: prefix with the {FY} chip and 4 digits → the next sale's number; next number 41 (Set, confirm the skipped numbers); gaps; the yearly-restart note; *Create series* (Alt+C) offered by F10. API twin: `src/core/testing/e2e/renumber.test.ts` |
| `e2e/invoice-flow.spec.ts` | F8 with the quick *Create customer* dialog (Alt+C in the party field), the Saved bar and *Record payment*, Ctrl+I's Reference tab, Ctrl+R in entry and in the voucher view, the number change in the edit history |
| `e2e/print-layout.spec.ts` | the print preview editor (Alt+L): hide a part for this print only, the change offered again, *Save for Sales*, batch printing uses it, click-to-select, a hidden statutory particular warns without blocking, *Reset ▾* |
| `e2e/updates.spec.ts` | in-app updates in a test run (`PEVQORI_E2E=1` → off): every `updates.*` action answers "unavailable" and validates its payload, About shows the turned-off text and nothing to click, Home shows no notice, the updater bundle is never loaded and nothing leaves the app |
| `e2e/perf.spec.ts` | the performance harness (docs/ARCHITECTURE.md §9a): size report, start-up and screen-open timings, compared with `build/perf-budget.json` |

- `npm run build` **must** run before `npm run e2e`: the specs launch `out/main/index.cjs`.
- `e2e/support.ts` launches the app with a throw-away `PEVQORI_USER_DATA`/`PEVQORI_DATA_DIR`, records a trace
  (kept only when a test fails), attaches a screenshot to each failing test and fails loudly if the
  app does not quit within 45 s of `app.close()`.
- The figures typed in `first-day.spec.ts` are pinned by its API-level twin
  `src/core/testing/e2e/first-day.test.ts` (same masters, same routes, same amounts), which runs in
  `npm test`. **Edit the two together.**
- `parity.spec.ts` and its twin `src/core/testing/e2e/parity.test.ts` share one file,
  `src/core/testing/e2e/parityFlow.ts` (masters, inputs, expected figures with the arithmetic): the spec
  runs its calls through `window.pevqori.api` (real preload → IPC → core worker), the twin through
  `runtime.dispatch`. `screens.spec.ts` uses the same seed; its twin `src/core/testing/e2e/screens.test.ts`
  proves the seed and vouchers are accepted with every F11 feature on (e.g. opening stock then needs its
  godown).
- The sweep does not keep a list of screens: the open Go To palette answers a `pevqori:goto-catalog` event
  with its own items and the registered screens (`src/renderer/app/lib/gotoCatalog.ts`), and each option
  carries `data-goto-id`. Shell commands (working date, period, switch company, F1, F10) are skipped
  with a logged reason, as are registered screens nothing reached (`[screens] skip …` lines: they need an
  id and open from another screen). Lists whose first-row Enter could change data (backup / restore,
  banking, due recurring vouchers, e-payment, POS, GST filing, users, an owner's attachments) are opened
  but not drilled into.
  The company is a Regular GST dealer, so the composition-only screens (CMP-08, GSTR-4, composition
  rates) are not in its Go To and show up among the `[screens] skip …` lines. A screen whose first
  load fails fails the sweep (its error text is in the problem line); the job log also carries
  `[screens] note: …` lines for screens that handed over to another screen, were still loading after
  15 s, logged a console error that is not the app's or React's, or asked to discard changes on an
  untouched form.
- Both company specs stub the main process's native dialogs (cancel) and switch POS receipt printing
  off, so no step can wait on an OS dialog. Budget: the sweep is bounded at 9 minutes (aimed at about
  5 per OS; the `[screens] opened N Go To items in S s` line gives the real figure) and is not retried
  (a second pass finds the same screens and the e2e job has a 25-minute limit); each parity step has
  the default 60 s and the usual CI retry.
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

`package.json` `"version"` is the single source of the version (semver): the app reports it (baked in
as `__PEVQORI_VERSION__`), the installer is named after it, `latest.yml` carries it, and the release
workflow refuses a tag that differs. Releases are published as **GitHub Releases of
`JayPanchani1054/billing`**, which is also the in-app updater's feed — so the repository's releases must
be readable without signing in (public), otherwise *Check for updates* reports that the update server
cannot be reached and nothing else changes.

### 6.1 Release checklist

1. **Bump** `"version"` in `package.json` (e.g. `2.0.0`; a pre-release suffix like `2.1.0-beta.1` makes a
   GitHub pre-release, which installed apps never offer as an update).
2. **Changelog**: add a `## [2.0.0] — <date>` section to `CHANGELOG.md`. Its body becomes the release
   notes (on GitHub and in the app's update panel); the release fails early without it.
3. **Lockfile**: if `package.json` dependencies changed, let *Actions › Lockfile* commit
   `package-lock.json` (§5.2) — a release never builds without a matching lockfile.
4. **Commit, tag, push**:
   ```bash
   git tag v2.0.0
   git push origin v2.0.0
   ```
5. **Watch `.github/workflows/release.yml`** (three jobs):
   - **build** (windows-latest, read-only token): checks the tag equals `v<package.json version>` and that
     `CHANGELOG.md` has the section; installs dependencies with `npm ci --ignore-scripts` from the
     committed lockfile (fails if it is missing or stale, §5.2) and runs only the install scripts reviewed
     in `scripts/install-scripts.mjs` (`--check` fails the release on a new, unreviewed one; `--run` runs
     esbuild's); typechecks and tests **with no secrets in the environment**; builds; packages (and signs,
     if configured) with `--publish never` in a single step that alone sees the certificate; verifies the
     fuses; checks the update files (`release-assets.mjs check`: `latest.yml` version == tag, its file
     name, sha512 and size match the installer, the `.blockmap` exists, `resources/app-update.yml` points
     at this repository); writes `release-notes.md` from the changelog and `SHA256SUMS.txt` over the
     installer, the blockmap and `latest.yml`; uploads all five.
   - **smoke** (windows-latest): installs and launches the new installer exactly like CI's windows-smoke,
     then downloads the latest *published* release with `gh release download` (the job's read-only token)
     and runs the **upgrade smoke** (§6.2). When there is no earlier release with a
     `Pevqori-Setup-*.exe` asset, or it is not older, the upgrade smoke is skipped with a notice.
   - **publish** (ubuntu-latest, the only job with `contents: write`; no checkout, no npm): verifies the
     checksums and that `latest.yml` names the tag's version, then creates the GitHub Release in **one**
     step with the changelog section as its body and four files: `Pevqori-Setup-<version>.exe`,
     `Pevqori-Setup-<version>.exe.blockmap`, `latest.yml`, `SHA256SUMS.txt` (`fail_on_unmatched_files`;
     tags containing `-` are marked pre-release).
6. **After publishing**: install the new version over the previous one on a real PC once (*Help › Check
   for Updates…* in the previous version should offer it). Never replace or delete the assets of a
   published release: installed apps check the downloaded installer against the sha512 in that
   release's `latest.yml`. Fix a bad release with a new version instead.

Verifying a download on Windows:

```powershell
Get-FileHash .\Pevqori-Setup-2.0.0.exe -Algorithm SHA256   # compare with SHA256SUMS.txt
```

### 6.2 Installer smoke scenarios (`scripts/smoke-installed.ps1`)

All scenarios run against throw-away profile and data folders (plus a marker file in
`%APPDATA%\Pevqori`), on a machine without Pevqori installed, and end by uninstalling and checking that
the data folder, the settings folder and `%APPDATA%\Pevqori` are still there.

| Scenario | What it proves |
|---|---|
| default (`-Installer`) | fresh per-user install; core worker unpacked; `resources\app-update.yml` present; the installed app passes its smoke run |
| `-Previous <old setup.exe>` (upgrade) | install N−1 and run it; install N silently **without** a folder: still exactly one uninstall entry (same key), the same install folder, `DisplayVersion` and `Pevqori.exe` version N, every file in the data and settings folders unchanged; N passes its smoke run; installing N−1 again is refused with exit code 4 (when N−1 has the guard, i.e. 2.0.0 or later) |
| `-Scenario RunningApp` | a silent install while Pevqori is open waits ~30 s, exits with code 3 and changes nothing; Pevqori is still running; after it is closed normally the same install succeeds |
| `-Scenario Downgrade` | with a newer `DisplayVersion` registered, a silent install exits with code 4 and changes nothing; with `/ALLOWDOWNGRADE` it installs and `DisplayVersion` is N again |

Per-machine ("Anyone who uses this computer") upgrades follow the same code path with the HKLM key, but
the CI scenarios exercise per-user installs only: check a per-machine upgrade by hand on a real PC
before a release that changes `build/installer.nsh` or the `nsis` options.

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
   and electron-builder signs `Pevqori.exe`, the uninstaller and the installer automatically.
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
| Rendering glitches on a specific PC | start with `PEVQORI_DISABLE_GPU=1` |
| electron-builder cannot download NSIS/winCodeSign | proxy/firewall; set `ELECTRON_BUILDER_BINARIES_MIRROR` or run in CI |
| `Electron fuses could not be applied` | run `npm install` (installs `@electron/fuses`); for a throw-away local build only, `PEVQORI_ALLOW_UNFUSED=1` |
| "The accounting engine failed to start" / `Cannot find module …core-worker.cjs` | `out/main/core-worker.cjs` missing (rebuild), or in a packaged app `asarUnpack` was removed from `electron-builder.yml` |
| windows-smoke fails | download the `windows-smoke-evidence` artifact (the app's `pevqori.log`); look for `Smoke test failed:` and `Quit:` lines |
| A silent install exits with code 3 | Pevqori (or one of its helper processes) is still running — under this account for a per-user installation, under any account for a per-machine one; close it and run the installer again — the installer never closes it |
| A silent install exits with code 4 | a newer version is installed; installing an older one is refused. If you really mean it (the newer version never opened your companies), add `/ALLOWDOWNGRADE` |
| `release-assets.mjs check` fails | `latest.yml` / `.blockmap` / `app-update.yml` missing → `publish` was removed from `electron-builder.yml`; a version or sha512 mismatch → a stale `release/` folder: delete it and package again |
| Release fails at "Check CHANGELOG.md…" | add a `## [<version>]` section to `CHANGELOG.md`, commit, move the tag |
| E2E `afterAll` reports the app did not quit | the `[electron]` output shows the `Quit:` steps (`src/main/quit.ts`); the app exits at the latest 40 s after its last window closed |
