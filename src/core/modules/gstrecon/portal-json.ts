/**
 * GST portal JSON parsers: GSTR-2B (docdata), GSTR-2A and GSTR-1 (portal download or our own export).
 * Pure functions: JSON value in → ParsedPortalFile out. Amounts arrive in rupees and leave as paise.
 *
 * GSTR-2B  { data: { gstin, rtnprd, gendt, docdata: { b2b: [{ ctin, trdnm, supfildt, supprd, inv: [{ inum, typ, dt,
 *            val, pos, rev, itcavl, rsn, diffprcnt, srctyp, irn, irngendate, items: [{ num, rt, txval, igst, cgst,
 *            sgst, cess }] }] }], b2ba (oinum/oidt), cdnr: [{ …, nt: [{ ntnum, typ: C|D, suptyp, dt, … }] }],
 *            cdnra (ontnum/ontdt), isd, impg, impgsez … } } }  — `data` may be omitted (root holds docdata).
 * GSTR-2A  { gstin, fp, b2b: [{ ctin, cfs, cfs3b, fldtr1, flprdr1, inv: [{ inum, idt, val, pos, rchrg, inv_typ,
 *            itms: [{ num, itm_det: { rt, txval, iamt, camt, samt, csamt } }] }] }], b2ba, cdn|cdnr: [{ ctin, cfs,
 *            nt: [{ ntty, nt_num, nt_dt, val, … }] }], cdna|cdnra, isd, tds, tcs, impg … }
 * GSTR-1   { gstin, fp, b2b, b2ba, b2cl: [{ pos, inv }], cdnr, cdnra, cdnur, exp: [{ exp_typ, inv }], b2cs, hsn … }
 */
import { normalizeGstin } from '../../../shared/gst/index.ts';
import type { PortalDocType, PortalSection, ReconSource } from '../../../shared/types/gstrecon.ts';
import { FileFormatError } from '../../lib/text.ts';
import { bump, type ParsedPortalDoc, type ParsedPortalFile, uniqueRates, Warnings } from './portal-common.ts';
import {
  ITC_REASONS,
  isMonthPeriod,
  parseItcAvailability,
  parsePortalAmount,
  parsePortalDate,
  parseRate,
  parseStateCode,
  parseSupplierPeriod,
  parseYes,
} from './values.ts';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? '' : String(v).trim());

/** First present (non-null, non-empty) value among keys. */
function pick(o: Obj, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** Supplier-level fields without the nested document list (kept in raw). */
function supplierHead(s: Obj): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(s)) if (!Array.isArray(v)) out[k] = v;
  return out;
}

/** Number of documents in an arbitrary section (for "not reconciled" counts). */
function countDocs(section: unknown): number {
  if (Array.isArray(section)) {
    let n = 0;
    for (const e of section) {
      if (isObj(e)) {
        const nested = ['inv', 'nt', 'doclist', 'docs', 'itms'].find((k) => Array.isArray(e[k]));
        n += nested && nested !== 'itms' ? (e[nested] as unknown[]).length : 1;
      } else n++;
    }
    return n;
  }
  if (isObj(section)) {
    const inner = Object.values(section).filter(Array.isArray);
    return inner.reduce((a, v) => a + countDocs(v), 0) || 1;
  }
  return 0;
}

interface SectionSpec {
  section: PortalSection;
  /** Document type: fixed, or read from a note-type field. */
  docType: PortalDocType | 'note';
  noteTypeKeys: string[];
  docNoKeys: string[];
  dateKeys: string[];
  origNoKeys: string[];
  origDateKeys: string[];
  invoiceTypeKeys: string[];
  /** Counterparty GSTIN is on the parent ('ctin') — false for B2CL / EXP / CDNUR. */
  withCtin: boolean;
}

interface ParseCtx {
  label: string;
  warn: Warnings;
  docs: ParsedPortalDoc[];
  sections: Record<string, number>;
}

function amount(ctx: ParseCtx, v: unknown, field: string, where: string): number {
  const p = parsePortalAmount(v);
  if (p === null) throw new FileFormatError(ctx.label, `${where}: ${field} "${String(v).slice(0, 40)}" is not an amount. The file may be damaged; download it again from the GST portal.`);
  return p;
}

