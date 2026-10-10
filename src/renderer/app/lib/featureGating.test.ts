/**
 * F11 off ⇒ no trace: with a feature turned off, neither the Gateway nor Go To offers anything of the
 * module behind it (TDS / TCS, multi-currency, POS, manufacturing / job work, cheque printing), and
 * turning it on brings exactly those entries back. Built from the REAL module sources: their index
 * files import React, so screens and menu items (with `feature`, `anyFeature`, `gstOnly`, `access`
 * and the module constants they use, e.g. `const FX = 'multiCurrency' as const`) are read as text and
 * fed to the shell's own pure builders (lib/menu.ts buildGateway, lib/gotoItems.ts).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Permission } from '../../../shared/constants.ts';
import { DEFAULT_FEATURES } from '../../../shared/settings.ts';
import type { CompanyFeatures } from '../../../shared/settings.ts';
import { voucherMenuEntries } from '../../modules/vouchers/lib/menu.ts';
import type { MenuItem, MenuSection, ModuleDef, ScreenDef } from '../registry.ts';
import { buildStaticGotoItems } from './gotoItems.ts';
import { buildGateway } from './menu.ts';
import type { MenuContext } from './menu.ts';
import { VOUCHER_FEATURE } from './shortcuts.ts';

const modulesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../modules');
type Feature = keyof CompanyFeatures;

/** Brace-balanced object literals starting at each match of `start`. */
function objects(text: string, start: RegExp): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(start)) {
    let depth = 0;
    let j = m.index;
    for (; j < text.length; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}' && --depth === 0) break;
    }
    out.push(text.slice(m.index, j + 1));
  }
  return out;
}

const list = (raw: string): string[] => [...raw.matchAll(/'([^']+)'/g)].map((m) => m[1]);

/** `feature` / `anyFeature` / `gstOnly` / `access` of a screen or menu item literal. */
function gating(obj: string, consts: Map<string, string | string[]>): Pick<ScreenDef, 'feature' | 'anyFeature' | 'gstOnly' | 'access'> {
  const out: Pick<ScreenDef, 'feature' | 'anyFeature' | 'gstOnly' | 'access'> = {};
  const f = /\bfeature:\s*(?:'(\w+)'|([A-Z_]+))/.exec(obj);
  if (f) {
    const v = f[1] ?? consts.get(f[2]);
    assert.ok(typeof v === 'string', `unresolved feature constant ${f[2]}`);
    out.feature = v as Feature;
  }
  const a = /\banyFeature:\s*(?:\[([^\]]*)\]|([A-Z_]+))/.exec(obj);
  if (a) {
    const v = a[1] !== undefined ? list(a[1]) : consts.get(a[2]);
    assert.ok(Array.isArray(v), `unresolved anyFeature constant ${a[2]}`);
    out.anyFeature = v as Feature[];
  }
  if (/\bgstOnly:\s*true/.test(obj)) out.gstOnly = true;
  const acc = /\baccess:\s*'([^']+)'/.exec(obj);
  if (acc) out.access = acc[1] as Permission;
  return out;
}

const dummy = (() => null) as unknown as ScreenDef['component'];

function realModules(): ModuleDef[] {
  const mods: ModuleDef[] = [];
  for (const dir of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    const file = path.join(modulesDir, dir.name, 'index.ts');
    if (!dir.isDirectory() || !fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const consts = new Map<string, string | string[]>();
    for (const m of text.matchAll(/const ([A-Z_]+) = '(\w+)' as const/g)) consts.set(m[1], m[2]);
    for (const m of text.matchAll(/const ([A-Z_]+) = \[([^\]]*)\] as const/g)) consts.set(m[1], list(m[2]));
    const screens: ScreenDef[] = objects(text, /\{\s*id:\s*'[a-z]+\.[^']*'\s*,\s*title:/g).map((o) => ({
      id: /id:\s*'([^']+)'/.exec(o)?.[1] ?? '',
      title: /title:\s*'([^']+)'/.exec(o)?.[1] ?? '',
      component: dummy,
      ...gating(o, consts),
      ...(/\bgoto:\s*true/.test(o) ? { goto: true } : {}),
    }));
    const menu: MenuItem[] = objects(text, /\{\s*section:\s*'[a-z_]+'\s*,\s*label:\s*'/g).map((o) => ({
      section: /section:\s*'([a-z_]+)'/.exec(o)?.[1] as MenuSection,
      label: /label:\s*'([^']+)'/.exec(o)?.[1] ?? '',
      screen: /screen:\s*'([^']+)'/.exec(o)?.[1] ?? '',
      ...(/\bparams:\s*\{/.test(o) ? { params: { scanned: true } } : {}),
      ...gating(o, consts),
    }));
    if (dir.name === 'vouchers') {
      menu.push(...voucherMenuEntries(VOUCHER_FEATURE).map((e): MenuItem => ({ section: 'transactions', label: e.label, screen: 'vouchers.entry', params: { baseType: e.baseType }, ...(e.feature ? { feature: e.feature } : {}) })));
    }
    mods.push({ id: dir.name, screens, menu });
  }
  return mods;
}

