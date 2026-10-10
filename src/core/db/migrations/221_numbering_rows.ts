/**
 * dataplus group (block 220–229), part 2: dated prefix / suffix rows of voucher numbering (TallyPrime
 * "Prefix / Suffix details — Applicable from"). The voucher type's own numbering_prefix /
 * numbering_suffix apply from the beginning; a row replaces it for vouchers dated on or after
 * `applicable_from` (text NULL = no prefix / suffix from that date). Prefix / suffix texts may hold the
 * tokens {FY} {FYYYYY} {YY} {MM} {MMM} (src/shared/numbering.ts), expanded with the voucher date when
 * the number is allocated — numbers already given are never changed.
 *
 * Depends only on voucher_types (001_init).
 */
export const migration221 = {
  version: 221,
  name: 'numbering_rows',
  sql: /* sql */ `
CREATE TABLE voucher_type_numbering_rows (
  id              INTEGER PRIMARY KEY,
  voucher_type_id INTEGER NOT NULL REFERENCES voucher_types(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('prefix', 'suffix')),
  applicable_from TEXT NOT NULL,
  text            TEXT,
  UNIQUE (voucher_type_id, kind, applicable_from)
);
`,
} as const;
