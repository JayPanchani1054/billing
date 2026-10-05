/**
 * e-Way bill: pending list (goods supplies above the threshold without an e-way bill), bulk JSON for
 * the EWB portal's bulk generation, and recording the e-way bill number generated on the portal.
 *
 * Rule 138: an e-way bill is needed when goods of consignment value EXCEEDING the threshold
 * (config.gst.ewayThresholdPaise, default ₹50,000) move. Consignment value = taxable value + tax of the
 * taxable goods lines (exempt goods are left out).
 *
 * Mapping: sales → supplyType O / subSupplyType 1 Supply (3 Export for exports) / docType INV (BIL for a
 * bill of supply); credit note (sales return) → supplyType I / subSupplyType 7 Sales Return / docType
 * CNT. From = company, To = party (exports: toGstin URP, toStateCode 96, ship-to = port in the consignee).
 * transactionType 1 regular, 2 bill-to / ship-to (consignee differs from the buyer). Transport details
 * from the voucher's dispatch details. Only goods lines are items; services, round-off and charges
 * outside GST go to otherValue.
 */
import { formatDate, isValidDate } from '../../../shared/dates.ts';
import { isKnownStateCode, POS_OTHER_COUNTRIES, validateGstin } from '../../../shared/gst/index.ts';
import type { EwayPendingResult, EwayPendingRow, EwayUpdateInput, GstBulkJsonFile, GstDocStatusResult } from '../../../shared/types/gst-returns.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { notFound, rule, validation } from '../../lib/errors.ts';
import { pinNumber, splitAddress } from './address.ts';
import { DOC_NO_RE } from './checks.ts';
import type { GstCompany, GstDoc } from './docs.ts';
import { docLabel, loadDocs, round2, rupees } from './docs.ts';
import { logDocEvent, transModeCode } from './einvoice.ts';

/** Bulk-generation JSON version. Verify against the EWB portal's current bulk JSON schema. */
export const EWAY_JSON_VERSION = '1.0.0621';

/** Keys whose names differ between the EWB API and some bulk-tool versions — kept in one place. */
const KEYS = { actFrom: 'actFromStateCode', actTo: 'actToStateCode' } as const;

const VEHICLE_RE = /^([A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}|TR[A-Z0-9]{6,13}|[A-Z]{2}[0-9]{2}[A-Z]{1,2}[0-9]{4}[A-Z]?|DF[A-Z0-9]{5,13}|TM[A-Z0-9]{6,13}|BP[A-Z0-9]{6,13}|NP[A-Z0-9]{6,13})$/;

const ddmmyyyy = (iso: string | null): string => formatDate(iso, 'DD/MM/YYYY');

/** Taxable goods value + tax (Rule 138 consignment value). */
export function consignmentValue(d: GstDoc): number {
  return d.lines
    .filter((l) => l.supplyType === 'goods' && l.taxability === 'taxable')
    .reduce((s, l) => s + l.taxable + l.igst + l.cgst + l.sgst + l.cess, 0);
}

export interface EwayBuild {
  bill: Record<string, unknown>;
  errors: string[];
  warnings: string[];
}

type Json = Record<string, unknown>;