const ALL_OFF: CompanyFeatures = Object.fromEntries(Object.keys(DEFAULT_FEATURES).map((k) => [k, false])) as unknown as CompanyFeatures;
const ctxWith = (on: Partial<CompanyFeatures>): MenuContext => ({ can: () => true, gstEnabled: true, features: { ...ALL_OFF, gst: true, ...on } });

/** Labels the Gateway and Go To offer from the given modules. */
function offered(mods: readonly ModuleDef[], ctx: MenuContext, moduleIds: readonly string[]): string[] {
  const ids = new Set(moduleIds);
  const screenModule = new Map(mods.flatMap((m) => m.screens.map((s) => [s.id, m.id] as const)));
  const gateway = buildGateway(mods, ctx).flatMap((s) => s.items).filter((i) => ids.has(i.moduleId) || ids.has(screenModule.get(i.screen) ?? '')).map((i) => `gateway: ${i.label}`);
  const goto = buildStaticGotoItems(mods, ctx, { includeVouchers: false })
    .filter((i) => i.screen !== '' && ids.has(screenModule.get(i.screen) ?? ''))
    .map((i) => `goto: ${i.label}`);
  return [...gateway, ...goto];
}

describe('F11 feature gating of the parity-wave modules (real menus and screens)', () => {
  const mods = realModules();

  test('the scan resolves the modules, their screens and feature constants', () => {
    const screen = (id: string) => mods.flatMap((m) => m.screens).find((s) => s.id === id);
    assert.equal(screen('forex.ledger')?.feature, 'multiCurrency');
    assert.deepEqual(screen('tds.setup')?.anyFeature, ['tds', 'tcs']);
    assert.equal(screen('tds.receivable')?.feature, 'tds');
    assert.equal(screen('pos.counter')?.feature, 'pos');
    assert.deepEqual(screen('mfg.journal.entry')?.anyFeature, ['manufacturing', 'jobWork']);
    assert.equal(screen('cheques.books')?.feature, 'chequePrinting');
    assert.ok(mods.find((m) => m.id === 'mfg')?.menu?.some((i) => i.label === 'Material Out' && i.params));
  });

  test('every feature off: nothing of TDS / TCS, forex, POS or manufacturing / job work is offered anywhere', () => {
    assert.deepEqual(offered(mods, ctxWith({}), ['tds', 'forex', 'pos', 'mfg']), []);
  });

  test('cheque printing off: only the always-available payee bank details and e-payment file remain', () => {
    assert.deepEqual(offered(mods, ctxWith({}), ['cheques']).sort(), ['gateway: E-payment File', 'gateway: Payee Bank Details', 'goto: E-payment File', 'goto: Payee Bank Details']);
  });

  test('turning a feature on brings its entries back (and only those)', () => {
    const has = (labels: string[], label: string) => labels.includes(`gateway: ${label}`);
    const pos = offered(mods, ctxWith({ pos: true, inventory: true }), ['pos']);
    for (const l of ['POS Counter', 'POS Return / Exchange', 'POS Day-end Summary', 'POS Settings']) assert.ok(has(pos, l), l);
    const fx = offered(mods, ctxWith({ multiCurrency: true }), ['forex']);
    for (const l of ['Multi-currency Settings', 'Opening Balance in Currency', 'Forex Outstanding', 'Ledger in Foreign Currency', 'Forex Revaluation']) assert.ok(has(fx, l), l);
    // TCS alone: the TDS / TCS section, but not the TDS-only receivable (Form 26AS).
    const tcs = offered(mods, ctxWith({ tcs: true }), ['tds']);
    assert.ok(has(tcs, 'TDS / TCS Setup'));
    assert.ok(!has(tcs, 'TDS Receivable vs 26AS'));
    assert.ok(has(offered(mods, ctxWith({ tds: true }), ['tds']), 'TDS Receivable vs 26AS'));
    // Job work without manufacturing: Material In / Out and ITC-04, no BOMs or Manufacturing Journal.
    const jw = offered(mods, ctxWith({ jobWork: true, inventory: true }), ['mfg']);
    for (const l of ['Material Out', 'Material In', 'Job Work Orders', 'Pending Job Work', 'ITC-04', 'Production Register']) assert.ok(has(jw, l), l);
    for (const l of ['Bills of Materials', 'Create BOM', 'Manufacturing Journal']) assert.ok(!has(jw, l), l);
    const chq = offered(mods, ctxWith({ chequePrinting: true }), ['cheques']);
    for (const l of ['Cheque Books', 'Cheque Layouts', 'Print Cheques', 'Cheque Leaf Register']) assert.ok(has(chq, l), l);
  });

  test('a menu item never offers a screen its own gating would allow but the screen refuses', () => {
    // Items inherit their screen's gating (filterMenu): with each parity feature on alone, every
    // offered item's screen is openable under the same context.
    const screens = new Map(mods.flatMap((m) => m.screens.map((s) => [s.id, s] as const)));
    for (const f of ['tds', 'tcs', 'multiCurrency', 'pos', 'manufacturing', 'jobWork', 'chequePrinting'] as const) {
      const ctx = ctxWith({ [f]: true, inventory: true });
      for (const i of buildGateway(mods, ctx).flatMap((s) => s.items)) {
        const s = screens.get(i.screen);
        if (!s) continue;
        const feats = ctx.features ?? {};
        assert.ok(!s.feature || feats[s.feature] !== false, `${i.label} (${f}): screen needs ${s.feature}`);
        assert.ok(!s.anyFeature || s.anyFeature.some((x) => feats[x] !== false), `${i.label} (${f}): screen needs one of ${s.anyFeature?.join(', ')}`);
      }
    }
  });
});