function noteType(v: unknown): PortalDocType | null {
  const s = text(v).toUpperCase();
  if (s === 'C' || s.startsWith('CREDIT')) return 'credit_note';
  if (s === 'D' || s.startsWith('DEBIT')) return 'debit_note';
  return null;
}

/** Build one document. Returns null (with a warning) when it cannot be reconciled. */
function buildDoc(ctx: ParseCtx, spec: SectionSpec, parent: Obj, d: Obj, extra: { pos?: string | null } = {}): ParsedPortalDoc | null {
  const gstin = spec.withCtin ? normalizeGstin(text(parent.ctin)) : '';
  const docNo = text(pick(d, ...spec.docNoKeys));
  const sec = spec.section.toUpperCase();
  const supplierLabel = gstin ? ` of ${gstin}` : '';
  if (spec.withCtin && gstin.length !== 15) {
    ctx.warn.add(`${sec}:ctin`, `${sec}: a document${docNo ? ` (${docNo})` : ''} has no valid counterparty GSTIN; it was skipped`);
    return null;
  }
  if (!docNo) {
    ctx.warn.add(`${sec}:docno`, `${sec}: a document${supplierLabel} has no document number; it was skipped`);
    return null;
  }
  const where = `${sec} ${docNo}${supplierLabel}`;
  const rawDate = pick(d, ...spec.dateKeys);
  const docDate = parsePortalDate(rawDate);
  if (!docDate) {
    ctx.warn.add(`${sec}:date`, `${where}: date "${text(rawDate)}" is not a valid date; the document was skipped`);
    return null;
  }
  let docType: PortalDocType;
  if (spec.docType === 'note') {
    const t = noteType(pick(d, ...spec.noteTypeKeys));
    if (!t) {
      ctx.warn.add(`${sec}:ntty`, `${where}: note type "${text(pick(d, ...spec.noteTypeKeys))}" is neither C (credit) nor D (debit); the note was skipped`);
      return null;
    }
    docType = t;
  } else docType = spec.docType;
  if (text(d.flag).toUpperCase() === 'D') {
    ctx.warn.add(`${sec}:deleted`, `${where} is marked as deleted in the file; it was skipped`);
    return null;
  }

  let taxable = 0;
  let igst = 0;
  let cgst = 0;
  let sgst = 0;
  let cess = 0;
  const rates: number[] = [];
  const items = arr(pick(d, 'items', 'itms'));
  for (const it of items) {
    if (!isObj(it)) continue;
    const det = isObj(it.itm_det) ? it.itm_det : it;
    const tx = amount(ctx, det.txval, 'taxable value', where);
    taxable += tx;
    igst += amount(ctx, pick(det, 'iamt', 'igst'), 'IGST', where);
    cgst += amount(ctx, pick(det, 'camt', 'cgst'), 'CGST', where);
    sgst += amount(ctx, pick(det, 'samt', 'sgst'), 'SGST', where);
    cess += amount(ctx, pick(det, 'csamt', 'cess'), 'cess', where);
    const rt = parseRate(pick(det, 'rt', 'rate'));
    if (rt !== null && tx !== 0) rates.push(rt);
  }
  if (items.length === 0) ctx.warn.add(`${sec}:noitems`, `${where} has no item details; its taxable value and tax are taken as 0`);

  const origNo = text(pick(d, ...spec.origNoKeys));
  const origDate = parsePortalDate(pick(d, ...spec.origDateKeys));
  const posRaw = pick(d, 'pos');
  const pos = posRaw !== undefined ? parseStateCode(posRaw) : (extra.pos ?? null);
  if (posRaw !== undefined && pos === null) ctx.warn.add(`${sec}:pos`, `${where}: place of supply "${text(posRaw)}" is not a known state code`);
  const rsn = text(pick(d, 'rsn'));
  const itcAvailable = parseItcAvailability(pick(d, 'itcavl', 'itc_avl'));
  const pct = pick(d, 'diffprcnt', 'diff_percent');
  const pctNum = pct === undefined ? null : Number(pct);
  const filingDate = parsePortalDate(pick(parent, 'supfildt', 'fldtr1') ?? pick(d, 'supfildt'));
  const supplierPeriod = parseSupplierPeriod(pick(parent, 'supprd', 'flprdr1') ?? pick(d, 'supprd'));

  const doc: ParsedPortalDoc = {
    section: spec.section,
    gstin,
    name: text(pick(parent, 'trdnm', 'trade_name', 'lgnm')) || null,
    docType,
    docNo,
    docDate,
    pos,
    reverseCharge: parseYes(pick(d, 'rev', 'rchrg')),
    taxable,
    igst,
    cgst,
    sgst,
    cess,
    invoiceValue: amount(ctx, d.val, 'value', where),
    rates: uniqueRates(rates),
    itcAvailable,
    itcReason: rsn ? (ITC_REASONS[rsn.toUpperCase()] ? `${rsn}: ${ITC_REASONS[rsn.toUpperCase()]}` : rsn) : null,
    filingStatus: text(pick(parent, 'cfs')) || null,
    supplierPeriod,
    filingDate,
    invoiceType: text(pick(d, ...spec.invoiceTypeKeys)) || null,
    original: origNo ? { docNo: origNo, docDate: origDate } : null,
    applicablePct: pctNum !== null && Number.isFinite(pctNum) ? (pctNum <= 1 ? Math.round(pctNum * 10000) / 100 : pctNum) : null,
    irn: text(pick(d, 'irn')) || null,
    irnDate: parsePortalDate(pick(d, 'irngendate', 'irndt')),
    sourceType: text(pick(d, 'srctyp')) || null,
    raw: { party: supplierHead(parent), doc: d },
  };
  bump(ctx.sections, spec.section);
  ctx.docs.push(doc);
  return doc;
}

