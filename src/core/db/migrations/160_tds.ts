/**
 * TDS / TCS module (src/core/modules/tds): nature-of-payment / nature-of-goods masters with
 * effective-dated rates and thresholds, TDS details of ledgers, the derived per-voucher tds_lines
 * (rebuilt with the voucher by the tds voucher hook, like gst_lines), challans, quarterly statement
 * filing status (late fee u/s 234E) and imported Form 26AS / AIS rows (TDS receivable).
 *
 * Seed: the sections of the Income-tax Act 1961 a business deducts / collects under, as in force for
 * FY 2024-25 and FY 2025-26 (Finance (No. 2) Act 2024 and Finance Act 2025 changes dated). Rows are
 * user-editable masters (TDS/TCS › Natures). Amounts are paise, rates percent. Uncertain points are
 * marked in the `note` of the row and in src/core/modules/tds/README.md:
 *  - 195 (non-residents) is seeded at 20% as a placeholder: the rate depends on the income and the DTAA.
 *  - section_2025 holds only the parent section of the Income-tax Act 2025 (393 TDS / 394 TCS); the
 *    table serial numbers are not seeded. Rates and thresholds for tax year 2026-27 are assumed
 *    unchanged from FY 2025-26 (no new rows) — verify against the Finance Act 2026.
 *
 * Version 160 is in the tds block (160–169), above every version shipped before (150).
 */

interface SeedRate {
  from: string;
  ind: number;
  co: number;
  oth: number;
  noPan: number;
  single: number | null;
  agg: number | null;
  period?: 'fy' | 'month';
  basis?: 'whole' | 'excess';
  gst?: boolean;
  note?: string;
}
interface SeedNature {
  kind: 'tds' | 'tcs';
  name: string;
  section: string;
  s2025: string;
  nr?: boolean;
  rates: SeedRate[];
}

const L = 100_000_00; // ₹1 lakh in paise