export function buildEwayBill(d: GstDoc, company: GstCompany, today: string): EwayBuild {
  const errors: string[] = [];
  const warnings: string[] = [];
  const inwardReturn = d.baseType === 'credit_note';
  const exportDoc = d.nature === 'export_wpay' || d.nature === 'export_lut';
  const goods = d.lines.filter((l) => l.supplyType === 'goods' && (l.taxable !== 0 || l.igst + l.cgst + l.sgst + l.cess !== 0));
  if (goods.length === 0) errors.push('The voucher has no goods lines: an e-way bill is only for the movement of goods.');

  const no = (d.number ?? '').trim();
  if (!no) errors.push('The voucher has no number.');
  else if (!DOC_NO_RE.test(no)) errors.push(`Document number "${no}" is not accepted: up to 16 letters, digits, '/' or '-'.`);
  if (d.date > today) errors.push(`The document date ${formatDate(d.date)} is in the future.`);

  // Company side.
  const cAddr = splitAddress(company.address, company.stateCode);
  const cPin = pinNumber(company.pincode);
  if (!company.gstin || !validateGstin(company.gstin).valid) errors.push('The company GSTIN is missing or invalid (Company profile).');
  if (cPin === null) errors.push('The company PIN code is missing or not 6 digits (Company profile).');
  if (!cAddr.addr1) errors.push('The company address is empty (Company profile).');

  // Party side.
  const party = d.party;
  const partyGstin = party.gstin && validateGstin(party.gstin).valid ? party.gstin : null;
  if (party.gstin && !partyGstin) errors.push(`The party GSTIN ${party.gstin} is invalid.`);
  const consignee = d.consignee;
  const partyState = exportDoc ? POS_OTHER_COUNTRIES : party.stateCode || d.pos;
  const shipState = consignee?.stateCode || (exportDoc ? company.stateCode : partyState);
  const shipAddrText = consignee?.address ?? party.address;
  const shipPinText = consignee?.pincode ?? (exportDoc ? null : party.pincode);
  const shipAddr = splitAddress(shipAddrText, shipState);
  const shipPin = pinNumber(shipPinText);
  if (!(party.name ?? '').trim()) errors.push('The party name is empty.');
  if (!shipAddr.addr1) errors.push(exportDoc ? 'Enter the port / ICD of export as the consignee (address, PIN, state).' : `The address of "${party.name ?? ''}" is empty.`);
  if (shipPin === null) {
    errors.push(exportDoc ? 'Enter the PIN code of the port / ICD of export as the consignee PIN.' : `The PIN code of "${party.name ?? ''}" (or of the consignee) is missing or not 6 digits.`);
  }
  if (!exportDoc && !isKnownStateCode(partyState)) errors.push(`The state of "${party.name ?? ''}" is not set.`);
  const billToShipTo =
    !!consignee &&
    !exportDoc &&
    ((consignee.address ?? '') !== (party.address ?? '') || (consignee.pincode ?? '') !== (party.pincode ?? '') || (consignee.stateCode || partyState) !== partyState);

  const companySide: Json = {
    gstin: company.gstin ?? '',
    trdName: company.tradeName.slice(0, 100),
    addr1: cAddr.addr1,
    addr2: cAddr.addr2,
    place: cAddr.loc,
    pincode: cPin ?? 0,
    stateCode: Number(company.stateCode) || 0,
    actState: Number(company.stateCode) || 0,
  };
  const partySide: Json = {
    gstin: partyGstin ?? 'URP',
    trdName: (party.name ?? '').slice(0, 100),
    addr1: shipAddr.addr1,
    addr2: shipAddr.addr2,
    place: shipAddr.loc,
    pincode: shipPin ?? 0,
    stateCode: Number(partyState) || 0,
    actState: Number(shipState) || 0,
  };
  const from = inwardReturn ? partySide : companySide;
  const to = inwardReturn ? companySide : partySide;

  // Values.
  let totalValue = 0;
  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  let cess = 0;
  for (const l of goods) {
    totalValue += l.taxable;
    cgst += l.cgst;
    sgst += l.sgst;
    igst += l.igst;
    cess += l.cess;
  }
  const totInv = d.totalAmount + (d.reverseCharge ? cgst + sgst + igst + cess : 0);
  const other = totInv - (totalValue + cgst + sgst + igst + cess);

  // Transport.
  const disp = d.dispatch;
  const vehicleNo = disp?.vehicleNo ? disp.vehicleNo.replace(/[\s-]/g, '').toUpperCase() : '';
  const transporterId = disp?.transporterId ? disp.transporterId.replace(/\s+/g, '').toUpperCase() : '';
  const distance = disp?.distanceKm ?? null;
  if (distance === null) errors.push('Enter the approximate distance (km) in the dispatch details (0 lets the portal calculate it from the PIN codes).');
  else if (distance < 0 || distance > 4000) errors.push('The distance must be between 0 and 4,000 km.');
  else if (distance === 0) warnings.push('Distance 0: the portal will calculate it from the PIN codes.');
  if (vehicleNo && !VEHICLE_RE.test(vehicleNo)) warnings.push(`Vehicle number "${vehicleNo}" does not look like a registration number (e.g. MH12AB1234); the portal may reject it.`);
  if (transporterId && !/^[0-9A-Z]{15}$/.test(transporterId)) errors.push(`Transporter ID "${transporterId}" must be the transporter's 15-character GSTIN / TRANSIN.`);
  if (!vehicleNo && !transporterId) warnings.push('No vehicle number or transporter ID: only Part-A will be generated; update Part-B before the goods move.');
  const mode = transModeCode(disp?.mode ?? null) ?? (vehicleNo ? '1' : '');
  if (disp?.lrDate && !isValidDate(disp.lrDate)) errors.push('The transport document (LR) date is not a valid date.');

  const allNonTaxable = d.lines.every((l) => l.taxability !== 'taxable');
  const bill: Json = {
    userGstin: company.gstin ?? '',
    supplyType: inwardReturn ? 'I' : 'O',
    subSupplyType: inwardReturn ? 7 : exportDoc ? 3 : 1,
    subSupplyDesc: '',
    docType: inwardReturn ? 'CNT' : allNonTaxable ? 'BIL' : 'INV',
    docNo: no,
    docDate: ddmmyyyy(d.date),
    fromGstin: from.gstin,
    fromTrdName: from.trdName,
    fromAddr1: from.addr1,
    fromAddr2: from.addr2,
    fromPlace: from.place,
    fromPincode: from.pincode,
    fromStateCode: from.stateCode,
    [KEYS.actFrom]: from.actState,
    toGstin: to.gstin,
    toTrdName: to.trdName,
    toAddr1: to.addr1,
    toAddr2: to.addr2,
    toPlace: to.place,
    toPincode: to.pincode,
    toStateCode: to.stateCode,
    [KEYS.actTo]: to.actState,
    transactionType: billToShipTo ? 2 : 1,
    totalValue: rupees(totalValue),
    cgstValue: rupees(cgst),
    sgstValue: rupees(sgst),
    igstValue: rupees(igst),
    cessValue: rupees(cess),
    cessNonAdvolValue: 0,
    otherValue: rupees(other),
    totInvValue: rupees(totInv),
    transporterId,
    transporterName: (disp?.transporterName ?? '').slice(0, 100),
    transDocNo: (disp?.lrNo ?? disp?.docNo ?? '').slice(0, 15),
    transMode: mode,
    transDistance: distance === null ? '' : String(Math.round(distance)),
    transDocDate: disp?.lrDate && isValidDate(disp.lrDate) ? ddmmyyyy(disp.lrDate) : '',
    vehicleNo,
    vehicleType: vehicleNo ? 'R' : '',
    itemList: goods.map((l, i) => {
      const hsn = l.hsn.replace(/\D/g, '');
      if (!hsn) errors.push(`Line ${l.lineNo} has no HSN code.`);
      else if (hsn.startsWith('99')) errors.push(`Line ${l.lineNo}: HSN ${hsn} is a service code; e-way bill items must be goods.`);
      const inter = l.igst !== 0 || (l.cgst === 0 && l.sgst === 0 && (d.interState || exportDoc));
      const taxed = l.igst !== 0 || l.cgst !== 0 || l.sgst !== 0;
      return {
        itemNo: i + 1,
        productName: (l.description || hsn).slice(0, 100),
        productDesc: (l.description || hsn).slice(0, 100),
        hsnCode: Number(hsn) || 0,
        quantity: round2(Math.abs(l.qty)),
        qtyUnit: l.uqc && l.uqc !== 'NA' ? l.uqc : 'OTH',
        taxableAmount: rupees(l.taxable),
        sgstRate: taxed && !inter ? l.rate / 2 : 0,
        cgstRate: taxed && !inter ? l.rate / 2 : 0,
        igstRate: taxed && inter ? l.rate : 0,
        cessRate: l.cessRate,
        cessNonAdvol: 0,
      };
    }),
  };
  if (company.gstin && partyGstin === company.gstin) warnings.push('From and To GSTIN are the same (movement within your own business) — check the supply type.');
  return { bill, errors: [...new Set(errors)], warnings };
}

