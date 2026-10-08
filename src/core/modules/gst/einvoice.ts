/**
 * e-Invoice (IRP schema 1.1): pending list with readiness checks, bulk JSON for the IRP offline /
 * bulk-generation tool, import of the IRP response (IRN, ack no./date, signed QR, e-way bill) and
 * marking an IRN cancelled.
 *
 * Mapping (per voucher, from gst_lines — no tax recomputation):
 *   TranDtls  TaxSch 'GST'; SupTyp by nature: b2b → B2B, sez_wpay → SEZWP, sez_lut → SEZWOP,
 *             export_wpay → EXPWP, export_lut → EXPWOP, deemed_export → DEXP; RegRev Y when reverse
 *             charge; IgstOnIntra 'N'.
 *   DocDtls   Typ INV (sales) / CRN (credit note) / DBN (debit note), No, Dt dd/mm/yyyy.
 *   Seller    company profile; Buyer: voucher party snapshot (exports: Gstin 'URP', Pos/Stcd '96',
 *             Pin 999999); ShipDtls from the consignee when complete.
 *   ItemList  one item per gst_line; UnitPrice/TotAmt/Discount from the matching inventory line when
 *             the line value agrees, else TotAmt = AssAmt (no discount).
 *   ValDtls   sums of the items; RndOffAmt = voucher round-off; the rest of the invoice value
 *             (charges outside GST) → OthChrg, or Discount when negative.
 */