const NATURES: readonly SeedNature[] = [
  {
    kind: 'tds',
    name: 'Payment to contractors / sub-contractors',
    section: '194C',
    s2025: '393',
    rates: [
      {
        from: '2024-04-01', ind: 1, co: 2, oth: 2, noPan: 20, single: 30_000_00, agg: 1 * L,
        note: 'Above ₹30,000 in one payment or ₹1,00,000 in the year. Transporters owning up to 10 goods carriages who give PAN and a declaration: no deduction (s.194C(6)) — record a nil certificate.',
      },
    ],
  },
  {
    kind: 'tds',
    name: 'Commission or brokerage',
    section: '194H',
    s2025: '393',
    rates: [
      { from: '2024-04-01', ind: 5, co: 5, oth: 5, noPan: 20, single: null, agg: 15_000_00 },
      { from: '2024-10-01', ind: 2, co: 2, oth: 2, noPan: 20, single: null, agg: 15_000_00, note: 'Rate 2% from 1-Oct-2024 (Finance (No. 2) Act 2024).' },
      { from: '2025-04-01', ind: 2, co: 2, oth: 2, noPan: 20, single: null, agg: 20_000_00, note: 'Threshold ₹20,000 from 1-Apr-2025 (Finance Act 2025).' },
    ],
  },
  {
    kind: 'tds',
    name: 'Rent – plant, machinery or equipment',
    section: '194I(a)',
    s2025: '393',
    rates: [
      { from: '2024-04-01', ind: 2, co: 2, oth: 2, noPan: 20, single: null, agg: 2_40_000_00 },
      {
        from: '2025-04-01', ind: 2, co: 2, oth: 2, noPan: 20, single: null, agg: 50_000_00, period: 'month',
        note: 'From 1-Apr-2025: rent above ₹50,000 for a month or part of a month (Finance Act 2025); tested per calendar month.',
      },
    ],
  },
  {
    kind: 'tds',
    name: 'Rent – land, building or furniture',
    section: '194I(b)',
    s2025: '393',
    rates: [
      { from: '2024-04-01', ind: 10, co: 10, oth: 10, noPan: 20, single: null, agg: 2_40_000_00 },
      {
        from: '2025-04-01', ind: 10, co: 10, oth: 10, noPan: 20, single: null, agg: 50_000_00, period: 'month',
        note: 'From 1-Apr-2025: rent above ₹50,000 for a month or part of a month (Finance Act 2025); tested per calendar month.',
      },
    ],
  },
  {
    kind: 'tds',
    name: 'Fees for technical services, call centre, royalty for films',
    section: '194J(a)',
    s2025: '393',
    rates: [
      { from: '2024-04-01', ind: 2, co: 2, oth: 2, noPan: 20, single: null, agg: 30_000_00 },
      { from: '2025-04-01', ind: 2, co: 2, oth: 2, noPan: 20, single: null, agg: 50_000_00, note: 'Threshold ₹50,000 per category from 1-Apr-2025 (Finance Act 2025).' },
    ],
  },
  {
    kind: 'tds',
    name: 'Fees for professional services, royalty, non-compete fees',
    section: '194J(b)',
    s2025: '393',
    rates: [
      { from: '2024-04-01', ind: 10, co: 10, oth: 10, noPan: 20, single: null, agg: 30_000_00 },
      {
        from: '2025-04-01', ind: 10, co: 10, oth: 10, noPan: 20, single: null, agg: 50_000_00,
        note: 'Threshold ₹50,000 per category from 1-Apr-2025. Directors’ fees / commission (s.194J(1)(ba)) have no threshold — add a nature without one.',
      },
    ],
  },
  {
    kind: 'tds',
    name: 'Interest other than on securities',
    section: '194A',
    s2025: '393',
    rates: [
      { from: '2024-04-01', ind: 10, co: 10, oth: 10, noPan: 20, single: null, agg: 5_000_00 },
      {
        from: '2025-04-01', ind: 10, co: 10, oth: 10, noPan: 20, single: null, agg: 10_000_00,
        note: 'Payers other than banks / co-operative banks / post office: ₹10,000 from 1-Apr-2025 (Finance Act 2025).',
      },
    ],
  },
  {
    kind: 'tds',
    name: 'Purchase of goods',
    section: '194Q',
    s2025: '393',
    rates: [
      {
        from: '2024-04-01', ind: 0.1, co: 0.1, oth: 0.1, noPan: 5, single: null, agg: 50 * L, basis: 'excess',
        note: 'Only when the buyer’s turnover exceeded ₹10 crore in the preceding year (TDS/TCS setup). On purchases above ₹50 lakh from a seller in the year, excluding GST (CBDT Circular 13/2021).',
      },
    ],
  },
  {
    kind: 'tds',
    name: 'Benefit or perquisite of a business or profession',
    section: '194R',
    s2025: '393',
    rates: [{ from: '2024-04-01', ind: 10, co: 10, oth: 10, noPan: 20, single: null, agg: 20_000_00 }],
  },
  {
    kind: 'tds',
    name: 'Payments by a firm to its partners',
    section: '194T',
    s2025: '393',
    rates: [
      {
        from: '2025-04-01', ind: 10, co: 10, oth: 10, noPan: 20, single: null, agg: 20_000_00,
        note: 'Salary, remuneration, commission, bonus or interest to a partner above ₹20,000 in the year; from 1-Apr-2025 (Finance (No. 2) Act 2024).',
      },
    ],
  },
  {
    kind: 'tds',
    name: 'Other sums payable to a non-resident',
    section: '195',
    s2025: '393',
    nr: true,
    rates: [
      {
        from: '2024-04-01', ind: 20, co: 20, oth: 20, noPan: 20, single: null, agg: null,
        note: 'PLACEHOLDER — the rate depends on the nature of income, the DTAA and surcharge + 4% cess. Set the rate for each remittance (override) or keep a certificate.',
      },
    ],
  },
  {
    kind: 'tcs',
    name: 'Sale of scrap',
    section: '206C(1)',
    s2025: '394',
    rates: [{ from: '2024-04-01', ind: 1, co: 1, oth: 1, noPan: 5, single: null, agg: null, gst: true }],
  },
  {
    kind: 'tcs',
    name: 'Sale of alcoholic liquor for human consumption',
    section: '206C(1)',
    s2025: '394',
    rates: [{ from: '2024-04-01', ind: 1, co: 1, oth: 1, noPan: 5, single: null, agg: null, gst: true }],
  },
  {
    kind: 'tcs',
    name: 'Sale of minerals (coal, lignite, iron ore)',
    section: '206C(1)',
    s2025: '394',
    rates: [{ from: '2024-04-01', ind: 1, co: 1, oth: 1, noPan: 5, single: null, agg: null, gst: true }],
  },
  {
    kind: 'tcs',
    name: 'Sale of tendu leaves',
    section: '206C(1)',
    s2025: '394',
    rates: [{ from: '2024-04-01', ind: 5, co: 5, oth: 5, noPan: 10, single: null, agg: null, gst: true }],
  },
  {
    kind: 'tcs',
    name: 'Sale of timber or other forest produce',
    section: '206C(1)',
    s2025: '394',
    rates: [{ from: '2024-04-01', ind: 2.5, co: 2.5, oth: 2.5, noPan: 5, single: null, agg: null, gst: true }],
  },
  {
    kind: 'tcs',
    name: 'Sale of a motor vehicle above ₹10 lakh',
    section: '206C(1F)',
    s2025: '394',
    rates: [
      {
        from: '2024-04-01', ind: 1, co: 1, oth: 1, noPan: 5, single: 10 * L, agg: null, gst: true,
        note: 'Value above ₹10 lakh per sale. From 22-Apr-2025 notified luxury goods above ₹10 lakh are also covered (add a nature if you sell them).',
      },
    ],
  },
];