/** Walk [{ ctin, <listKey>: [doc…] }] (or [{ pos, inv }] for B2CL). */
function walkParty(ctx: ParseCtx, spec: SectionSpec, section: unknown, listKey: string): void {
  for (const party of arr(section)) {
    if (!isObj(party)) continue;
    const pos = party.pos !== undefined ? parseStateCode(party.pos) : null;
    for (const d of arr(party[listKey])) if (isObj(d)) buildDoc(ctx, spec, party, d, { pos });
  }
}

const INV_2B: Omit<SectionSpec, 'section'> = {
  docType: 'invoice',
  noteTypeKeys: [],
  docNoKeys: ['inum'],
  dateKeys: ['dt', 'idt'],
  origNoKeys: ['oinum'],
  origDateKeys: ['oidt'],
  invoiceTypeKeys: ['typ', 'inv_typ'],
  withCtin: true,
};
const NOTE_2B: Omit<SectionSpec, 'section'> = {
  docType: 'note',
  noteTypeKeys: ['typ', 'ntty'],
  docNoKeys: ['ntnum', 'nt_num'],
  dateKeys: ['dt', 'nt_dt'],
  origNoKeys: ['ontnum', 'ont_num'],
  origDateKeys: ['ontdt', 'ont_dt'],
  invoiceTypeKeys: ['suptyp', 'inv_typ'],
  withCtin: true,
};
const INV_2A: Omit<SectionSpec, 'section'> = {
  docType: 'invoice',
  noteTypeKeys: [],
  docNoKeys: ['inum'],
  dateKeys: ['idt', 'dt'],
  origNoKeys: ['oinum'],
  origDateKeys: ['oidt'],
  invoiceTypeKeys: ['inv_typ', 'typ'],
  withCtin: true,
};
const NOTE_2A: Omit<SectionSpec, 'section'> = {
  docType: 'note',
  noteTypeKeys: ['ntty', 'typ'],
  docNoKeys: ['nt_num', 'ntnum'],
  dateKeys: ['nt_dt', 'dt'],
  origNoKeys: ['ont_num', 'ontnum'],
  origDateKeys: ['ont_dt', 'ontdt'],
  invoiceTypeKeys: ['inv_typ', 'suptyp'],
  withCtin: true,
};

