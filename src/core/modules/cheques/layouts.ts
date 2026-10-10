/**
 * Cheque layouts (positions in millimetres on the leaf) with presets, and per-bank print settings.
 *
 * CTS-2010 (RBI's Cheque Truncation System standard) fixes the leaf at 202 mm × 92 mm with the date as
 * eight boxes (DD MM YYYY) at the top right and a clear MICR band at the bottom. The exact positions
 * of the payee line, the amount boxes and the date boxes still differ a little between banks and
 * cheque printers, so the presets are STARTING POINTS: print the calibration sheet on plain paper,
 * hold it against a leaf, and correct the positions / the offsets (README › Cheques).
 */
import { randomUUID } from 'node:crypto';
import { CHEQUE_PT_MM, CHEQUE_SIGN_LINE_GAP_MM, type ChequeBankSettings, type ChequeBankSettingsInput, type ChequeLayout, type ChequeLayoutSaveInput, type ChequeLayoutSpec, type ChequePreset } from '../../../shared/types/cheques.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { notFound, rule, validation } from '../../lib/errors.ts';
import { requireBankLedger } from '../banking/common.ts';
import { requirePermission } from './common.ts';

/** Height of the MICR clear band at the bottom of a CTS-2010 leaf (5/8 inch): nothing may be printed there. */
export const MICR_BAND_MM = 16;

const CTS_STANDARD: ChequeLayoutSpec = {
  widthMm: 202,
  heightMm: 92,
  fontPt: 11,
  date: { x: 158, y: 9, pitch: 4.9 },
  payee: { x: 22, y: 21, w: 150 },
  words: { x: 33, y: 30, w: 122 },
  words2: { x: 10, y: 38, w: 140 },
  figures: { x: 160, y: 35, w: 36 },
  acPayee: { x: 8, y: 4, w: 30 },
  signatory: { x: 140, y: 60, w: 58 },
  offsetX: 0,
  offsetY: 0,
  placement: 'leaf',
  figuresPaise: true,
};

export const CHEQUE_PRESETS: readonly ChequePreset[] = [
  {
    code: 'cts2010',
    name: 'CTS-2010 standard leaf',
    description: '202 × 92 mm leaf fed on its own (cheque printer or a printer that takes custom paper). Date boxes 4.9 mm apart at the top right.',
    spec: CTS_STANDARD,
  },
  {
    code: 'cts2010_wide_date',
    name: 'CTS-2010, wider date boxes',
    description: 'As the standard leaf, with 5.3 mm date boxes starting further left — used on several banks’ personalised leaves.',
    spec: { ...CTS_STANDARD, date: { x: 154, y: 9, pitch: 5.3 } },
  },
  {
    code: 'cts2010_a4',
    name: 'CTS-2010 on an A4 sheet (centred)',
    description: 'For an ordinary A4 printer: the leaf is held at the top centre of the sheet (feed it centred, face up as your printer needs).',
    spec: { ...CTS_STANDARD, placement: 'a4_center' },
  },
];

export const DEFAULT_PRESET = CHEQUE_PRESETS[0];

// ───────────────────────────── validation ─────────────────────────────

const POINTS = ['date', 'payee', 'words', 'words2', 'figures', 'acPayee', 'signatory'] as const;

const LABEL: Record<(typeof POINTS)[number], string> = {
  date: 'Date boxes',
  payee: 'Payee line',
  words: 'Amount in words (line 1)',
  words2: 'Amount in words (line 2)',
  figures: 'Amount in figures',
  acPayee: "'A/c Payee' crossing",
  signatory: 'Signatory',
};

/**
 * Lowest point (mm from the top) of what prints at a field whose top edge is at `y` — the same boxes the
 * renderer draws (lib/cheque.ts › chequeMarks): one line of text one font size tall; the crossing has
 * its rules and padding; the signatory has the "Authorised Signatory" line below "For <company>".
 */
export function fieldBottomMm(key: (typeof POINTS)[number], y: number, fontPt: number): number {
  const line = (pt: number): number => pt * CHEQUE_PT_MM;
  switch (key) {
    case 'figures':
      return y + line(fontPt + 1);
    case 'acPayee':
      return y + line(Math.max(7, fontPt - 2)) + 2.3;
    case 'signatory':
      return y + CHEQUE_SIGN_LINE_GAP_MM + line(Math.max(7, fontPt - 3));
    default:
      return y + line(fontPt);
  }
}