function needsEway(d: GstDoc, threshold: number): boolean {
  return (
    d.inBooks &&
    d.direction === 'outward' &&
    (d.baseType === 'sales' || d.baseType === 'credit_note') &&
    !d.ewayBillNo &&
    consignmentValue(d) > threshold
  );
}

export function pendingEwayBills(db: Db, company: GstCompany, from: string, to: string, today: string): EwayPendingResult {
  const threshold = company.config.gst.ewayThresholdPaise;
  const rows: EwayPendingRow[] = loadDocs(db, company, { from, to, today, baseTypes: ['sales', 'credit_note'] })
    .filter((d) => needsEway(d, threshold))
    .map((d) => {
      const b = buildEwayBill(d, company, today);
      return {
        voucherId: d.id,
        number: d.number,
        date: d.date,
        voucherTypeName: d.voucherTypeName,
        partyName: d.party.name,
        toGstin: (b.bill.toGstin as string) || 'URP',
        consignmentValue: consignmentValue(d),
        invoiceValue: d.totalAmount,
        distanceKm: d.dispatch?.distanceKm ?? null,
        vehicleNo: d.dispatch?.vehicleNo ?? null,
        transporterId: d.dispatch?.transporterId ?? null,
        ready: b.errors.length === 0,
        errors: b.errors,
        warnings: b.warnings,
      };
    });
  return { enabled: company.features.ewayBill, thresholdPaise: threshold, rows };
}