function finish(ctx: ParseCtx, kind: ReconSource, gstin: string, period: string, generatedOn: string | null, skipped: Record<string, number>): ParsedPortalFile {
  const g = normalizeGstin(gstin);
  let p: string | null = period.trim() || null;
  if (p !== null && !isMonthPeriod(p)) {
    ctx.warn.add('period', `The return period in the file ("${p}") is not a month (MMYYYY); choose the period yourself`);
    p = null;
  }
  if (ctx.docs.length === 0) ctx.warn.add('empty', 'The file has no documents to reconcile');
  return {
    kind,
    format: 'json',
    gstin: g || null,
    period: p,
    generatedOn,
    docs: ctx.docs,
    sections: ctx.sections,
    skipped,
    warnings: ctx.warn.list(),
  };
}

function skippedSections(src: Obj, known: ReadonlySet<string>, ignore: ReadonlySet<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(src)) {
    if (known.has(k) || ignore.has(k)) continue;
    if (!Array.isArray(v) && !isObj(v)) continue;
    const n = countDocs(v);
    if (n > 0) out[k.toUpperCase()] = n;
  }
  return out;
}

// ───────────────────────────── GSTR-2B ─────────────────────────────

export function parseGstr2bJson(root: unknown): ParsedPortalFile {
  const label = 'GSTR-2B JSON';
  if (!isObj(root)) throw new FileFormatError(label, 'The file is not a GSTR-2B download: expected a JSON object');
  const data = isObj(root.data) ? root.data : root;
  const docdata = isObj(data.docdata) ? data.docdata : null;
  if (!docdata && !Array.isArray(data.b2b) && !Array.isArray(data.cdnr)) {
    if (isObj(root.error) || root.status_cd === '0' || root.status_cd === 0) {
      throw new FileFormatError(label, 'The file is an error response from the GST portal, not a GSTR-2B. Download GSTR-2B again.');
    }
  }
  const src: Obj = docdata ?? data;
  const ctx: ParseCtx = { label, warn: new Warnings(), docs: [], sections: {} };
  walkParty(ctx, { ...INV_2B, section: 'b2b' }, src.b2b, 'inv');
  walkParty(ctx, { ...INV_2B, section: 'b2ba' }, src.b2ba, 'inv');
  walkParty(ctx, { ...NOTE_2B, section: 'cdnr' }, src.cdnr, 'nt');
  walkParty(ctx, { ...NOTE_2B, section: 'cdnra' }, src.cdnra, 'nt');
  const skipped = docdata
    ? skippedSections(docdata, new Set(['b2b', 'b2ba', 'cdnr', 'cdnra']), new Set())
    : {};
  return finish(ctx, 'gstr2b', text(data.gstin), text(data.rtnprd ?? data.ret_period), parsePortalDate(data.gendt), skipped);
}

// ───────────────────────────── GSTR-2A ─────────────────────────────

export function parseGstr2aJson(root: unknown): ParsedPortalFile {
  const label = 'GSTR-2A JSON';
  if (!isObj(root)) throw new FileFormatError(label, 'The file is not a GSTR-2A download: expected a JSON object');
  const ctx: ParseCtx = { label, warn: new Warnings(), docs: [], sections: {} };
  walkParty(ctx, { ...INV_2A, section: 'b2b' }, root.b2b, 'inv');
  walkParty(ctx, { ...INV_2A, section: 'b2ba' }, root.b2ba, 'inv');
  walkParty(ctx, { ...NOTE_2A, section: 'cdnr' }, root.cdn ?? root.cdnr, 'nt');
  walkParty(ctx, { ...NOTE_2A, section: 'cdnra' }, root.cdna ?? root.cdnra, 'nt');
  const skipped = skippedSections(root, new Set(['b2b', 'b2ba', 'cdn', 'cdnr', 'cdna', 'cdnra']), new Set());
  return finish(ctx, 'gstr2a', text(root.gstin), text(root.fp ?? root.ret_period), null, skipped);
}

// ───────────────────────────── GSTR-1 ─────────────────────────────