/** Problems with a layout (empty when fine), as field issues. */
export function layoutIssues(spec: ChequeLayoutSpec): Array<{ path: string; message: string }> {
  const out: Array<{ path: string; message: string }> = [];
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!num(spec.widthMm) || spec.widthMm < 150 || spec.widthMm > 230) out.push({ path: 'spec.widthMm', message: 'Leaf width must be 150–230 mm (CTS-2010: 202 mm)' });
  if (!num(spec.heightMm) || spec.heightMm < 70 || spec.heightMm > 110) out.push({ path: 'spec.heightMm', message: 'Leaf height must be 70–110 mm (CTS-2010: 92 mm)' });
  if (!num(spec.fontPt) || spec.fontPt < 7 || spec.fontPt > 16) out.push({ path: 'spec.fontPt', message: 'Font size must be 7–16 pt' });
  if (!num(spec.offsetX) || Math.abs(spec.offsetX) > 30) out.push({ path: 'spec.offsetX', message: 'Shift right / left by at most 30 mm' });
  if (!num(spec.offsetY) || Math.abs(spec.offsetY) > 30) out.push({ path: 'spec.offsetY', message: 'Shift down / up by at most 30 mm' });
  if (out.length > 0) return out;
  const usable = spec.heightMm - MICR_BAND_MM;
  for (const k of POINTS) {
    const p = spec[k];
    if (!p || !num(p.x) || !num(p.y) || p.x < 0 || p.y < 0) {
      out.push({ path: `spec.${k}`, message: `${LABEL[k]}: enter the position in millimetres from the top-left corner` });
      continue;
    }
    if (p.x >= spec.widthMm) out.push({ path: `spec.${k}.x`, message: `${LABEL[k]} starts beyond the leaf's width (${spec.widthMm} mm)` });
    const bottom = fieldBottomMm(k, p.y, spec.fontPt);
    if (bottom > usable + 0.01) {
      const what = k === 'signatory' ? `${LABEL[k]} (with the "Authorised Signatory" line ${CHEQUE_SIGN_LINE_GAP_MM} mm below it)` : LABEL[k];
      out.push({
        path: `spec.${k}.y`,
        message: `${what} would print down to ${Math.round(bottom * 10) / 10} mm, in the MICR band: move it up by ${Math.ceil((bottom - usable) * 10) / 10} mm (the bottom ${MICR_BAND_MM} mm must stay clear, i.e. nothing below ${usable} mm)`,
      });
    }
    if (p.w !== undefined && (!num(p.w) || p.w <= 0 || p.x + p.w > spec.widthMm + 0.01)) {
      out.push({ path: `spec.${k}.w`, message: `${LABEL[k]}: the width runs past the leaf's right edge` });
    }
  }
  const pitch = spec.date?.pitch;
  if (!num(pitch) || pitch < 3 || pitch > 8) out.push({ path: 'spec.date.pitch', message: 'Date boxes are 3–8 mm apart' });
  else if (num(spec.date.x) && spec.date.x + pitch * 8 > spec.widthMm + 0.01) out.push({ path: 'spec.date.x', message: 'The eight date boxes run past the right edge of the leaf' });
  if (!['leaf', 'a4_left', 'a4_center'].includes(spec.placement)) out.push({ path: 'spec.placement', message: 'Choose how the leaf is fed' });
  return out;
}

/** Normalise a stored / sent spec (round to 0.1 mm, keep only known keys). */
export function cleanSpec(spec: ChequeLayoutSpec): ChequeLayoutSpec {
  const r = (n: number): number => Math.round(n * 10) / 10;
  const pt = (p: { x: number; y: number; w?: number }): { x: number; y: number; w?: number } => ({ x: r(p.x), y: r(p.y), ...(p.w !== undefined ? { w: r(p.w) } : {}) });
  return {
    widthMm: r(spec.widthMm),
    heightMm: r(spec.heightMm),
    fontPt: r(spec.fontPt),
    date: { ...pt(spec.date), pitch: r(spec.date.pitch) },
    payee: pt(spec.payee),
    words: pt(spec.words),
    words2: pt(spec.words2),
    figures: pt(spec.figures),
    acPayee: pt(spec.acPayee),
    signatory: pt(spec.signatory),
    offsetX: r(spec.offsetX),
    offsetY: r(spec.offsetY),
    placement: spec.placement,
    figuresPaise: spec.figuresPaise !== false,
  };
}

