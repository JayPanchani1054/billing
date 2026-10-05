/**
 * Test helpers for the GST module (used by *.test.ts only): insert vouchers + gst_lines rows directly
 * (the way the posting engine writes them, see src/core/modules/vouchers/README.md §4) and a realistic
 * April-2026 dataset with hand-computed return figures (see dataset comments).
 */
import { randomUUID } from 'node:crypto';
import type { GstNature, Taxability } from '../../../shared/types/gst.ts';
import type { BindValue } from '../../db/db.ts';
import { createTestCompany, makeGstin, testPan, type TestCompany, type TestCompanyOptions } from '../../testing/fixtures.ts';

export type DocType = 'sales' | 'purchase' | 'credit_note' | 'debit_note';

export interface LineSpec {
  taxable: number;
  igst?: number;
  cgst?: number;
  sgst?: number;
  cess?: number;
  rate?: number;
  cessRate?: number;
  hsn?: string | null;
  desc?: string;
  uqc?: string;
  qty?: number | null;
  kind?: 'goods' | 'services';
  tax?: Taxability;
  rc?: boolean;
  itc?: 'inputs' | 'capital_goods' | 'input_services' | 'ineligible' | null;
  itemId?: number;
}

export interface DocSpec {
  type: DocType;
  number: string | null;
  date: string;
  party: number;
  nature: GstNature | null;
  pos?: string | null;
  lines: LineSpec[];
  /** Party snapshot overrides (default: from the ledger). */
  partyName?: string;
  partyGstin?: string | null;
  partyState?: string | null;
  partyReg?: string | null;
  partyAddress?: string | null;
  partyPincode?: string | null;
  rc?: boolean;
  optional?: boolean;
  cancelled?: boolean;
  postDated?: boolean;
  /** Invoice value; default Σ taxable + Σ tax (tax left out for reverse charge / imports) + roundOff. */
  total?: number;
  roundOff?: number;
  refNo?: string | null;
  refDate?: string | null;
  origNo?: string | null;
  origDate?: string | null;
  exportDetails?: Record<string, unknown>;
  consignee?: Record<string, unknown>;
  dispatch?: Record<string, unknown>;
  irn?: string | null;
  irnStatus?: string | null;
  ewayBillNo?: string | null;
  /** Post Dr Input / Cr "Payable (Reverse Charge)" entries for the RCM tax. */
  rcmLiability?: boolean;
  /** Override voucher type id. */
  voucherTypeId?: number;
}

