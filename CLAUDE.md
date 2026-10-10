# Pevqori — agent guide

Offline-first GST accounting/invoicing/inventory desktop app for India (Electron + React + node:sqlite).
**Read `docs/ARCHITECTURE.md` before writing code** — it is the contract (data conventions, API routes,
posting rules, GST rules, UI/UX rules, security rules, ownership).

Essentials:
- Money is integer **paise**; Debit positive, Credit negative; each voucher's entries sum to 0.
- `src/core/**` and `src/shared/**`: only `node:*` imports, no npm packages. Relative imports end in `.ts`.
  No enums/namespaces/parameter properties (native type stripping). `import type` for types.
- npm is unavailable in the dev container. Local checks: `tsc -p tsconfig.core.json`,
  `tsc -p tsconfig.web.offline.json`, `tsc -p tsconfig.node.offline.json` (React/Electron via
  `types/offline` shims) and `node --test "src/**/*.test.ts"`. Bundling/rendering runs in CI only.
- Edit only the files your task owns; shared contract files are extend-only.
- Never interpolate user input into SQL; never use `dangerouslySetInnerHTML`.