/** Every number of a spec is present (a stored layout is usable, though it may break a placement rule). */
function wellFormed(v: unknown): v is ChequeLayoutSpec {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const num = (x: unknown): boolean => typeof x === 'number' && Number.isFinite(x);
  const pt = (x: unknown): boolean => !!x && typeof x === 'object' && num((x as { x: unknown }).x) && num((x as { y: unknown }).y);
  return (
    ['widthMm', 'heightMm', 'fontPt', 'offsetX', 'offsetY'].every((k) => num(o[k])) &&
    POINTS.every((k) => pt(o[k])) &&
    num((o.date as { pitch?: unknown } | undefined)?.pitch) &&
    typeof o.placement === 'string' &&
    ['leaf', 'a4_left', 'a4_center'].includes(o.placement)
  );
}

/**
 * A stored layout as saved. Only a damaged one falls back to the standard preset: a layout saved under
 * an older, looser rule keeps its positions (the user calibrated them) and the cheque print data warns
 * about the rule it breaks (printData.ts) — silently printing at other positions would be worse.
 */
function parseSpec(json: string): ChequeLayoutSpec {
  try {
    const v: unknown = JSON.parse(json);
    return wellFormed(v) ? cleanSpec(v) : DEFAULT_PRESET.spec;
  } catch {
    return DEFAULT_PRESET.spec;
  }
}

// ───────────────────────────── layouts ─────────────────────────────

interface LayoutRow {
  id: number;
  guid: string;
  name: string;
  preset: string | null;
  layout: string;
}

function toLayout(db: Db, r: LayoutRow): ChequeLayout {
  const usedBy = db
    .all<{ name: string }>(
      'SELECT l.name FROM cheque_bank_settings s JOIN ledgers l ON l.id = s.bank_ledger_id WHERE s.layout_id = :id ORDER BY l.name COLLATE NOCASE',
      { id: r.id },
    )
    .map((x) => x.name);
  return { id: r.id, name: r.name, preset: r.preset, spec: parseSpec(r.layout), usedBy };
}

export function listLayouts(db: Db): ChequeLayout[] {
  return db.all<LayoutRow>('SELECT id, guid, name, preset, layout FROM cheque_layouts ORDER BY name COLLATE NOCASE').map((r) => toLayout(db, r));
}

export function getLayout(db: Db, id: number): ChequeLayout {
  const r = db.get<LayoutRow>('SELECT id, guid, name, preset, layout FROM cheque_layouts WHERE id = :id', { id });
  if (!r) throw notFound('Cheque layout', id);
  return toLayout(db, r);
}

export function saveLayout(ctx: CompanyCtx, input: ChequeLayoutSaveInput): ChequeLayout {
  const { db } = ctx;
  requirePermission(ctx, 'masters.alter', 'change cheque layouts');
  const existing = input.id !== undefined ? db.get<LayoutRow>('SELECT id, guid, name, preset, layout FROM cheque_layouts WHERE id = :id', { id: input.id }) : undefined;
  if (input.id !== undefined && !existing) throw notFound('Cheque layout', input.id);
  const name = input.name.trim().replace(/\s+/g, ' ');
  const issues = layoutIssues(input.spec);
  if (!name) issues.unshift({ path: 'name', message: 'Name the layout (e.g. HDFC current account leaves)' });
  else if (name.length > 80) issues.unshift({ path: 'name', message: 'Keep the name under 80 characters' });
  else if (db.value('SELECT 1 FROM cheque_layouts WHERE name = :n COLLATE NOCASE AND id <> :id', { n: name, id: existing?.id ?? -1 }) !== undefined) {
    issues.unshift({ path: 'name', message: `A layout named “${name}” already exists` });
  }
  if (input.preset && !CHEQUE_PRESETS.some((p) => p.code === input.preset)) issues.push({ path: 'preset', message: 'Unknown preset' });
  if (issues.length > 0) throw validation(issues);
  const spec = cleanSpec(input.spec);
  const now = ctx.clock.now().toISOString();
  let id: number;
  if (existing) {
    db.run('UPDATE cheque_layouts SET name = :name, preset = :preset, layout = :layout, updated_at = :now WHERE id = :id', {
      name,
      preset: input.preset ?? existing.preset,
      layout: JSON.stringify(spec),
      now,
      id: existing.id,
    });
    id = existing.id;
  } else {
    id = db.run(
      'INSERT INTO cheque_layouts (guid, name, preset, layout, created_at, updated_at) VALUES (:guid, :name, :preset, :layout, :now, :now)',
      { guid: randomUUID(), name, preset: input.preset ?? null, layout: JSON.stringify(spec), now },
    ).lastInsertRowid;
  }
  ctx.audit({
    action: existing ? 'alter' : 'create',
    entityType: 'cheque_layout',
    entityId: id,
    entityLabel: `Cheque layout ${name}`,
    before: existing ? { name: existing.name, spec: parseSpec(existing.layout) } : undefined,
    after: { name, spec },
  });
  return getLayout(db, id);
}

