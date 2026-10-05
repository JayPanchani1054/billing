# Bahi ERP — Build, package and release

## 1. Toolchain

| Tool | Version | Used for |
|---|---|---|
| Node.js | ≥ 22.18 (type stripping on by default) | scripts, tests, core |
| Electron | ^44 (devDependency) | desktop runtime (bundles Chromium + Node with `node:sqlite`) |
| esbuild | ^0.25 | bundles `src/main` and `src/preload` to CommonJS |
| Vite + @vitejs/plugin-react | ^7 / ^5 | builds the React renderer |
| TypeScript | ^6 | typechecking only (`noEmit`) — code runs via esbuild/Vite or Node type stripping |
| electron-builder | ^26 | Windows NSIS installer |
| Playwright | ^1.55 | Electron end-to-end tests |

All dependencies are `devDependencies`: everything the app needs at runtime is bundled into `out/`,
so the installer ships no `node_modules`. There are **no native modules** (SQLite comes from
`node:sqlite` inside Electron), so no Visual Studio / Python / `electron-rebuild` is required.

## 2. Scripts

| Command | What it does |
|---|---|
| `npm run dev` | `scripts/dev.mjs`: Vite dev server on `http://127.0.0.1:5173` (HMR), esbuild watch for main + preload, launches Electron with `BAHI_DEV_SERVER_URL`; restarts Electron when main/preload/core code changes; `Ctrl+C` stops everything |
| `npm run build` | `scripts/build.mjs`: cleans `out/`, bundles main + preload (minified, no source maps), checks the preload only requires `electron`, builds the renderer with Vite |
| `node scripts/build.mjs --dev` | same, but unminified main/preload with linked source maps |
| `npm start` | runs `electron .` against the existing `out/` |
| `npm run typecheck` | `tsc` for core, node (main/preload) and web (renderer) projects |
| `npm test` | `node --test "src/**/*.test.ts"` (core, shared and main-process unit tests) |
| `npm run e2e` | Playwright smoke tests against `out/` (run `npm run build` first) |
| `npm run dist:win` | build + `electron-builder --win --x64` → `release/Bahi-ERP-Setup-<version>.exe` |
| `npm run dist:dir` | build + unpacked app in `release/win-unpacked/` (fast packaging check) |
| `node scripts/make-icon.mjs` | regenerates `build/icon.png` (512 px) and `build/icon.ico` (16–256 px) |

## 3. Build pipeline

```
src/main/index.ts ──esbuild (cjs, node22, external electron + node:*)──▶ out/main/index.cjs
src/preload/index.ts ──esbuild (cjs)───────────────────────────────────▶ out/preload/index.cjs
src/renderer/index.html ──vite build (chrome130, base './')────────────▶ out/renderer/**
```

- `package.json` → `"main": "out/main/index.cjs"`. The `.cjs` extension matters because the package is
  `"type": "module"`.
- esbuild defines `process.env.NODE_ENV`, `__BAHI_VERSION__` (from package.json) and maps
  `import.meta.url/dirname/filename` for CommonJS. Shared options live in `scripts/build-config.mjs`.
- The preload is bundled self-contained: sandboxed preloads may only `require('electron')`. The build
  fails if anything else appears in `out/preload/index.cjs`.
- The renderer is served at runtime from `app://bahi/` (not `file://`), which is why Vite uses a
  relative `base: './'`. Production builds contain no source maps (set `BAHI_SOURCEMAP=1` for a local
  debugging build).
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
- `scripts/after-pack.cjs` flips Electron fuses (see [SECURITY.md §3.7](SECURITY.md#37-packaged-binary--scriptsafter-packcjs)).
  It uses `@electron/fuses`, which electron-builder installs; if it is missing the build prints a
  warning and continues. Set `BAHI_REQUIRE_FUSES=1` to make that a hard failure.
- `build/installer.nsh` adds an uninstall log note that data was kept.

Cross-building the Windows installer from Linux/macOS needs Wine; use the CI job instead.

## 5. Continuous integration (`.github/workflows/ci.yml`)

Runs on every push and pull request:

1. **verify** (ubuntu-latest, Node 22): `npm install --no-audit --no-fund` (no lockfile yet; Electron
   binary download skipped), `npm run typecheck`, `npm test`, `npm run build`; uploads `out/`.
2. **windows-installer** (windows-latest, needs verify): `npm run dist:win`, computes `SHA256SUMS.txt`,
   uploads the **Bahi-ERP-Windows-Installer** artifact (kept 30 days).
3. **e2e** (ubuntu-latest, needs verify): builds, re-enables unprivileged user namespaces so Chromium's
   sandbox works on Ubuntu 24.04, then `xvfb-run npx playwright test`. Reports are uploaded on failure.

npm, Electron and electron-builder downloads are cached.

## 6. Releasing

1. Bump `"version"` in `package.json` (semver; use a pre-release suffix like `0.2.0-beta.1` for betas).
2. Commit, then tag and push:
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```
3. `.github/workflows/release.yml` checks the tag equals `v<package.json version>`, runs typecheck and
   tests, builds the installer on `windows-latest`, and publishes a GitHub Release with
   `Bahi-ERP-Setup-<version>.exe` and `SHA256SUMS.txt` (tags containing `-` are marked pre-release).

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
   workflow exports them only when present, and electron-builder signs `Bahi ERP.exe`, the uninstaller
   and the installer automatically.
3. **With a cloud HSM/Trusted Signing:** configure electron-builder's `win.azureSignOptions` (Azure
   Trusted Signing) or a custom `win.signtoolOptions.sign` script that calls the vendor's signing tool,
   and provide credentials as repository secrets.
4. Once signed, consider `BAHI_REQUIRE_FUSES=1` in the release workflow and set
   `win.signtoolOptions.publisherName` to the certificate subject.

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