export function ewayJson(ctx: CompanyCtx, company: GstCompany, voucherIds: readonly number[]): GstBulkJsonFile {
  const today = ctx.clock.today();
  const docs = loadDocs(ctx.db, company, { from: '', to: '', today, ids: voucherIds, anyDate: true, baseTypes: ['sales', 'credit_note'] });
  const found = new Set(docs.map((d) => d.id));
  const rejected: GstBulkJsonFile['rejected'] = [];
  for (const id of voucherIds) if (!found.has(id)) rejected.push({ voucherId: id, number: null, errors: ['Voucher not found, or it is not a sale / sales return that counts in the books.'] });
  const bills: Array<Record<string, unknown>> = [];
  const accepted: GstDoc[] = [];
  const warnings: string[] = [];
  for (const d of docs) {
    if (d.direction !== 'outward') {
      rejected.push({ voucherId: d.id, number: d.number, errors: [`${docLabel(d)} is not an outward supply / sales return.`] });
      continue;
    }
    if (d.ewayBillNo) {
      rejected.push({ voucherId: d.id, number: d.number, errors: [`${docLabel(d)} already has e-way bill ${d.ewayBillNo}.`] });
      continue;
    }
    const b = buildEwayBill(d, company, today);
    if (b.errors.length > 0) {
      rejected.push({ voucherId: d.id, number: d.number, errors: b.errors });
      continue;
    }
    for (const w of b.warnings) warnings.push(`${docLabel(d)}: ${w}`);
    bills.push(b.bill);
    accepted.push(d);
  }
  if (bills.length === 0) throw rule('None of the selected vouchers can be exported for e-way bills. Fix the errors listed and try again.', { rejected });
  const fileName = `EWB_${company.gstin ?? 'GSTIN'}_${today.replace(/-/g, '')}_${bills.length}.json`;
  ctx.db.transaction(() => {
    for (const d of accepted) logDocEvent(ctx, d.id, 'ewaybill', 'exported', null, { fileName });
    ctx.audit({ action: 'export', entityType: 'ewaybill', entityLabel: `${fileName} (${bills.length} bill${bills.length === 1 ? '' : 's'})` });
  });
  return { fileName, json: JSON.stringify({ version: EWAY_JSON_VERSION, billLists: bills }), warnings, documents: bills.length, rejected };
}