const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const n = (x: number | null): string => (x === null ? 'NULL' : String(x));
const GUID = `lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))`;
const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

const seedSql = NATURES.map((nat) => {
  const head = `INSERT INTO tds_natures (guid, kind, name, section, section_2025, for_non_residents, is_system, is_active, created_at, updated_at)
VALUES (${GUID}, ${q(nat.kind)}, ${q(nat.name)}, ${q(nat.section)}, ${q(nat.s2025)}, ${nat.nr ? 1 : 0}, 1, 1, ${NOW}, ${NOW});`;
  const rates = nat.rates
    .map(
      (r) => `INSERT INTO tds_nature_rates (nature_id, applicable_from, rate_individual, rate_company, rate_others, rate_no_pan, threshold_single,
  threshold_aggregate, aggregate_period, threshold_basis, base_includes_gst, note)
VALUES ((SELECT id FROM tds_natures WHERE kind = ${q(nat.kind)} AND name = ${q(nat.name)}), ${q(r.from)}, ${r.ind}, ${r.co}, ${r.oth}, ${r.noPan},
  ${n(r.single)}, ${n(r.agg)}, ${q(r.period ?? 'fy')}, ${q(r.basis ?? 'whole')}, ${r.gst ? 1 : 0}, ${r.note ? q(r.note) : 'NULL'});`,
    )
    .join('\n');
  return `${head}\n${rates}`;
}).join('\n');

