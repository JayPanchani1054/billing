# Bahi ERP — agent guide

Offline-first GST accounting/invoicing/inventory desktop app for India (Electron + React + node:sqlite).
**Read `docs/ARCHITECTURE.md` before writing code** — it is the contract (data conventions, API routes,
posting rules, GST rules, UI/UX rules, security rules, ownership).

Essentials:
- Money is integer **paise**; Debit positive, Credit negative; each voucher's entries sum to 0.
- `src/core/**` and `src/shared/**`: only `node:*` imports, no npm packages. Relative imports end in `.ts`.
  No enums/namespaces/parameter properties (native type stripping). `import type` for types.
- npm is unavailable in the dev container. Local checks: `tsc -p tsconfig.core.json` and
  `node --test "src/**/*.test.ts"`. Renderer/main code is verified in CI only — write it carefully.
- Edit only the files your task owns; shared contract files are extend-only.
- Never interpolate user input into SQL; never use `dangerouslySetInnerHTML`.