/** Insert a voucher with its gst_lines (and RCM liability entries when asked). Returns the voucher id. */
export function insertDoc(t: TestCompany, d: DocSpec): number {
  const ts = t.clock.now().toISOString();
  const led = t.db.get<{ name: string; mailing_name: string | null; address: string | null; state_code: string | null; gstin: string | null; gst_registration_type: string | null; pincode: string | null }>(
    'SELECT name, mailing_name, address, state_code, gstin, gst_registration_type, pincode FROM ledgers WHERE id = :id',
    { id: d.party },
  );
  if (!led) throw new Error(`insertDoc: unknown party ${d.party}`);
  const taxable = d.lines.reduce((s, l) => s + l.taxable, 0);
  const tax = d.lines.reduce((s, l) => s + (l.igst ?? 0) + (l.cgst ?? 0) + (l.sgst ?? 0) + (l.cess ?? 0), 0);
  const notPayable = d.rc || d.nature === 'import_goods' || d.nature === 'import_services';
  const roundOff = d.roundOff ?? 0;
  const total = d.total ?? taxable + (notPayable ? 0 : tax) + roundOff;
  const inBooks = !(d.optional || d.cancelled);
  const seq = d.number && /(\d+)\D*$/.exec(d.number) ? Number((/(\d+)\D*$/.exec(d.number) as RegExpExecArray)[1]) : null;
  const row: Record<string, BindValue> = {
    guid: randomUUID(),
    voucher_type_id: d.voucherTypeId ?? t.ids.voucherTypes[d.type],
    base_type: d.type,
    number: d.number,
    number_seq: seq,
    date: d.date,
    reference_no: d.refNo ?? null,
    reference_date: d.refDate ?? null,
    party_ledger_id: d.party,
    party_name: d.partyName ?? led.mailing_name ?? led.name,
    party_address: d.partyAddress !== undefined ? d.partyAddress : led.address,
    party_state_code: d.partyState !== undefined ? d.partyState : led.state_code,
    party_gstin: d.partyGstin !== undefined ? d.partyGstin : led.gstin,
    party_registration_type: d.partyReg !== undefined ? d.partyReg : led.gst_registration_type,
    party_pincode: d.partyPincode !== undefined ? d.partyPincode : led.pincode,
    place_of_supply: d.pos === undefined ? null : d.pos,
    invoice_mode: 'item',
    is_optional: d.optional ? 1 : 0,
    is_post_dated: d.postDated ? 1 : 0,
    is_cancelled: d.cancelled ? 1 : 0,
    affects_books: inBooks ? 1 : 0,
    affects_stock: 0,
    is_reverse_charge: d.rc ? 1 : 0,
    total_amount: d.cancelled ? 0 : total,
    taxable_amount: d.cancelled ? 0 : taxable,
    tax_amount: d.cancelled ? 0 : tax,
    round_off: d.cancelled ? 0 : roundOff,
    gst_nature: d.nature,
    original_invoice_no: d.origNo ?? null,
    original_invoice_date: d.origDate ?? null,
    irn: d.irn ?? null,
    irn_status: d.irnStatus ?? null,
    eway_bill_no: d.ewayBillNo ?? null,
    consignee: d.consignee ? JSON.stringify(d.consignee) : null,
    dispatch: d.dispatch ? JSON.stringify(d.dispatch) : null,
    export_details: d.exportDetails ? JSON.stringify(d.exportDetails) : null,
    created_at: ts,
    updated_at: ts,
  };
  const keys = Object.keys(row);
  return t.db.transaction(() => {
    const id = t.db.run(`INSERT INTO vouchers (${keys.join(', ')}) VALUES (${keys.map((k) => `:${k}`).join(', ')})`, row).lastInsertRowid;
    if (d.cancelled) return id;
    d.lines.forEach((l, i) => {
      const kind = l.kind ?? (l.hsn?.startsWith('99') ? 'services' : 'goods');
      t.db.run(
        `INSERT INTO gst_lines (voucher_id, line_no, source, item_id, description, hsn_sac, uqc, qty, supply_type, taxability, rate, cess_rate,
                                taxable_value, igst, cgst, sgst, cess, is_reverse_charge, itc_eligibility, date, affects_books, is_post_dated)
         VALUES (:v, :n, :src, :item, :desc, :hsn, :uqc, :qty, :kind, :tax, :rate, :cr, :tv, :ig, :cg, :sg, :cs, :rc, :itc, :date, :ab, :pd)`,
        {
          v: id,
          n: i + 1,
          src: l.itemId ? 'item' : kind === 'services' ? 'ledger' : 'item',
          item: l.itemId ?? null,
          desc: l.desc ?? null,
          hsn: l.hsn === undefined ? null : l.hsn,
          uqc: l.uqc ?? (kind === 'services' ? 'NA' : 'NOS'),
          qty: l.qty === undefined ? (kind === 'services' ? null : 1) : l.qty,
          kind,
          tax: l.tax ?? 'taxable',
          rate: l.rate ?? 0,
          cr: l.cessRate ?? 0,
          tv: l.taxable,
          ig: l.igst ?? 0,
          cg: l.cgst ?? 0,
          sg: l.sgst ?? 0,
          cs: l.cess ?? 0,
          rc: l.rc || d.rc ? 1 : 0,
          itc: d.type === 'purchase' || d.type === 'debit_note' ? (l.itc === undefined ? 'inputs' : l.itc) : null,
          date: d.date,
          ab: inBooks ? 1 : 0,
          pd: d.postDated ? 1 : 0,
        },
      );
    });
    if (d.rcmLiability) {
      const sum = (k: 'igst' | 'cgst' | 'sgst'): number => d.lines.reduce((s, l) => s + (l[k] ?? 0), 0);
      let lineNo = 1;
      for (const [head, amount] of [
        ['IGST', sum('igst')],
        ['CGST', sum('cgst')],
        ['SGST', sum('sgst')],
      ] as const) {
        if (amount === 0) continue;
        for (const [code, signed] of [
          [`INPUT_${head}`, amount],
          [`RCM_${head}`, -amount],
        ] as const) {
          t.db.run(
            `INSERT INTO ledger_entries (voucher_id, line_no, ledger_id, amount, role, gst_duty_head, date, affects_books)
             VALUES (:v, :n, :l, :a, 'tax', :h, :d, 1)`,
            { v: id, n: lineNo++, l: t.ids.ledgers[code as 'INPUT_IGST'], a: signed, h: head, d: d.date },
          );
        }
      }
    }
    return id;
  });
}