// ─────────────── Voucher-view panels (ModuleDef.voucherPanels) ───────────────

/** Every module's `voucherPanels: [A, B]` with the panel component's source (top-level function body). */
function realPanels(): Array<{ where: string; body: string }> {
  const out: Array<{ where: string; body: string }> = [];
  for (const dir of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    const index = path.join(modulesDir, dir.name, 'index.ts');
    if (!dir.isDirectory() || !fs.existsSync(index)) continue;
    const text = fs.readFileSync(index, 'utf8');
    const listed = /voucherPanels:\s*\[([^\]]*)\]/.exec(text);
    if (!listed) continue;
    for (const name of listed[1].split(',').map((n) => n.trim()).filter(Boolean)) {
      const imp = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/([^']+)'/g)].find((m) => m[1].split(',').some((n) => n.trim() === name));
      assert.ok(imp, `${dir.name}/index.ts: cannot find the import of ${name}`);
      const src = fs.readFileSync(path.join(modulesDir, dir.name, imp[2]), 'utf8');
      const body = src.split(/\n(?=(?:export )?function [A-Z])/).find((p) => new RegExp(`^(?:export )?function ${name}\\b`).test(p.trimStart()));
      assert.ok(body, `${dir.name}/${imp[2]}: no function ${name}`);
      out.push({ where: `${dir.name}/${imp[2]}#${name}`, body });
    }
  }
  return out;
}

describe('F11 feature gating of voucher-view panels (real sources)', () => {
  const panels = realPanels();
  const screens = new Map(realModules().flatMap((m) => m.screens.map((s) => [s.id, s] as const)));

  test('the scan finds the panels', () => {
    assert.ok(panels.length >= 9, `only ${panels.length} panels`);
    for (const p of ['tds/', 'forex/', 'pos/', 'cheques/', 'documents/']) assert.ok(panels.some((x) => x.where.startsWith(p)), p);
  });

  test('a rail action that opens a feature screen is gated on that feature (no Alt+key left behind when F11 turns it off)', () => {
    const bad: string[] = [];
    let checked = 0;
    for (const p of panels) {
      // The panel's own gate: `const on = useFeatures().pos …` / `const applies = on && …`.
      const gate = [...p.body.matchAll(/const (?:on|applies) = [^\n]*/g)].map((m) => m[0]).join('\n');
      for (const obj of objects(p.body, /\{\s*key:\s*['A-Z`]/g)) {
        const target = /nav\.push\('([^']+)'/.exec(obj)?.[1];
        const s = target ? screens.get(target) : undefined;
        const needs = s?.feature ? [s.feature] : (s?.anyFeature ?? []);
        if (needs.length === 0) continue;
        checked++;
        const text = `${obj}\n${gate}`;
        const missing = needs.filter((f) => !new RegExp(`(?:features|useFeatures\\(\\))\\.${f}\\b`).test(text));
        if (missing.length > 0) bad.push(`${p.where}: ${target} needs ${missing.join(', ')}`);
      }
    }
    assert.ok(checked >= 5, `only ${checked} feature-screen actions found`);
    assert.deepEqual(bad, []);
  });

  test('a panel whose keys come from fetched data drops that data while its feature is off (the query cache outlives F11)', () => {
    const bad: string[] = [];
    for (const p of panels) {
      if (!/useScreenActions\(/.test(p.body) || !/enabled:\s*on\b/.test(p.body)) continue;
      const reads = (p.body.match(/\bq\.data\b/g) ?? []).length;
      const gated = (p.body.match(/\bon \? q\.data\b/g) ?? []).length;
      if (reads !== gated) bad.push(p.where);
    }
    assert.deepEqual(bad, []);
  });
});