export function deleteLayout(ctx: CompanyCtx, id: number): { ok: true } {
  const { db } = ctx;
  requirePermission(ctx, 'masters.alter', 'delete cheque layouts');
  const l = getLayout(db, id);
  if (l.usedBy.length > 0) throw rule(`The layout “${l.name}” is used for ${l.usedBy.join(', ')}. Choose another layout for ${l.usedBy.length === 1 ? 'that bank' : 'those banks'} first.`);
  db.run('DELETE FROM cheque_layouts WHERE id = :id', { id });
  ctx.audit({ action: 'delete', entityType: 'cheque_layout', entityId: id, entityLabel: `Cheque layout ${l.name}`, before: { spec: l.spec } });
  return { ok: true };
}

// ───────────────────────────── bank settings ─────────────────────────────

export function getBankSettings(db: Db, bankLedgerId: number): ChequeBankSettings {
  const bank = requireBankLedger(db, bankLedgerId, 'Cheque printing');
  const r = db.get<{ layout_id: number | null; ac_payee: number; signatory: string | null; layout_name: string | null }>(
    `SELECT s.layout_id, s.ac_payee, s.signatory, l.name AS layout_name
       FROM cheque_bank_settings s LEFT JOIN cheque_layouts l ON l.id = s.layout_id WHERE s.bank_ledger_id = :b`,
    { b: bankLedgerId },
  );
  return {
    bankLedgerId,
    bankLedgerName: bank.name,
    layoutId: r?.layout_id ?? null,
    layoutName: r?.layout_name ?? null,
    acPayee: r ? r.ac_payee === 1 : true,
    signatory: r?.signatory ?? null,
  };
}

export function saveBankSettings(ctx: CompanyCtx, input: ChequeBankSettingsInput): ChequeBankSettings {
  const { db } = ctx;
  requirePermission(ctx, 'masters.alter', 'change cheque printing settings');
  const before = getBankSettings(db, input.bankLedgerId);
  const layoutId = input.layoutId === undefined ? before.layoutId : input.layoutId;
  if (layoutId !== null && db.value('SELECT 1 FROM cheque_layouts WHERE id = :id', { id: layoutId }) === undefined) {
    throw validation([{ path: 'layoutId', message: 'The chosen layout no longer exists' }]);
  }
  const signatory = input.signatory === undefined ? before.signatory : (input.signatory ?? '').trim() || null;
  if (signatory !== null && signatory.length > 100) throw validation([{ path: 'signatory', message: 'Keep the signatory text under 100 characters' }]);
  const acPayee = input.acPayee ?? before.acPayee;
  db.run(
    `INSERT INTO cheque_bank_settings (bank_ledger_id, layout_id, ac_payee, signatory, updated_at) VALUES (:b, :layout, :ac, :sig, :now)
     ON CONFLICT(bank_ledger_id) DO UPDATE SET layout_id = excluded.layout_id, ac_payee = excluded.ac_payee, signatory = excluded.signatory, updated_at = excluded.updated_at`,
    { b: input.bankLedgerId, layout: layoutId, ac: acPayee ? 1 : 0, sig: signatory, now: ctx.clock.now().toISOString() },
  );
  const after = getBankSettings(db, input.bankLedgerId);
  ctx.audit({
    action: 'settings',
    entityType: 'cheque_bank_settings',
    entityId: input.bankLedgerId,
    entityLabel: `Cheque printing — ${after.bankLedgerName}`,
    before: { layoutId: before.layoutId, acPayee: before.acPayee, signatory: before.signatory },
    after: { layoutId: after.layoutId, acPayee: after.acPayee, signatory: after.signatory },
  });
  return after;
}

/** The layout a bank prints with: its own, else the given one, else the standard preset. */
export function layoutForBank(db: Db, bankLedgerId: number, overrideId?: number | null): { id: number | null; name: string; spec: ChequeLayoutSpec } {
  const id = overrideId ?? db.value<number | null>('SELECT layout_id FROM cheque_bank_settings WHERE bank_ledger_id = :b', { b: bankLedgerId }) ?? null;
  if (id !== null) {
    const r = db.get<LayoutRow>('SELECT id, guid, name, preset, layout FROM cheque_layouts WHERE id = :id', { id });
    if (r) return { id: r.id, name: r.name, spec: parseSpec(r.layout) };
  }
  return { id: null, name: `${DEFAULT_PRESET.name} (preset)`, spec: DEFAULT_PRESET.spec };
}