export interface Dataset {
  t: TestCompany;
  /** Party ledger ids by short name. */
  P: Record<string, number>;
  /** Voucher ids by document number. */
  V: Record<string, number>;
}

/** Parties used by the datasets. Company: Maharashtra (27), GSTIN makeGstin('27'). */
export function setupParties(opts: TestCompanyOptions = {}): { t: TestCompany; P: Record<string, number> } {
  const t = createTestCompany({ today: '2026-05-10', ...opts });
  const P: Record<string, number> = {};
  const debtor = 'SUNDRY_DEBTORS' as const;
  const creditor = 'SUNDRY_CREDITORS' as const;
  P.acme = t.addLedger({ name: 'Acme Industries', group: debtor, gstin: makeGstin('27', testPan(1)), address: 'Plot 5, MIDC\nAndheri East\nMumbai', columns: { pincode: '400093' } });
  P.bharat = t.addLedger({ name: 'Bharat Traders', group: debtor, gstin: makeGstin('29', testPan(2)), address: '44 Residency Road\nBengaluru', columns: { pincode: '560025' } });
  P.cash = t.addLedger({ name: 'Walk-in Customer', group: debtor, stateCode: '27', registrationType: 'consumer' });
  P.delhi = t.addLedger({ name: 'Delhi Retail Buyer', group: debtor, stateCode: '07', registrationType: 'unregistered', address: '9 Karol Bagh, New Delhi', columns: { pincode: '110005' } });
  P.global = t.addLedger({ name: 'Global Imports LLC', group: debtor, registrationType: 'overseas', address: '500 Fifth Avenue\nNew York', columns: { country: 'USA', state_code: null } });
  P.sez = t.addLedger({ name: 'SEZ Unit Pvt Ltd', group: debtor, gstin: makeGstin('24', testPan(6)), registrationType: 'sez', address: 'GIFT City SEZ\nGandhinagar', columns: { pincode: '382355' } });
  P.deemed = t.addLedger({ name: 'Deemed Exporter Ltd', group: debtor, gstin: makeGstin('33', testPan(7)), registrationType: 'deemed_export', address: 'SIPCOT\nChennai', columns: { pincode: '600058' } });
  P.comp = t.addLedger({ name: 'Composition Buyer', group: debtor, gstin: makeGstin('08', testPan(11)), registrationType: 'composition', address: 'MI Road\nJaipur', columns: { pincode: '302001' } });
  P.steel = t.addLedger({ name: 'Steel Suppliers', group: creditor, gstin: makeGstin('27', testPan(12)) });
  P.kc = t.addLedger({ name: 'Karnataka Components', group: creditor, gstin: makeGstin('29', testPan(13)) });
  P.gta = t.addLedger({ name: 'GTA Transport Co', group: creditor, gstin: makeGstin('27', testPan(8)) });
  P.lawyer = t.addLedger({ name: 'Lawyer Associates', group: creditor, stateCode: '27', registrationType: 'unregistered' });
  P.us = t.addLedger({ name: 'US Software Inc', group: creditor, registrationType: 'overseas', columns: { country: 'USA', state_code: null } });
  P.cmpSupplier = t.addLedger({ name: 'Small Composition Supplier', group: creditor, gstin: makeGstin('29', testPan(14)), registrationType: 'composition' });
  return { t, P };
}