import { addDays, formatDate, isValidDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import { isKnownStateCode, isStandardRate, POS_OTHER_COUNTRIES, validateGstin } from '../../../shared/gst/index.ts';
import { lineAmount } from '../../../shared/money.ts';
import type {
  EinvoiceDocType,
  EinvoiceGeneratedResult,
  EinvoiceImportResult,
  EinvoicePendingResult,
  EinvoicePendingRow,
  EinvoiceSupplyType,
  GstBulkJsonFile,
  GstCancelRequiredRow,
  GstDocStatusResult,
} from '../../../shared/types/gst-returns.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { normaliseHeader } from '../../lib/csv.ts';
import { notFound, rule } from '../../lib/errors.ts';
import { decodeText, FileFormatError } from '../../lib/text.ts';
import { readXlsx } from '../../lib/xlsx.ts';
import { emailOrNull, phoneDigits, pinNumber, splitAddress } from './address.ts';
import { hsnProblem } from './checks.ts';
import type { GstCompany, GstDoc, GstDocLine } from './docs.ts';
import { docLabel, loadDocs, rupees, taxTotal } from './docs.ts';

export const EINVOICE_VERSION = '1.1';

/** IRP document number rule: 1–16 characters, letters/digits/'/'/'-', not starting with 0, '/' or '-'. */
const IRP_DOC_NO = /^[A-Za-z1-9][A-Za-z0-9/-]{0,15}$/;

const inr = (p: number): string => formatMoney(p, { symbol: true });

export function einvoiceSupplyType(d: GstDoc): EinvoiceSupplyType | null {
  switch (d.nature) {
    case 'b2b':
      return 'B2B';
    case 'sez_wpay':
      return 'SEZWP';
    case 'sez_lut':
      return 'SEZWOP';
    case 'export_wpay':
      return 'EXPWP';
    case 'export_lut':
      return 'EXPWOP';
    case 'deemed_export':
      return 'DEXP';
    default:
      return null;
  }
}

export function einvoiceDocType(d: GstDoc): EinvoiceDocType {
  return d.baseType === 'credit_note' ? 'CRN' : d.baseType === 'debit_note' ? 'DBN' : 'INV';
}

const ddmmyyyy = (iso: string | null): string => formatDate(iso, 'DD/MM/YYYY');
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

interface InvLine {
  item_id: number;
  qty: number;
  billed_qty: number | null;
  rate: number;
  amount: number;
}

/** Inventory lines of the vouchers, to recover unit price / discount for item lines. */
function inventoryLines(db: Db, ids: readonly number[]): Map<number, InvLine[]> {
  const out = new Map<number, InvLine[]>();
  if (ids.length === 0) return out;
  for (const r of db.all<InvLine & { voucher_id: number }>(
    `SELECT voucher_id, item_id, qty, billed_qty, rate, amount FROM inventory_entries
      WHERE voucher_id IN (SELECT value FROM json_each(:ids)) ORDER BY voucher_id, line_no, id`,
    { ids: JSON.stringify(ids) },
  )) {
    const list = out.get(r.voucher_id) ?? [];
    list.push(r);
    out.set(r.voucher_id, list);
  }
  return out;
}

export interface EinvoiceBuild {
  payload: Record<string, unknown>;
  errors: string[];
  warnings: string[];
}

type Json = Record<string, unknown>;

/** Build and validate the IRP payload of one voucher. */
export function buildEinvoice(d: GstDoc, company: GstCompany, inv: readonly InvLine[], today: string): EinvoiceBuild {
  const errors: string[] = [];
  const warnings: string[] = [];
  const supTyp = einvoiceSupplyType(d) ?? 'B2B';
  const exportDoc = supTyp === 'EXPWP' || supTyp === 'EXPWOP';
  const zeroNoPay = supTyp === 'SEZWOP' || supTyp === 'EXPWOP';

  // ── Document ──
  const no = (d.number ?? '').trim();
  if (!no) errors.push('The voucher has no number.');
  else if (!IRP_DOC_NO.test(no)) errors.push(`Invoice number "${no}" is not accepted by the IRP: up to 16 letters, digits, '/' or '-', not starting with 0, '/' or '-'.`);
  if (d.date > today) errors.push(`The invoice date ${formatDate(d.date)} is in the future.`);
  else if (addDays(d.date, 30) < today) {
    warnings.push(`The invoice is more than 30 days old: the IRP refuses it if your aggregate turnover is ₹10 crore or more.`);
  }

  // ── Seller ──
  const sAddr = splitAddress(company.address, company.stateCode);
  const sPin = pinNumber(company.pincode);
  if (!company.gstin || !validateGstin(company.gstin).valid) errors.push('The company GSTIN is missing or invalid (Company profile).');
  if (company.name.trim().length < 3) errors.push('The company name must have at least 3 characters.');
  if (!sAddr.addr1) errors.push('The company address is empty (Company profile).');
  if (sPin === null) errors.push('The company PIN code is missing or not 6 digits (Company profile).');
  if (!isKnownStateCode(company.stateCode)) errors.push('The company state is not set (Company profile).');
  const seller: Json = { Gstin: company.gstin ?? '', LglNm: company.name.slice(0, 100) };
  if (company.tradeName && company.tradeName !== company.name && company.tradeName.length >= 3) seller.TrdNm = company.tradeName.slice(0, 100);
  seller.Addr1 = sAddr.addr1;
  if (sAddr.addr2.length >= 3) seller.Addr2 = sAddr.addr2;
  seller.Loc = sAddr.loc;
  seller.Pin = sPin ?? 0;
  seller.Stcd = company.stateCode;
  const ph = phoneDigits(company.phone);
  if (ph) seller.Ph = ph;
  const em = emailOrNull(company.email);
  if (em) seller.Em = em;

  // ── Buyer ──
  const party = d.party;
  const buyerState = exportDoc ? POS_OTHER_COUNTRIES : party.stateCode;
  const bAddr = splitAddress(party.address, buyerState);
  const buyer: Json = {};
  if (exportDoc) {
    buyer.Gstin = 'URP';
  } else if (!party.gstin) {
    errors.push(`The party "${party.name ?? ''}" has no GSTIN.`);
    buyer.Gstin = '';
  } else {
    const g = validateGstin(party.gstin);
    if (!g.valid) errors.push(`The party GSTIN ${party.gstin} is invalid — ${g.error ?? 'check it'}.`);
    if (company.gstin && party.gstin === company.gstin) errors.push('The buyer GSTIN is the same as your own GSTIN.');
    buyer.Gstin = party.gstin;
  }
  const lgl = (party.name ?? '').trim();
  if (lgl.length < 3) errors.push('The buyer name must have at least 3 characters.');
  buyer.LglNm = lgl.slice(0, 100);
  const pos = exportDoc ? POS_OTHER_COUNTRIES : d.pos;
  if (!pos || !isKnownStateCode(pos)) errors.push('The place of supply is missing.');
  buyer.Pos = pos;
  if (!bAddr.addr1) errors.push(`The address of "${lgl}" is empty — enter it in the party ledger or on the voucher.`);
  buyer.Addr1 = bAddr.addr1;
  if (bAddr.addr2.length >= 3) buyer.Addr2 = bAddr.addr2;
  buyer.Loc = bAddr.loc.length >= 3 ? bAddr.loc : 'NA';
  const bPin = exportDoc ? 999999 : pinNumber(party.pincode);
  if (bPin === null) errors.push(`The PIN code of "${lgl}" is missing or not 6 digits — enter it in the party ledger or on the voucher.`);
  buyer.Pin = bPin ?? 0;
  if (!exportDoc && !isKnownStateCode(buyerState)) errors.push(`The state of "${lgl}" is not set.`);
  buyer.Stcd = buyerState;
  const bph = phoneDigits(party.phone);
  if (bph) buyer.Ph = bph;
  const bem = emailOrNull(party.email);
  if (bem) buyer.Em = bem;

  // ── Ship-to ──
  let ship: Json | null = null;
  const c = d.consignee;
  if (c) {
    const cs = c.stateCode || buyerState;
    const ca = splitAddress(c.address, cs);
    const cpin = pinNumber(c.pincode);
    const differs = (c.address ?? '') !== (party.address ?? '') || (c.pincode ?? '') !== (party.pincode ?? '') || cs !== buyerState;
    if (differs) {
      if (c.name && c.name.length >= 3 && ca.addr1 && cpin !== null && isKnownStateCode(cs)) {
        ship = {};
        if (c.gstin && validateGstin(c.gstin).valid) ship.Gstin = c.gstin;
        ship.LglNm = c.name.slice(0, 100);
        ship.Addr1 = ca.addr1;
        if (ca.addr2.length >= 3) ship.Addr2 = ca.addr2;
        ship.Loc = ca.loc.length >= 3 ? ca.loc : 'NA';
        ship.Pin = cpin;
        ship.Stcd = cs;
      } else {
        warnings.push('The consignee (ship-to) details are incomplete (name, address, PIN and state are needed), so they are not sent.');
      }
    }
  }

  // ── Items ──
  const lines = d.lines.filter((l) => l.taxable !== 0 || taxTotal(l) !== 0);
  if (lines.length === 0) errors.push('The voucher has no GST lines — re-save it.');
  if (lines.length > 1000) errors.push('The IRP accepts at most 1,000 items per invoice.');
  const unused = [...inv];
  const intra = !exportDoc && supTyp !== 'SEZWP' && supTyp !== 'SEZWOP' && pos === company.stateCode;
  let assVal = 0;
  let igst = 0;
  let cgst = 0;
  let sgst = 0;
  let cess = 0;
  const badHsn: number[] = [];
  const itemList = lines.map((l: GstDocLine, i: number): Json => {
    if (l.taxable < 0 || l.igst < 0 || l.cgst < 0 || l.sgst < 0 || l.cess < 0) {
      errors.push(`Line ${l.lineNo} has a negative value: the IRP accepts only positive values — apply the discount on the items instead.`);
    }
    const hp = hsnProblem(l, company.config.gst.hsnDigits < 6 ? 4 : company.config.gst.hsnDigits);
    if (hp && hp.code !== 'hsn_invalid') badHsn.push(l.lineNo);
    else if (hp) errors.push(`Line ${l.lineNo}: ${hp.text}.`);
    const services = l.supplyType === 'services';
    if (!services && l.hsn.startsWith('99')) errors.push(`Line ${l.lineNo}: HSN ${l.hsn} is a service (SAC) code but the line is goods.`);
    if (l.taxability === 'taxable' && !isStandardRate(l.rate)) errors.push(`Line ${l.lineNo}: ${l.rate}% is not a GST rate.`);
    if (zeroNoPay && (l.igst !== 0 || l.cgst !== 0 || l.sgst !== 0)) errors.push(`Line ${l.lineNo}: a supply without payment of tax (${supTyp}) cannot carry tax.`);
    if (!zeroNoPay && l.taxability === 'taxable') {
      if (intra && l.igst !== 0) errors.push(`Line ${l.lineNo}: IGST is charged on an intra-state supply.`);
      if (!intra && (l.cgst !== 0 || l.sgst !== 0)) errors.push(`Line ${l.lineNo}: CGST/SGST is charged on an inter-state supply.`);
    }

    // Unit price and discount from the inventory line with the same item and value.
    let gross = l.taxable;
    let disc = 0;
    let unitPrice: number;
    const qty = Math.abs(l.qty);
    const idx = l.itemId !== null ? unused.findIndex((x) => x.item_id === l.itemId && x.amount === l.taxable) : -1;
    unitPrice = qty > 0 ? round3(l.taxable / 100 / qty) : rupees(l.taxable);
    if (idx >= 0) {
      const x = unused.splice(idx, 1)[0];
      const q = Math.abs(x.billed_qty ?? x.qty);
      const g = lineAmount(q, x.rate);
      // Use the entered rate only when it explains the value (a discount); an apportioned charge
      // (freight absorbed into the value) makes the value larger than qty × rate.
      if (g >= l.taxable && q > 0) {
        gross = g;
        disc = g - l.taxable;
        unitPrice = round3(x.rate);
      }
    }
    assVal += l.taxable;
    igst += l.igst;
    cgst += l.cgst;
    sgst += l.sgst;
    cess += l.cess;
    const item: Json = { SlNo: String(i + 1), PrdDesc: (l.description || l.hsn || 'Item').slice(0, 300), IsServc: services ? 'Y' : 'N', HsnCd: l.hsn };
    if (!services && qty > 0) {
      item.Qty = round3(qty);
      item.Unit = l.uqc && l.uqc !== 'NA' ? l.uqc : 'OTH';
    }
    Object.assign(item, {
      UnitPrice: unitPrice,
      TotAmt: rupees(gross),
      Discount: rupees(disc),
      AssAmt: rupees(l.taxable),
      GstRt: l.taxability === 'taxable' ? l.rate : 0,
      IgstAmt: rupees(l.igst),
      CgstAmt: rupees(l.cgst),
      SgstAmt: rupees(l.sgst),
      CesRt: l.cessRate,
      CesAmt: rupees(l.cess),
      CesNonAdvlAmt: 0,
      TotItemVal: rupees(l.taxable + l.igst + l.cgst + l.sgst + l.cess),
    });
    return item;
  });
  if (badHsn.length > 0) {
    errors.push(
      `Line${badHsn.length === 1 ? '' : 's'} ${badHsn.join(', ')}: HSN/SAC missing or shorter than ${Math.max(4, company.config.gst.hsnDigits)} digits — set it in the stock item / ledger and re-save the voucher.`,
    );
  }

  // ── Totals ──
  const tax = igst + cgst + sgst + cess;
  const payableItems = assVal + (d.reverseCharge ? 0 : tax);
  const other = d.totalAmount - payableItems - d.roundOff;
  const othChrg = other > 0 ? other : 0;
  const discount = other < 0 ? -other : 0;
  const totInv = assVal + tax + othChrg - discount + d.roundOff;
  if (Math.abs(d.roundOff) > 9999) errors.push(`Round-off ${inr(d.roundOff)} is outside the ±₹99.99 the IRP allows.`);
  if (discount > assVal) errors.push(`The invoice value is lower than its taxable value by ${inr(discount)} — check the voucher.`);
  if (Math.abs(d.taxableAmount - assVal) > 100 && d.taxableAmount !== 0) {
    errors.push(`The voucher's taxable total (${inr(d.taxableAmount)}) differs from its GST lines (${inr(assVal)}) — re-save the voucher.`);
  }
  if (Math.abs(d.taxAmount - tax) > 100 && d.taxAmount !== 0) {
    errors.push(`The voucher's tax total (${inr(d.taxAmount)}) differs from its GST lines (${inr(tax)}) — re-save the voucher.`);
  }
  if (Math.abs(totInv - (assVal + tax + othChrg - discount + d.roundOff)) > 100) errors.push('Invoice totals are inconsistent (more than ₹1 apart).');
  if (othChrg > 0) warnings.push(`${inr(othChrg)} of the invoice value is outside the GST lines and is sent as "other charges".`);

  const payload: Json = {
    Version: EINVOICE_VERSION,
    TranDtls: { TaxSch: 'GST', SupTyp: supTyp, RegRev: d.reverseCharge ? 'Y' : 'N', IgstOnIntra: 'N' },
    DocDtls: { Typ: einvoiceDocType(d), No: no, Dt: ddmmyyyy(d.date) },
    SellerDtls: seller,
    BuyerDtls: buyer,
  };
  if (ship) payload.ShipDtls = ship;
  payload.ItemList = itemList;
  payload.ValDtls = {
    AssVal: rupees(assVal),
    CgstVal: rupees(cgst),
    SgstVal: rupees(sgst),
    IgstVal: rupees(igst),
    CesVal: rupees(cess),
    Discount: rupees(discount),
    OthChrg: rupees(othChrg),
    RndOffAmt: rupees(d.roundOff),
    TotInvVal: rupees(totInv),
  };

  if (d.isNote && d.originalInvoiceNo) {
    const ref: Json = { InvNo: d.originalInvoiceNo.slice(0, 16) };
    if (d.originalInvoiceDate && isValidDate(d.originalInvoiceDate)) ref.InvDt = ddmmyyyy(d.originalInvoiceDate);
    payload.RefDtls = { PrecDocDtls: [ref] };
  }

  if (exportDoc) {
    const e = d.exportDetails;
    const exp: Json = {};
    if (e?.shippingBillNo) exp.ShipBNo = e.shippingBillNo.slice(0, 20);
    if (e?.shippingBillDate && isValidDate(e.shippingBillDate)) exp.ShipBDt = ddmmyyyy(e.shippingBillDate);
    if (e?.portCode) exp.Port = e.portCode.toUpperCase().slice(0, 10);
    exp.RefClm = supTyp === 'EXPWP' ? 'Y' : 'N';
    if (e?.currency && /^[A-Za-z]{3}$/.test(e.currency)) exp.ForCur = e.currency.toUpperCase();
    payload.ExpDtls = exp;
  }

  const disp = d.dispatch;
  if (disp && (disp.vehicleNo || disp.transporterId) && disp.distanceKm !== null && disp.distanceKm >= 0) {
    const ewb: Json = {};
    if (disp.transporterId) ewb.TransId = disp.transporterId.toUpperCase();
    if (disp.transporterName) ewb.TransName = disp.transporterName.slice(0, 100);
    ewb.Distance = Math.round(disp.distanceKm);
    if (disp.lrNo) ewb.TransDocNo = disp.lrNo.slice(0, 15);
    if (disp.lrDate && isValidDate(disp.lrDate)) ewb.TransDocDt = ddmmyyyy(disp.lrDate);
    if (disp.vehicleNo) {
      ewb.VehNo = disp.vehicleNo.replace(/[\s-]/g, '').toUpperCase();
      ewb.VehType = 'R';
      ewb.TransMode = transModeCode(disp.mode) ?? '1';
    }
    payload.EwbDtls = ewb;
  }

  return { payload, errors: [...new Set(errors)], warnings };
}

/** Transport mode code: 1 road, 2 rail, 3 air, 4 ship. */
export function transModeCode(mode: string | null): '1' | '2' | '3' | '4' | null {
  const m = (mode ?? '').trim().toLowerCase();
  if (!m) return null;
  if (m === '1' || m.startsWith('road')) return '1';
  if (m === '2' || m.startsWith('rail')) return '2';
  if (m === '3' || m.startsWith('air')) return '3';
  if (m === '4' || m.startsWith('ship') || m.startsWith('sea')) return '4';
  return null;
}

const EINVOICE_NATURES = new Set(['b2b', 'sez_wpay', 'sez_lut', 'export_wpay', 'export_lut', 'deemed_export']);

function needsIrn(d: GstDoc): boolean {
  return (
    d.direction === 'outward' &&
    d.inBooks &&
    EINVOICE_NATURES.has(d.nature) &&
    (d.irnStatus === null || d.irnStatus === '' || d.irnStatus === 'pending') &&
    !d.irn
  );
}

export function pendingEinvoices(db: Db, company: GstCompany, from: string, to: string, today: string): EinvoicePendingResult {
  const docs = loadDocs(db, company, { from, to, today, baseTypes: ['sales', 'credit_note', 'debit_note'] }).filter(needsIrn);
  const inv = inventoryLines(
    db,
    docs.map((d) => d.id),
  );
  const rows: EinvoicePendingRow[] = docs.map((d) => {
    const b = buildEinvoice(d, company, inv.get(d.id) ?? [], today);
    return {
      voucherId: d.id,
      number: d.number,
      date: d.date,
      voucherTypeName: d.voucherTypeName,
      partyName: d.party.name,
      gstin: d.party.gstin,
      supplyType: einvoiceSupplyType(d) ?? 'B2B',
      docType: einvoiceDocType(d),
      invoiceValue: d.totalAmount,
      irnStatus: d.irnStatus,
      ready: b.errors.length === 0,
      errors: b.errors,
      warnings: b.warnings,
    };
  });
  return { enabled: company.features.einvoice, rows, cancelRequired: cancelledWithActiveRef(db, 'irn', from, to) };
}

/** Vouchers cancelled in the books that still carry an active IRN ('irn') or an e-way bill ('eway'). */
export function cancelledWithActiveRef(db: Db, kind: 'irn' | 'eway', from: string, to: string): GstCancelRequiredRow[] {
  const cond = kind === 'irn' ? "v.irn IS NOT NULL AND v.irn_status = 'generated'" : "v.eway_bill_no IS NOT NULL AND v.eway_bill_no <> ''";
  return db
    .all<{ id: number; number: string | null; date: string; vt_name: string; party_name: string | null; ref: string; ref_date: string | null }>(
      `SELECT v.id, v.number, v.date, vt.name AS vt_name, v.party_name,
              ${kind === 'irn' ? 'v.irn' : 'v.eway_bill_no'} AS ref, ${kind === 'irn' ? 'v.irn_ack_date' : 'v.eway_bill_date'} AS ref_date
         FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
        WHERE v.is_cancelled = 1 AND v.date >= :from AND v.date <= :to AND ${cond}
        ORDER BY v.date, v.id`,
      { from, to },
    )
    .map((r) => ({ voucherId: r.id, number: r.number, date: r.date, voucherTypeName: r.vt_name, partyName: r.party_name, refNo: r.ref, refDate: r.ref_date }));
}

const DOC_TYPE_BY_BASE: Readonly<Record<string, EinvoiceDocType>> = { sales: 'INV', credit_note: 'CRN', debit_note: 'DBN' };

/**
 * IRP acknowledgement date-time ('YYYY-MM-DD HH:mm:ss', Indian time as the IRP gives it; a bare date
 * counts as midnight) + 24 hours → ISO UTC instant until which the IRN can be cancelled; null when the
 * ack date is missing or unreadable.
 */
export function irnCancellableUntil(ackDate: string | null): string | null {
  if (!ackDate) return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(ackDate.trim());
  if (!m || !isValidDate(m[1])) return null;
  const t = Date.parse(`${m[1]}T${m[2] ?? '00'}:${m[3] ?? '00'}:${m[4] ?? '00'}+05:30`);
  return Number.isFinite(t) ? new Date(t + 24 * 3600 * 1000).toISOString() : null;
}

/**
 * Sales / credit / debit notes in the range whose IRN is active (irn_status 'generated'), whether or
 * not they count in the books — so an IRN can be marked cancelled after it was cancelled on the IRP.
 */
export function generatedEinvoices(db: Db, from: string, to: string, now: Date): EinvoiceGeneratedResult {
  const rows = db
    .all<{
      id: number;
      number: string | null;
      date: string;
      base_type: string;
      vt_name: string;
      party_name: string | null;
      party_gstin: string | null;
      total_amount: number;
      irn: string;
      irn_ack_no: string | null;
      irn_ack_date: string | null;
      is_cancelled: number;
    }>(
      `SELECT v.id, v.number, v.date, v.base_type, vt.name AS vt_name, v.party_name, v.party_gstin, v.total_amount,
              v.irn, v.irn_ack_no, v.irn_ack_date, v.is_cancelled
         FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
        WHERE v.base_type IN ('sales', 'credit_note', 'debit_note')
          AND v.irn IS NOT NULL AND v.irn <> '' AND v.irn_status = 'generated'
          AND v.date >= :from AND v.date <= :to
        ORDER BY v.date, v.id`,
      { from, to },
    )
    .map((r) => {
      const until = irnCancellableUntil(r.irn_ack_date);
      return {
        voucherId: r.id,
        number: r.number,
        date: r.date,
        voucherTypeName: r.vt_name,
        partyName: r.party_name,
        gstin: r.party_gstin,
        docType: DOC_TYPE_BY_BASE[r.base_type] ?? 'INV',
        invoiceValue: r.total_amount,
        irn: r.irn,
        ackNo: r.irn_ack_no,
        ackDate: r.irn_ack_date,
        cancelledInBooks: r.is_cancelled === 1,
        cancellableUntil: until,
        cancelWindowOpen: until !== null && Date.parse(until) > now.getTime(),
      };
    });
  return { rows };
}

/** Log a document event (e-invoice / e-way bill trail). */
export function logDocEvent(ctx: CompanyCtx, voucherId: number | null, kind: 'einvoice' | 'ewaybill', action: string, refNo: string | null, detail: unknown): void {
  ctx.db.run(
    `INSERT INTO gst_doc_events (voucher_id, kind, action, ref_no, detail, ts, user_id, username)
     VALUES (:vid, :kind, :action, :ref, :detail, :ts, :uid, :uname)`,
    {
      vid: voucherId,
      kind,
      action,
      ref: refNo,
      detail: detail === undefined ? null : JSON.stringify(detail),
      ts: ctx.clock.now().toISOString(),
      uid: ctx.session.userId,
      uname: ctx.session.username,
    },
  );
}

/** Bulk JSON (array of IRP documents) for the selected vouchers. Vouchers with errors are left out and listed. */
export function einvoiceJson(ctx: CompanyCtx, company: GstCompany, voucherIds: readonly number[]): GstBulkJsonFile {
  const today = ctx.clock.today();
  const docs = loadDocs(ctx.db, company, { from: '', to: '', today, ids: voucherIds, anyDate: true, baseTypes: ['sales', 'credit_note', 'debit_note'] });
  const found = new Set(docs.map((d) => d.id));
  const rejected: GstBulkJsonFile['rejected'] = [];
  for (const id of voucherIds) if (!found.has(id)) rejected.push({ voucherId: id, number: null, errors: ['Voucher not found, or it does not count in the books (optional / cancelled).'] });
  const inv = inventoryLines(
    ctx.db,
    docs.map((d) => d.id),
  );
  const payloads: Array<Record<string, unknown>> = [];
  const accepted: GstDoc[] = [];
  const warnings: string[] = [];
  for (const d of docs) {
    if (d.direction !== 'outward' || !EINVOICE_NATURES.has(d.nature)) {
      rejected.push({ voucherId: d.id, number: d.number, errors: [`${docLabel(d)} is not a B2B, SEZ, export or deemed-export supply, so it needs no e-invoice.`] });
      continue;
    }
    if (d.irn && d.irnStatus === 'generated') {
      rejected.push({ voucherId: d.id, number: d.number, errors: [`${docLabel(d)} already has IRN ${d.irn}.`] });
      continue;
    }
    const b = buildEinvoice(d, company, inv.get(d.id) ?? [], today);
    if (b.errors.length > 0) {
      rejected.push({ voucherId: d.id, number: d.number, errors: b.errors });
      continue;
    }
    for (const w of b.warnings) warnings.push(`${docLabel(d)}: ${w}`);
    payloads.push(b.payload);
    accepted.push(d);
  }
  if (payloads.length === 0) {
    throw rule('None of the selected vouchers can be exported for e-invoicing. Fix the errors listed and try again.', { rejected });
  }
  const fileName = `EINV_${company.gstin ?? 'GSTIN'}_${today.replace(/-/g, '')}_${payloads.length}.json`;
  ctx.db.transaction(() => {
    for (const d of accepted) logDocEvent(ctx, d.id, 'einvoice', 'exported', null, { fileName });
    ctx.audit({ action: 'export', entityType: 'einvoice', entityLabel: `${fileName} (${payloads.length} document${payloads.length === 1 ? '' : 's'})` });
  });
  return { fileName, json: JSON.stringify(payloads), warnings, documents: payloads.length, rejected };
}

// ───────────────────────────── IRP response import ─────────────────────────────

interface IrpRecord {
  docNo: string | null;
  docDate: string | null;
  docType: string | null;
  irn: string | null;
  ackNo: string | null;
  ackDate: string | null;
  signedQr: string | null;
  ewbNo: string | null;
  ewbDate: string | null;
  ewbValidTill: string | null;
  error: string | null;
}

const KEY = (k: string): string => k.toLowerCase().replace(/[^a-z0-9]/g, '');

const FIELD_KEYS: Readonly<Record<keyof IrpRecord, readonly string[]>> = {
  docNo: ['docno', 'documentno', 'documentnumber', 'docnumber', 'invoiceno', 'invno', 'no'],
  docDate: ['docdt', 'docdate', 'documentdate', 'documentdt', 'invoicedate', 'invdt', 'dt'],
  docType: ['doctyp', 'doctype', 'documenttype', 'typ'],
  irn: ['irn', 'irnno'],
  ackNo: ['ackno', 'acknowledgementno', 'acknumber'],
  ackDate: ['ackdt', 'ackdate', 'acknowledgementdate'],
  signedQr: ['signedqrcode', 'signedqr', 'qrcode'],
  ewbNo: ['ewbno', 'ewaybillno', 'ewbnumber'],
  ewbDate: ['ewbdt', 'ewbdate', 'ewaybilldate'],
  ewbValidTill: ['ewbvalidtill', 'ewbvalidupto', 'validupto', 'validtill'],
  error: ['errordetails', 'errormessage', 'errors', 'error', 'errordesc', 'remarks'],
};

function cellText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    const parts = v.map((x) => (typeof x === 'object' && x ? Object.values(x as Record<string, unknown>).map(String).join(' ') : String(x)));
    return parts.length ? parts.join('; ') : null;
  }
  return null;
}