export const migration160 = {
  version: 160,
  name: 'tds',
  sql: /* sql */ `
-- Nature of payment (TDS) / nature of goods (TCS).
CREATE TABLE tds_natures (
  id                 INTEGER PRIMARY KEY,
  guid               TEXT NOT NULL UNIQUE,
  kind               TEXT NOT NULL CHECK (kind IN ('tds','tcs')),
  name               TEXT NOT NULL,
  section            TEXT NOT NULL,          -- Income-tax Act 1961 section, e.g. '194C', '206C(1F)'
  section_2025       TEXT,                   -- Income-tax Act 2025 reference (hint, user-editable)
  for_non_residents  INTEGER NOT NULL DEFAULT 0,
  is_system          INTEGER NOT NULL DEFAULT 0,
  is_active          INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (kind, name)
);

-- Effective-dated rates and thresholds of a nature.
CREATE TABLE tds_nature_rates (
  id                  INTEGER PRIMARY KEY,
  nature_id           INTEGER NOT NULL REFERENCES tds_natures(id) ON DELETE CASCADE,
  applicable_from     TEXT NOT NULL,
  rate_individual     REAL NOT NULL,
  rate_company        REAL NOT NULL,
  rate_others         REAL NOT NULL,
  rate_no_pan         REAL NOT NULL,
  threshold_single    INTEGER,               -- paise; NULL = none
  threshold_aggregate INTEGER,               -- paise; NULL = none
  aggregate_period    TEXT NOT NULL DEFAULT 'fy' CHECK (aggregate_period IN ('fy','month')),
  threshold_basis     TEXT NOT NULL DEFAULT 'whole' CHECK (threshold_basis IN ('whole','excess')),
  base_includes_gst   INTEGER NOT NULL DEFAULT 0,
  note                TEXT,
  UNIQUE (nature_id, applicable_from)
);

-- TDS/TCS details of a ledger: expense / sales ledgers (applicable + nature), parties (deductee type,
-- default nature, lower-deduction certificate, deductor TAN of a customer), and the duty ledgers the
-- module created (payable_kind / payable_section). PAN stays in ledgers.pan.
CREATE TABLE tds_ledger_details (
  ledger_id        INTEGER PRIMARY KEY REFERENCES ledgers(id) ON DELETE CASCADE,
  applicable       INTEGER NOT NULL DEFAULT 0,
  nature_id        INTEGER REFERENCES tds_natures(id) ON DELETE SET NULL,
  deductee_type    TEXT CHECK (deductee_type IN ('company','individual','firm','others')),
  non_resident     INTEGER NOT NULL DEFAULT 0,
  cert_number      TEXT,
  cert_rate        REAL,
  cert_from        TEXT,
  cert_to          TEXT,
  cert_limit       INTEGER,
  cert_nature_id   INTEGER REFERENCES tds_natures(id) ON DELETE SET NULL,
  payable_kind     TEXT CHECK (payable_kind IN ('tds','tcs','receivable')),
  payable_section  TEXT,
  deductor_tan     TEXT,                   -- customer who deducts TDS from us: its TAN (Form 26AS match key)
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_tds_ledger_nature ON tds_ledger_details(nature_id) WHERE nature_id IS NOT NULL;
CREATE UNIQUE INDEX idx_tds_ledger_payable ON tds_ledger_details(payable_kind, payable_section) WHERE payable_kind IN ('tds','tcs');

-- Derived: one row per nature computed on a voucher (rebuilt on every save; removed on cancel/delete).
CREATE TABLE tds_lines (
  id                INTEGER PRIMARY KEY,
  voucher_id        INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  line_no           INTEGER NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('tds','tcs')),
  nature_id         INTEGER NOT NULL REFERENCES tds_natures(id),
  section           TEXT NOT NULL,
  party_ledger_id   INTEGER REFERENCES ledgers(id),
  deductee_type     TEXT NOT NULL,
  pan               TEXT,
  pan_status        TEXT NOT NULL,
  non_resident      INTEGER NOT NULL DEFAULT 0,
  assessable        INTEGER NOT NULL,
  catch_up          INTEGER NOT NULL DEFAULT 0,
  base              INTEGER NOT NULL,
  rate              REAL NOT NULL,
  computed          INTEGER NOT NULL,
  amount            INTEGER NOT NULL,
  overridden        INTEGER NOT NULL DEFAULT 0,
  reason            TEXT,
  status            TEXT NOT NULL,
  payable_ledger_id INTEGER REFERENCES ledgers(id),
  note              TEXT,
  date              TEXT NOT NULL,
  affects_books     INTEGER NOT NULL,
  is_post_dated     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_tds_lines_voucher ON tds_lines(voucher_id);
CREATE INDEX idx_tds_lines_party ON tds_lines(party_ledger_id, nature_id, date);
CREATE INDEX idx_tds_lines_section ON tds_lines(kind, section, date);

-- Derived: challan details of a payment voucher that deposits TDS/TCS (from VoucherInput.tds.challan).
CREATE TABLE tds_challans (
  id             INTEGER PRIMARY KEY,
  voucher_id     INTEGER NOT NULL UNIQUE REFERENCES vouchers(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('tds','tcs')),
  section        TEXT NOT NULL,
  period         TEXT NOT NULL,              -- YYYY-MM of deduction / collection
  bsr_code       TEXT NOT NULL,
  challan_no     TEXT NOT NULL,
  deposit_date   TEXT NOT NULL,
  minor_head     TEXT NOT NULL DEFAULT '200',
  tax            INTEGER NOT NULL,
  surcharge      INTEGER NOT NULL DEFAULT 0,
  cess           INTEGER NOT NULL DEFAULT 0,
  interest       INTEGER NOT NULL DEFAULT 0,
  fee            INTEGER NOT NULL DEFAULT 0,
  others         INTEGER NOT NULL DEFAULT 0,
  date           TEXT NOT NULL,
  affects_books  INTEGER NOT NULL,
  is_post_dated  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_tds_challans_section ON tds_challans(kind, section, period);

-- Filing status of the quarterly statements (late fee u/s 234E).
CREATE TABLE tds_statements (
  id          INTEGER PRIMARY KEY,
  form        TEXT NOT NULL CHECK (form IN ('26Q','27Q','27EQ')),
  fy_start    INTEGER NOT NULL,              -- 2025 for FY 2025-26
  quarter     INTEGER NOT NULL CHECK (quarter BETWEEN 1 AND 4),
  filed_on    TEXT,
  token_no    TEXT,
  note        TEXT,
  updated_at  TEXT NOT NULL,
  UNIQUE (form, fy_start, quarter)
);

-- Form 26AS / AIS rows imported for TDS receivable reconciliation (tax deducted by customers).
CREATE TABLE tds_26as (
  id               INTEGER PRIMARY KEY,
  batch            TEXT NOT NULL,
  fy_start         INTEGER NOT NULL,
  deductor_tan     TEXT,
  deductor_name    TEXT NOT NULL,
  section          TEXT,
  txn_date         TEXT NOT NULL,
  amount_paid      INTEGER NOT NULL,
  tds_amount       INTEGER NOT NULL,
  imported_at      TEXT NOT NULL
);
CREATE INDEX idx_tds_26as_fy ON tds_26as(fy_start, deductor_tan);

-- New permissions for the system roles of existing companies (new companies get them from SYSTEM_ROLES).
UPDATE roles SET permissions = json_insert(permissions, '$[#]', 'tds.view')
 WHERE is_system = 1 AND name IN ('Accountant', 'Auditor')
   AND json_valid(permissions) AND NOT EXISTS (SELECT 1 FROM json_each(roles.permissions) WHERE value = 'tds.view');
UPDATE roles SET permissions = json_insert(permissions, '$[#]', 'tds.manage')
 WHERE is_system = 1 AND name = 'Accountant'
   AND json_valid(permissions) AND NOT EXISTS (SELECT 1 FROM json_each(roles.permissions) WHERE value = 'tds.manage');
UPDATE roles SET permissions = json_insert(permissions, '$[#]', 'tds.file')
 WHERE is_system = 1 AND name = 'Accountant'
   AND json_valid(permissions) AND NOT EXISTS (SELECT 1 FROM json_each(roles.permissions) WHERE value = 'tds.file');

${seedSql}
`,
} as const;