/**
 * April 2026 — every table of GSTR-1 / GSTR-3B touched once (company in Maharashtra, 27).
 *
 * Outward ('Sales' S-n, 'Credit Note' CN-n):
 *   S-1  02-Apr B2B intra Acme: 7208 10 KGS 1,000.00 @18 (C/S 90.00 each) + 8471 5 NOS 500.00 @5 (C/S 12.50) = 1,705.00
 *   S-2  03-Apr B2B inter Bharat (29): 7208 20 KGS 2,000.00 @18 IGST 360.00 + exempt rice 1006 300.00 = 2,660.00
 *   S-3  04-Apr B2B outward reverse charge Acme: SAC 996511 1,000.00 @5 (C/S 25.00) — invoice value 1,000.00 (4B)
 *   S-4  05-Apr B2CL Delhi (07): 8471 5 NOS 84,750.00 @18 IGST 15,255.00 = 1,00,005.00 (just above ₹1,00,000)
 *   S-5  06-Apr B2CS inter Delhi: 8471 5 NOS 84,745.76 @18 IGST 15,254.24 = 1,00,000.00 exactly (stays B2CS)
 *   S-6  07-Apr B2CS intra walk-in: 8471 2 NOS 200.00 @18 (C/S 18.00) + 7208 1 KGS 100.00 @5 (C/S 2.50) = 341.00
 *   S-7  08-Apr B2CS intra walk-in: 8471 1 NOS 300.00 @18 (C/S 27.00) = 354.00
 *   S-8  09-Apr export WPAY Global: 8471 10 NOS 5,000.00 @18 IGST 900.00, SB 1234567 / 10-Apr / INNSA1 = 5,900.00
 *   S-9  10-Apr export WOPAY (LUT) Global: 7208 100 KGS 10,000.00 @18 (no tax, no shipping bill yet) = 10,000.00
 *   S-10 11-Apr SEZ without payment (24): 8471 4 NOS 4,000.00 @18 = 4,000.00
 *   S-11 12-Apr SEZ with payment (24): 8471 1 NOS 1,000.00 @18 IGST 180.00 = 1,180.00
 *   S-12 13-Apr deemed export (33): 8471 2 NOS 2,000.00 @18 IGST 360.00 = 2,360.00
 *   S-13 14-Apr nil/non-GST walk-in: milk 0401 100 LTR nil 500.00 + petrol 2710 70 LTR non-GST 700.00 = 1,200.00
 *   S-14 15-Apr B2B inter composition buyer (08): 8471 1 NOS 600.00 @18 IGST 108.00 = 708.00
 *   S-15 16-Apr cancelled (only in Table 13) · S-16 17-Apr optional (nowhere)
 *   CN-1 20-Apr Bharat against S-2: 7208 5 KGS 500.00 @18 IGST 90.00 = 590.00 (CDNR)
 *   CN-2 21-Apr Delhi against S-4 (B2CL): 8471 1 NOS 10,000.00 @18 IGST 1,800.00 = 11,800.00 (CDNUR B2CL)
 *   CN-3 22-Apr walk-in, no original reference: 8471 1 NOS 100.00 @18 (C/S 9.00) = 118.00 (netted in B2CS)
 * Inward ('Purchase' P-n, 'Debit Note' DN-n):
 *   P-1 05-Apr Steel (27) SS/101: 7208 3,000.00 @18 C/S 270.00 each (inputs)
 *   P-2 06-Apr Karnataka Components (29) KC-55: 8471 5,000.00 @18 IGST 900.00 (capital goods)
 *       + food 996331 200.00 @5 IGST 10.00 (ineligible, s.17(5))
 *   P-3 07-Apr GTA (27, registered) RCM: 996511 1,000.00 @5 C/S 25.00 (with RCM liability entries)
 *   P-4 08-Apr lawyer (unregistered) RCM: 998213 500.00 @18 C/S 45.00 — no supplier invoice no., no RCM liability
 *   P-5 09-Apr import of services US Software INV-US-9: 998314 2,000.00 @18 IGST 360.00 (RCM entries)
 *   P-6 10-Apr import of goods BOE-778: 8471 10,000.00 IGST 1,800.00
 *   P-7 11-Apr Steel SS/120: nil-rated milk 400.00 + non-GST petrol 250.00 (intra)
 *   P-8 12-Apr composition supplier (29) CMP-1: 300.00 (no tax)
 *   DN-1 25-Apr purchase return to Steel against P-1: 7208 500.00 @18 C/S 45.00 each
 */