/** Payload of a JWT (signed QR code / signed invoice): its "data" claim parsed, or null. */
export function jwtData(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    const data = (payload as Record<string, unknown>).data;
    if (typeof data === 'string') {
      const d: unknown = JSON.parse(data);
      return d && typeof d === 'object' ? (d as Record<string, unknown>) : null;
    }
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function recordFrom(obj: Record<string, unknown>): IrpRecord {
  const flat = new Map<string, unknown>();
  const visit = (o: Record<string, unknown>, depth: number): void => {
    for (const [k, v] of Object.entries(o)) {
      const key = KEY(k);
      if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2) visit(v as Record<string, unknown>, depth + 1);
      else if (!flat.has(key)) flat.set(key, v);
    }
  };
  visit(obj, 0);
  const rec = {} as IrpRecord;
  for (const f of Object.keys(FIELD_KEYS) as Array<keyof IrpRecord>) {
    rec[f] = null;
    for (const k of FIELD_KEYS[f]) {
      const t = cellText(flat.get(k));
      if (t !== null) {
        rec[f] = t;
        break;
      }
    }
  }
  // Doc no./date are not in the API response itself: take them from the signed QR code / invoice.
  if (!rec.docNo || !rec.docDate) {
    for (const tokKey of ['signedqrcode', 'signedinvoice']) {
      const tok = cellText(flat.get(tokKey));
      const data = tok ? jwtData(tok) : null;
      if (!data) continue;
      const inner = recordFrom(data);
      rec.docNo = rec.docNo ?? inner.docNo;
      rec.docDate = rec.docDate ?? inner.docDate;
      rec.docType = rec.docType ?? inner.docType;
      rec.irn = rec.irn ?? inner.irn;
      if (rec.docNo && rec.docDate) break;
    }
  }
  return rec;
}

/** dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd (optionally with a time) → ISO date, else null. */
export function parseIrpDate(s: string | null): string | null {
  if (!s) return null;
  const t = s.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return isValidDate(`${m[1]}-${m[2]}-${m[3]}`) ? `${m[1]}-${m[2]}-${m[3]}` : null;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(t);
  if (m) {
    const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return isValidDate(iso) ? iso : null;
  }
  return null;
}

/** Date-time text from the IRP → 'YYYY-MM-DD HH:mm:ss' when recognisable, else as given. */
export function normaliseIrpDateTime(s: string | null): string | null {
  if (!s) return null;
  const d = parseIrpDate(s);
  if (!d) return s.trim();
  const tm = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?\s*$/.exec(s.trim());
  if (!tm) return d;
  let h = Number(tm[1]);
  const ap = tm[4]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return `${d} ${String(h).padStart(2, '0')}:${tm[2]}:${tm[3] ?? '00'}`;
}

function parseResponseFile(fileName: string, bytes: Uint8Array): IrpRecord[] {
  const isZip = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip || /\.xlsx$/i.test(fileName)) {
    const book = readXlsx(bytes, { maxRows: 100_000 });
    for (const sheet of book.sheets) {
      const headerIdx = sheet.rows.findIndex((r) => r.some((c) => typeof c === 'string' && KEY(c) === 'irn'));
      if (headerIdx < 0) continue;
      const header = sheet.rows[headerIdx].map((h) => KEY(normaliseHeader(h)));
      const out: IrpRecord[] = [];
      for (const row of sheet.rows.slice(headerIdx + 1)) {
        if (!row.some((c) => c !== null && c !== '')) continue;
        const obj: Record<string, unknown> = {};
        header.forEach((h, i) => {
          if (h) obj[h] = row[i];
        });
        out.push(recordFrom(obj));
      }
      return out;
    }
    throw new FileFormatError('xlsx', 'This Excel file has no column named "IRN". Choose the response file downloaded from the IRP.');
  }
  const { text } = decodeText(bytes);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new FileFormatError('json', 'The file is neither an Excel (.xlsx) nor a JSON response from the IRP.');
  }
  const list = (v: unknown): unknown[] => {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      for (const k of ['data', 'Data', 'results', 'Results', 'response', 'Response', 'irnList', 'IrnList']) {
        const inner = (v as Record<string, unknown>)[k];
        if (Array.isArray(inner)) return inner;
        if (inner && typeof inner === 'object') return [inner];
      }
      return [v];
    }
    return [];
  };
  return list(data)
    .filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x))
    .map(recordFrom);
}