export function parseGstr1Json(root: unknown): ParsedPortalFile {
  const label = 'GSTR-1 JSON';
  if (!isObj(root)) throw new FileFormatError(label, 'The file is not a GSTR-1 file: expected a JSON object');
  const ctx: ParseCtx = { label, warn: new Warnings(), docs: [], sections: {} };
  walkParty(ctx, { ...INV_2A, section: 'b2b' }, root.b2b, 'inv');
  walkParty(ctx, { ...INV_2A, section: 'b2ba' }, root.b2ba, 'inv');
  walkParty(ctx, { ...INV_2A, section: 'b2cl', withCtin: false }, root.b2cl, 'inv');
  walkParty(ctx, { ...INV_2A, section: 'b2cla', withCtin: false }, root.b2cla, 'inv');
  walkParty(ctx, { ...NOTE_2A, section: 'cdnr' }, root.cdnr, 'nt');
  walkParty(ctx, { ...NOTE_2A, section: 'cdnra' }, root.cdnra, 'nt');
  // CDNUR: flat list of notes; B2CL notes carry pos, export notes are POS 96.
  for (const [key, section] of [['cdnur', root.cdnur], ['cdnura', root.cdnura]] as const) {
    for (const n of arr(section)) {
      if (!isObj(n)) continue;
      const typ = text(n.typ).toUpperCase();
      buildDoc(ctx, { ...NOTE_2A, section: key, withCtin: false, invoiceTypeKeys: ['typ'] }, {}, n, { pos: typ.startsWith('EXP') ? '96' : null });
    }
  }
  // EXP: [{ exp_typ, inv: [...] }] — POS is always 96 (outside India).
  for (const [key, section] of [['exp', root.exp], ['expa', root.expa]] as const) {
    for (const grp of arr(section)) {
      if (!isObj(grp)) continue;
      for (const d of arr(grp.inv)) {
        if (!isObj(d)) continue;
        buildDoc(ctx, { ...INV_2A, section: key, withCtin: false }, { exp_typ: grp.exp_typ }, { ...d, inv_typ: d.inv_typ ?? grp.exp_typ }, { pos: '96' });
      }
    }
  }
  const skipped = skippedSections(
    root,
    new Set(['b2b', 'b2ba', 'b2cl', 'b2cla', 'cdnr', 'cdnra', 'cdnur', 'cdnura', 'exp', 'expa']),
    new Set(['gstin', 'fp', 'version', 'hash', 'gt', 'cur_gt']),
  );
  return finish(ctx, 'gstr1', text(root.gstin), text(root.fp ?? root.ret_period), null, skipped);
}

// ───────────────────────────── Detection ─────────────────────────────

export type DetectedKind = ReconSource | 'gstr2a_or_gstr1' | 'unknown';

const MARKERS_2A = ['cdn', 'cdna', 'tds', 'tdsa', 'tcs', 'tcsa', 'isd', 'isda', 'impg', 'impgsez', 'amdhist'];
const MARKERS_1 = ['b2cl', 'b2cla', 'b2cs', 'b2csa', 'exp', 'expa', 'hsn', 'nil', 'doc_issue', 'cdnur', 'cdnura', 'at', 'ata', 'txpd', 'txpda', 'supeco'];

function anyCfs(root: Obj): boolean {
  for (const k of ['b2b', 'cdn', 'cdnr', 'b2ba', 'cdna']) {
    for (const p of arr(root[k])) if (isObj(p) && ('cfs' in p || 'cfs3b' in p || 'fldtr1' in p)) return true;
  }
  return false;
}

/** Which return a parsed JSON value is. */
export function detectJsonKind(root: unknown): DetectedKind {
  if (!isObj(root)) return 'unknown';
  const data = isObj(root.data) ? root.data : root;
  if (isObj(data.docdata) || 'rtnprd' in data || 'itcsumm' in data) return 'gstr2b';
  const cfs = anyCfs(root);
  const has2a = cfs || MARKERS_2A.some((k) => k in root);
  const has1 = MARKERS_1.some((k) => k in root);
  if (has2a && !has1) return 'gstr2a';
  if (has1 && !has2a) return 'gstr1';
  if (has1 && has2a) return cfs ? 'gstr2a' : 'gstr1';
  if (['b2b', 'b2ba', 'cdnr', 'cdnra'].some((k) => k in root)) return 'gstr2a_or_gstr1';
  return 'unknown';
}