export function aprilDataset(opts: TestCompanyOptions = {}): Dataset {
  const { t, P } = setupParties(opts);
  const V: Record<string, number> = {};
  const add = (d: DocSpec): void => {
    V[d.number ?? `#${Object.keys(V).length + 1}`] = insertDoc(t, d);
  };
  const steel = (taxable: number, rate: number, extra: Partial<LineSpec> = {}): LineSpec => ({ hsn: '72081000', desc: 'HR Steel Coil', uqc: 'KGS', rate, taxable, ...extra });
  const pc = (taxable: number, rate: number, extra: Partial<LineSpec> = {}): LineSpec => ({ hsn: '84713010', desc: 'Laptop', uqc: 'NOS', rate, taxable, ...extra });

  add({ type: 'sales', number: 'S-1', date: '2026-04-02', party: P.acme, nature: 'b2b', pos: '27', lines: [steel(100000, 18, { qty: 10, cgst: 9000, sgst: 9000 }), pc(50000, 5, { qty: 5, cgst: 1250, sgst: 1250 })] });
  add({
    type: 'sales',
    number: 'S-2',
    date: '2026-04-03',
    party: P.bharat,
    nature: 'b2b',
    pos: '29',
    lines: [steel(200000, 18, { qty: 20, igst: 36000 }), { hsn: '1006', desc: 'Rice', uqc: 'KGS', qty: 100, tax: 'exempt', taxable: 30000 }],
  });
  add({ type: 'sales', number: 'S-3', date: '2026-04-04', party: P.acme, nature: 'b2b', pos: '27', rc: true, lines: [{ hsn: '996511', desc: 'Goods transport', kind: 'services', rate: 5, taxable: 100000, cgst: 2500, sgst: 2500 }] });
  add({ type: 'sales', number: 'S-4', date: '2026-04-05', party: P.delhi, nature: 'b2cl', pos: '07', lines: [pc(8475000, 18, { qty: 5, igst: 1525500 })] });
  add({ type: 'sales', number: 'S-5', date: '2026-04-06', party: P.delhi, nature: 'b2cs', pos: '07', lines: [pc(8474576, 18, { qty: 5, igst: 1525424 })] });
  add({ type: 'sales', number: 'S-6', date: '2026-04-07', party: P.cash, nature: 'b2cs', pos: '27', lines: [pc(20000, 18, { qty: 2, cgst: 1800, sgst: 1800 }), steel(10000, 5, { qty: 1, cgst: 250, sgst: 250 })] });
  add({ type: 'sales', number: 'S-7', date: '2026-04-08', party: P.cash, nature: 'b2cs', pos: '27', lines: [pc(30000, 18, { qty: 1, cgst: 2700, sgst: 2700 })] });
  add({
    type: 'sales',
    number: 'S-8',
    date: '2026-04-09',
    party: P.global,
    nature: 'export_wpay',
    pos: '96',
    exportDetails: { shippingBillNo: '1234567', shippingBillDate: '2026-04-10', portCode: 'INNSA1', withPayment: true, lut: false, currency: 'USD' },
    lines: [pc(500000, 18, { qty: 10, igst: 90000 })],
  });
  add({ type: 'sales', number: 'S-9', date: '2026-04-10', party: P.global, nature: 'export_lut', pos: '96', exportDetails: { withPayment: false, lut: true }, lines: [steel(1000000, 18, { qty: 100 })] });
  add({ type: 'sales', number: 'S-10', date: '2026-04-11', party: P.sez, nature: 'sez_lut', pos: '24', lines: [pc(400000, 18, { qty: 4 })] });
  add({ type: 'sales', number: 'S-11', date: '2026-04-12', party: P.sez, nature: 'sez_wpay', pos: '24', lines: [pc(100000, 18, { qty: 1, igst: 18000 })] });
  add({ type: 'sales', number: 'S-12', date: '2026-04-13', party: P.deemed, nature: 'deemed_export', pos: '33', lines: [pc(200000, 18, { qty: 2, igst: 36000 })] });
  add({
    type: 'sales',
    number: 'S-13',
    date: '2026-04-14',
    party: P.cash,
    nature: 'nil_exempt',
    pos: '27',
    lines: [
      { hsn: '0401', desc: 'Milk', uqc: 'LTR', qty: 100, tax: 'nil_rated', taxable: 50000 },
      { hsn: '2710', desc: 'Petrol', uqc: 'LTR', qty: 70, tax: 'non_gst', taxable: 70000 },
    ],
  });
  add({ type: 'sales', number: 'S-14', date: '2026-04-15', party: P.comp, nature: 'b2b', pos: '08', lines: [pc(60000, 18, { qty: 1, igst: 10800 })] });
  add({ type: 'sales', number: 'S-15', date: '2026-04-16', party: P.acme, nature: 'b2b', pos: '27', cancelled: true, lines: [] });
  add({ type: 'sales', number: 'S-16', date: '2026-04-17', party: P.acme, nature: 'b2b', pos: '27', optional: true, lines: [pc(10000, 18, { cgst: 900, sgst: 900 })] });
  add({ type: 'credit_note', number: 'CN-1', date: '2026-04-20', party: P.bharat, nature: 'b2b', pos: '29', origNo: 'S-2', origDate: '2026-04-03', lines: [steel(50000, 18, { qty: 5, igst: 9000 })] });
  add({ type: 'credit_note', number: 'CN-2', date: '2026-04-21', party: P.delhi, nature: 'b2cs', pos: '07', origNo: 'S-4', origDate: '2026-04-05', lines: [pc(1000000, 18, { qty: 1, igst: 180000 })] });
  add({ type: 'credit_note', number: 'CN-3', date: '2026-04-22', party: P.cash, nature: 'b2cs', pos: '27', lines: [pc(10000, 18, { qty: 1, cgst: 900, sgst: 900 })] });

  add({ type: 'purchase', number: 'P-1', date: '2026-04-05', party: P.steel, nature: 'inward_b2b', refNo: 'SS/101', refDate: '2026-04-04', lines: [steel(300000, 18, { qty: 30, cgst: 27000, sgst: 27000 })] });
  add({
    type: 'purchase',
    number: 'P-2',
    date: '2026-04-06',
    party: P.kc,
    nature: 'inward_b2b',
    refNo: 'KC-55',
    refDate: '2026-04-06',
    lines: [pc(500000, 18, { qty: 5, igst: 90000, itc: 'capital_goods' }), { hsn: '996331', desc: 'Staff lunch', kind: 'services', rate: 5, taxable: 20000, igst: 1000, itc: 'ineligible' }],
  });
  add({
    type: 'purchase',
    number: 'P-3',
    date: '2026-04-07',
    party: P.gta,
    nature: 'inward_rcm',
    rc: true,
    refNo: 'LR-77',
    refDate: '2026-04-07',
    rcmLiability: true,
    lines: [{ hsn: '996511', desc: 'Freight inward', kind: 'services', rate: 5, taxable: 100000, cgst: 2500, sgst: 2500, itc: 'input_services' }],
  });
  add({
    type: 'purchase',
    number: 'P-4',
    date: '2026-04-08',
    party: P.lawyer,
    nature: 'inward_rcm',
    rc: true,
    lines: [{ hsn: '998213', desc: 'Legal fees', kind: 'services', rate: 18, taxable: 50000, cgst: 4500, sgst: 4500, itc: 'input_services' }],
  });
  add({
    type: 'purchase',
    number: 'P-5',
    date: '2026-04-09',
    party: P.us,
    nature: 'import_services',
    rc: true,
    refNo: 'INV-US-9',
    refDate: '2026-04-01',
    rcmLiability: true,
    lines: [{ hsn: '998314', desc: 'Cloud hosting', kind: 'services', rate: 18, taxable: 200000, igst: 36000, itc: 'input_services' }],
  });
  add({ type: 'purchase', number: 'P-6', date: '2026-04-10', party: P.global, nature: 'import_goods', refNo: 'BOE-778', refDate: '2026-04-09', lines: [pc(1000000, 18, { qty: 10, igst: 180000 })] });
  add({
    type: 'purchase',
    number: 'P-7',
    date: '2026-04-11',
    party: P.steel,
    nature: 'inward_nil_exempt',
    refNo: 'SS/120',
    refDate: '2026-04-11',
    lines: [
      { hsn: '0401', desc: 'Milk', uqc: 'LTR', qty: 80, tax: 'nil_rated', taxable: 40000 },
      { hsn: '2710', desc: 'Petrol', uqc: 'LTR', qty: 25, tax: 'non_gst', taxable: 25000 },
    ],
  });
  add({ type: 'purchase', number: 'P-8', date: '2026-04-12', party: P.cmpSupplier, nature: 'inward_composition', refNo: 'CMP-1', refDate: '2026-04-12', lines: [steel(30000, 0, { qty: 3 })] });
  add({ type: 'debit_note', number: 'DN-1', date: '2026-04-25', party: P.steel, nature: 'inward_b2b', origNo: 'SS/101', origDate: '2026-04-04', lines: [steel(50000, 18, { qty: 5, cgst: 4500, sgst: 4500 })] });
  return { t, P, V };
}