interface MatchRow {
  id: number;
  number: string | null;
  date: string;
  base_type: string;
  vt_name: string;
  is_cancelled: number;
  irn: string | null;
  irn_ack_no: string | null;
  irn_ack_date: string | null;
  irn_status: string | null;
  eway_bill_no: string | null;
  eway_bill_date: string | null;
  eway_valid_upto: string | null;
}

/** Apply an IRP bulk response (JSON or Excel) to the vouchers, matched by document number + date. */
export function importIrpResponse(ctx: CompanyCtx, fileName: string, bytes: Uint8Array): EinvoiceImportResult {
  const records = parseResponseFile(fileName, bytes);
  if (records.length === 0) throw rule('The file has no e-invoice records.');
  const result: EinvoiceImportResult = { records: records.length, updated: [], unchanged: [], skipped: [], failed: [], warnings: [] };
  const ts = ctx.clock.now().toISOString();

  for (const r of records) {
    const docDate = parseIrpDate(r.docDate);
    if (!r.irn) {
      result.failed.push({ docNo: r.docNo, docDate, message: r.error ?? 'No IRN in this record.' });
      continue;
    }
    if (!/^[0-9a-f]{64}$/i.test(r.irn)) {
      result.skipped.push({ docNo: r.docNo, docDate, voucherId: null, reason: `"${r.irn.slice(0, 20)}…" is not an IRN (64 hexadecimal characters).` });
      continue;
    }
    if (!r.docNo) {
      result.skipped.push({ docNo: null, docDate, voucherId: null, reason: `IRN ${r.irn.slice(0, 12)}…: the record has no document number to match.` });
      continue;
    }
    const baseTypes = r.docType?.toUpperCase() === 'CRN' ? ['credit_note'] : r.docType?.toUpperCase() === 'DBN' ? ['debit_note'] : r.docType ? ['sales'] : ['sales', 'credit_note', 'debit_note'];
    const candidates = ctx.db.all<MatchRow>(
      `SELECT v.id, v.number, v.date, v.base_type, vt.name AS vt_name, v.is_cancelled, v.irn, v.irn_ack_no, v.irn_ack_date, v.irn_status,
              v.eway_bill_no, v.eway_bill_date, v.eway_valid_upto
         FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
        WHERE v.base_type IN (SELECT value FROM json_each(:bt)) AND v.is_optional = 0
          AND TRIM(v.number) = :no COLLATE NOCASE ${docDate ? 'AND v.date = :date' : ''}`,
      docDate ? { bt: JSON.stringify(baseTypes), no: r.docNo.trim(), date: docDate } : { bt: JSON.stringify(baseTypes), no: r.docNo.trim() },
    );
    if (candidates.length === 0) {
      result.skipped.push({ docNo: r.docNo, docDate, voucherId: null, reason: `No sales voucher ${r.docNo}${docDate ? ` dated ${formatDate(docDate)}` : ''} in the books.` });
      continue;
    }
    if (candidates.length > 1) {
      result.skipped.push({ docNo: r.docNo, docDate, voucherId: null, reason: `${candidates.length} vouchers have number ${r.docNo}${docDate ? '' : ' (the record has no date to tell them apart)'}.` });
      continue;
    }
    const v = candidates[0];
    if (v.irn && v.irn.toLowerCase() === r.irn.toLowerCase()) {
      result.unchanged.push({ voucherId: v.id, number: v.number });
      continue;
    }
    if (v.irn && v.irn_status === 'generated') {
      result.skipped.push({ docNo: r.docNo, docDate, voucherId: v.id, reason: `${v.vt_name} ${v.number} already has a different IRN (${v.irn.slice(0, 12)}…). Cancel it first.` });
      continue;
    }
    const after = {
      irn: r.irn.toLowerCase(),
      irnAckNo: r.ackNo,
      irnAckDate: normaliseIrpDateTime(r.ackDate),
      irnStatus: 'generated',
      ewayBillNo: r.ewbNo ?? v.eway_bill_no,
      ewayBillDate: r.ewbNo ? normaliseIrpDateTime(r.ewbDate) : v.eway_bill_date,
      ewayValidUpto: r.ewbNo ? normaliseIrpDateTime(r.ewbValidTill) : v.eway_valid_upto,
    };
    ctx.db.run(
      `UPDATE vouchers SET irn = :irn, irn_ack_no = :ack, irn_ack_date = :ackDt, irn_signed_qr = :qr, irn_status = 'generated',
              eway_bill_no = :ewb, eway_bill_date = :ewbDt, eway_valid_upto = :ewbTill, updated_at = :ts, updated_by = :uid
        WHERE id = :id`,
      {
        id: v.id,
        irn: after.irn,
        ack: after.irnAckNo,
        ackDt: after.irnAckDate,
        qr: r.signedQr,
        ewb: after.ewayBillNo,
        ewbDt: after.ewayBillDate,
        ewbTill: after.ewayValidUpto,
        ts,
        uid: ctx.session.userId,
      },
    );
    ctx.audit({
      action: 'alter',
      entityType: 'voucher',
      entityId: v.id,
      entityLabel: `${v.vt_name} ${v.number ?? ''}: IRN recorded`,
      before: { irn: v.irn, irnAckNo: v.irn_ack_no, irnAckDate: v.irn_ack_date, irnStatus: v.irn_status, ewayBillNo: v.eway_bill_no },
      after: { irn: after.irn, irnAckNo: after.irnAckNo, irnAckDate: after.irnAckDate, irnStatus: after.irnStatus, ewayBillNo: after.ewayBillNo },
    });
    logDocEvent(ctx, v.id, 'einvoice', 'generated', after.irn, { ackNo: after.irnAckNo, ackDate: after.irnAckDate, fileName });
    if (r.ewbNo) logDocEvent(ctx, v.id, 'ewaybill', 'generated', r.ewbNo, { date: after.ewayBillDate, validUpto: after.ewayValidUpto, via: 'irp', fileName });
    if (v.is_cancelled === 1) {
      result.warnings.push(`${v.vt_name} ${v.number} is cancelled in the books but now has an IRN — cancel the IRN on the IRP (within 24 hours of generation).`);
    }
    result.updated.push({ voucherId: v.id, number: v.number, irn: after.irn, ackNo: after.irnAckNo, ewayBillNo: r.ewbNo });
  }
  ctx.audit({
    action: 'import',
    entityType: 'einvoice',
    entityLabel: `${fileName}: ${result.updated.length} updated, ${result.unchanged.length} unchanged, ${result.skipped.length + result.failed.length} not applied`,
  });
  return result;
}

