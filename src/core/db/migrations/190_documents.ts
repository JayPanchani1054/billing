/**
 * Documents group (src/core/modules/documents), part 1: quotations / proforma invoices and the
 * reversing journal's "applicable up to" date.
 *
 *  - vouchers.valid_until      Quotation / Proforma Invoice: last date the offer holds (input.validUntil).
 *  - vouchers.applicable_upto  Reversing Journal: the journal counts in scenario reports only while the
 *                              report date is on or before it (input.applicableUpto).
 *    Both are written by the documents voucher hook (vouchers/hooks.ts) in the save transaction.
 *  - document_status           accepted / rejected decision on a quotation or proforma (no row = open;
 *                              "expired" and "converted" are derived, never stored).
 *  - document_links            quotation/proforma → the sales order / sales invoice it was converted
 *                              into. A target belongs to one source (UNIQUE); deleting either side
 *                              removes the link (the quotation is open again). A cancelled target does
 *                              not count as a conversion (checked in queries).
 *  - Predefined voucher types 'Quotation' and 'Proforma Invoice' for companies created before this
 *    version (new companies get them from seed.ts / PREDEFINED_VOUCHER_TYPES). Skipped on a fresh,
 *    not yet seeded database (no company row) so the seed does not collide; a company that already has
 *    a type of that name (e.g. a custom "Quotation" under Sales Order) gets "<name> (Bahi)" instead.
 *    Own numbering series (automatic, yearly) — never the GST invoice series.
 */
const UUID = `lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))`;
const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

function predefinedType(name: string, abbreviation: string, base: string): string {
  return `
INSERT INTO voucher_types (guid, name, abbreviation, base_type, is_predefined, numbering_method, numbering_restart, config, created_at, updated_at)
SELECT ${UUID},
       CASE WHEN EXISTS (SELECT 1 FROM voucher_types WHERE name = '${name}') THEN '${name} (Bahi)' ELSE '${name}' END,
       '${abbreviation}', '${base}', 1, 'automatic', 'yearly', '{}', ${NOW}, ${NOW}
 WHERE EXISTS (SELECT 1 FROM company)
   AND NOT EXISTS (SELECT 1 FROM voucher_types WHERE base_type = '${base}' AND is_predefined = 1);`;
}

export const migration190 = {
  version: 190,
  name: 'documents',
  sql: /* sql */ `
ALTER TABLE vouchers ADD COLUMN valid_until TEXT;
ALTER TABLE vouchers ADD COLUMN applicable_upto TEXT;

CREATE TABLE document_status (
  voucher_id  INTEGER PRIMARY KEY REFERENCES vouchers(id) ON DELETE CASCADE,
  status      TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
  reason      TEXT,
  changed_at  TEXT NOT NULL,
  changed_by  INTEGER
);

CREATE TABLE document_links (
  id                INTEGER PRIMARY KEY,
  source_voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  target_voucher_id INTEGER NOT NULL UNIQUE REFERENCES vouchers(id) ON DELETE CASCADE,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_document_links_source ON document_links(source_voucher_id);
${predefinedType('Quotation', 'Quote', 'quotation')}
${predefinedType('Proforma Invoice', 'Pro Inv', 'proforma')}
`,
} as const;