/** Record the e-way bill generated on the portal for a voucher. Audited. */
export function updateEwayBill(ctx: CompanyCtx, input: EwayUpdateInput): GstDocStatusResult {
  const no = input.ewayBillNo.replace(/\s+/g, '');
  if (!/^\d{12}$/.test(no)) throw validation([{ path: 'ewayBillNo', message: 'An e-way bill number has 12 digits' }]);
  if (input.validUpto && input.validUpto < input.date) throw validation([{ path: 'validUpto', message: 'Valid-up-to date is before the e-way bill date' }]);
  const v = ctx.db.get<{
    id: number;
    number: string | null;
    vt_name: string;
    base_type: string;
    date: string;
    irn: string | null;
    irn_status: string | null;
    eway_bill_no: string | null;
    eway_bill_date: string | null;
    eway_valid_upto: string | null;
  }>(
    `SELECT v.id, v.number, vt.name AS vt_name, v.base_type, v.date, v.irn, v.irn_status, v.eway_bill_no, v.eway_bill_date, v.eway_valid_upto
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id WHERE v.id = :id`,
    { id: input.voucherId },
  );
  if (!v) throw notFound('Voucher', input.voucherId);
  if (!['sales', 'purchase', 'credit_note', 'debit_note', 'delivery_note', 'receipt_note', 'rejection_in', 'rejection_out'].includes(v.base_type)) {
    throw rule(`${v.vt_name} vouchers do not carry e-way bills.`);
  }
  if (input.date < v.date) throw validation([{ path: 'date', message: `The e-way bill date cannot be before the voucher date (${formatDate(v.date)})` }]);
  const other = ctx.db.get<{ id: number; number: string | null; vt_name: string }>(
    `SELECT v.id, v.number, vt.name AS vt_name FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id
      WHERE v.eway_bill_no = :no AND v.id <> :id LIMIT 1`,
    { no, id: v.id },
  );
  if (other) throw rule(`E-way bill ${no} is already recorded on ${other.vt_name} ${other.number ?? ''}.`);
  ctx.db.run(`UPDATE vouchers SET eway_bill_no = :no, eway_bill_date = :d, eway_valid_upto = :u, updated_at = :ts, updated_by = :uid WHERE id = :id`, {
    id: v.id,
    no,
    d: input.date,
    u: input.validUpto ?? null,
    ts: ctx.clock.now().toISOString(),
    uid: ctx.session.userId,
  });
  ctx.audit({
    action: 'alter',
    entityType: 'voucher',
    entityId: v.id,
    entityLabel: `${v.vt_name} ${v.number ?? ''}: e-way bill recorded`,
    before: { ewayBillNo: v.eway_bill_no, ewayBillDate: v.eway_bill_date, ewayValidUpto: v.eway_valid_upto },
    after: { ewayBillNo: no, ewayBillDate: input.date, ewayValidUpto: input.validUpto ?? null },
  });
  logDocEvent(ctx, v.id, 'ewaybill', 'updated', no, { date: input.date, validUpto: input.validUpto ?? null });
  return {
    voucherId: v.id,
    number: v.number,
    irnStatus: v.irn_status,
    irn: v.irn,
    ewayBillNo: no,
    ewayBillDate: input.date,
    ewayValidUpto: input.validUpto ?? null,
  };
}