/** Record that the IRN of a voucher was cancelled on the IRP. */
export function markIrnCancelled(ctx: CompanyCtx, voucherId: number, reason: string): GstDocStatusResult {
  const v = ctx.db.get<MatchRow>(
    `SELECT v.id, v.number, v.date, v.base_type, vt.name AS vt_name, v.is_cancelled, v.irn, v.irn_ack_no, v.irn_ack_date, v.irn_status,
            v.eway_bill_no, v.eway_bill_date, v.eway_valid_upto
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id WHERE v.id = :id`,
    { id: voucherId },
  );
  if (!v) throw notFound('Voucher', voucherId);
  if (!v.irn) throw rule(`${v.vt_name} ${v.number ?? ''} has no IRN to cancel.`);
  if (v.irn_status === 'cancelled') throw rule(`The IRN of ${v.vt_name} ${v.number ?? ''} is already marked cancelled.`);
  const text = reason.trim();
  if (text.length < 3) throw rule('Give the reason for cancelling the IRN (e.g. "Data entry mistake").');
  ctx.db.run(`UPDATE vouchers SET irn_status = 'cancelled', updated_at = :ts, updated_by = :uid WHERE id = :id`, {
    id: v.id,
    ts: ctx.clock.now().toISOString(),
    uid: ctx.session.userId,
  });
  ctx.audit({
    action: 'cancel',
    entityType: 'einvoice',
    entityId: v.id,
    entityLabel: `IRN of ${v.vt_name} ${v.number ?? ''}`,
    before: { irn: v.irn, irnStatus: v.irn_status },
    after: { irn: v.irn, irnStatus: 'cancelled', reason: text },
  });
  logDocEvent(ctx, v.id, 'einvoice', 'cancelled', v.irn, { reason: text });
  return {
    voucherId: v.id,
    number: v.number,
    irnStatus: 'cancelled',
    irn: v.irn,
    ewayBillNo: v.eway_bill_no,
    ewayBillDate: v.eway_bill_date,
    ewayValidUpto: v.eway_valid_upto,
  };
}
