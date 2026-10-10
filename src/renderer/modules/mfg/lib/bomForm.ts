/**
 * Bill of Materials form — pure state and mapping (tested in bomForm.test.ts).
 */
import type { BomDetail, BomLineKind, BomSaveInput, BomValueBasis } from '../../../../shared/types/mfg.ts';

export interface BomRow {
  key: string;
  kind: BomLineKind;
  itemId: number | null;
  itemName: string;
  unit: string;
  qty: number | null;
  godownId: number | null;
  valueBasis: BomValueBasis;
  valueRate: number | null;
  valuePct: number | null;
}

export interface BomForm {
  itemId: number | null;
  itemName: string;
  unit: string;
  name: string;
  outputQty: number | null;
  isDefault: boolean;
  isActive: boolean;
  notes: string;
  rows: BomRow[];
}

let seq = 0;
const key = (): string => `b${++seq}`;

export function blankBomRow(kind: BomLineKind = 'component'): BomRow {
  return { key: key(), kind, itemId: null, itemName: '', unit: '', qty: null, godownId: null, valueBasis: kind === 'component' ? 'nil' : 'rate', valueRate: null, valuePct: null };
}

export function emptyBomForm(item?: { id: number; name: string; unit: string } | null): BomForm {
  return {
    itemId: item?.id ?? null,
    itemName: item?.name ?? '',
    unit: item?.unit ?? '',
    name: 'Standard',
    outputQty: 1,
    isDefault: true,
    isActive: true,
    notes: '',
    rows: [blankBomRow('component')],
  };
}

export function bomFormFrom(d: BomDetail): BomForm {
  return {
    itemId: d.itemId,
    itemName: d.itemName,
    unit: d.unit,
    name: d.name,
    outputQty: d.outputQty,
    isDefault: d.isDefault,
    isActive: d.isActive,
    notes: d.notes ?? '',
    rows: d.lines.map((l) => ({
      key: key(),
      kind: l.kind,
      itemId: l.itemId,
      itemName: l.itemName,
      unit: l.unit,
      qty: l.qty,
      godownId: l.godownId,
      valueBasis: l.valueBasis ?? 'nil',
      valueRate: l.valueRate,
      valuePct: l.valuePct,
    })),
  };
}

/** Rows that will be saved (item and quantity filled), with the key of each `lines[i]`. */
export function toBomInput(form: BomForm, alter?: { id: number; updatedAt: string }): { input: BomSaveInput | null; lineKeys: string[] } {
  const filled = form.rows.filter((r) => r.itemId !== null && r.qty !== null && r.qty > 0);
  if (form.itemId === null) return { input: null, lineKeys: [] };
  const input: BomSaveInput = {
    itemId: form.itemId,
    name: form.name.trim(),
    outputQty: form.outputQty ?? 0,
    isDefault: form.isDefault,
    isActive: form.isActive,
    notes: form.notes.trim() || null,
    lines: filled.map((r) => ({
      kind: r.kind,
      itemId: r.itemId as number,
      qty: r.qty as number,
      godownId: r.godownId,
      valueBasis: r.kind === 'component' ? null : r.valueBasis,
      valueRate: r.kind !== 'component' && r.valueBasis === 'rate' ? (r.valueRate ?? 0) : null,
      valuePct: r.kind !== 'component' && r.valueBasis === 'percent' ? (r.valuePct ?? 0) : null,
    })),
  };
  if (alter) {
    input.id = alter.id;
    input.expectedUpdatedAt = alter.updatedAt;
  }
  return { input, lineKeys: filled.map((r) => r.key) };
}

/** `lines[2].qty` → that row's key; other paths stay field / general errors. */
export function mapBomErrors(errors: Readonly<Record<string, string>>, lineKeys: readonly string[]): { rows: Map<string, string>; fields: Record<string, string>; general: string[] } {
  const rows = new Map<string, string>();
  const fields: Record<string, string> = {};
  const general: string[] = [];
  for (const [path, msg] of Object.entries(errors)) {
    const m = /^lines\[(\d+)\]/.exec(path) ?? /^lines\.(\d+)/.exec(path);
    if (m && lineKeys[Number(m[1])]) rows.set(lineKeys[Number(m[1])], msg);
    else if (/^(itemId|name|outputQty|notes)$/.test(path)) fields[path] = msg;
    else general.push(msg);
  }
  return { rows, fields, general };
}

export const BOM_KIND_LABELS: Readonly<Record<BomLineKind, string>> = { component: 'Component', by_product: 'By-product', scrap: 'Scrap' };
export const VALUE_BASIS_LABELS: Readonly<Record<BomValueBasis, string>> = { nil: 'No value', rate: 'Rate per unit', percent: '% of cost' };
