/**
 * The user documentation against the code (docs/USER_GUIDE.md, README.md, docs/INSTALL.md, docs/SCOPE.md,
 * CHANGELOG.md): the guide keeps its agreed structure, its keyboard reference lists every global and
 * convention key of shortcuts.ts, every Gateway path it writes as `Section › **Item**` (or `*Item*`)
 * names an item that exists in that section, every F11 switch it names exists in that group, and every
 * relative link in the documents points at a file (and heading) that exists. A renamed menu item, a new
 * global key or a moved doc then fails here instead of leaving the guide wrong.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { REGISTERS } from '../../modules/reports/lib/model.ts';
import { voucherMenuEntries } from '../../modules/vouchers/lib/menu.ts';
import { FEATURE_CATALOG, FEATURE_GROUP_LABELS } from './featureCatalog.ts';
import { SECTION_LABELS } from './menu.ts';
import { CONVENTION_SHORTCUTS, GLOBAL_SHORTCUTS, VOUCHER_FEATURE } from './shortcuts.ts';
import type { MenuSection } from '../registry.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const modulesDir = path.join(repoRoot, 'src/renderer/modules');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

/** Gateway labels per section label, from the modules' static menus plus the generated entries. */
function gatewayItems(): Map<string, Set<string>> {
  const bySection = new Map<string, Set<string>>();
  const add = (section: MenuSection, label: string) => {
    const name = SECTION_LABELS[section];
    if (!bySection.has(name)) bySection.set(name, new Set());
    bySection.get(name)?.add(label);
  };
  const re = /section:\s*'([a-z_]+)'\s*,\s*label:\s*'([^']+)'/g;
  for (const dir of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    const file = path.join(modulesDir, dir.name, 'index.ts');
    if (!dir.isDirectory() || !fs.existsSync(file)) continue;
    for (const m of fs.readFileSync(file, 'utf8').matchAll(re)) add(m[1] as MenuSection, m[2]);
  }
  for (const r of REGISTERS) add('reports', r.label);
  for (const e of voucherMenuEntries(VOUCHER_FEATURE)) add('transactions', e.label);
  return bySection;
}

/** GitHub's heading anchor: lower case, punctuation dropped (hyphens kept), spaces → hyphens. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[*`_]/g, '')
    .replace(/[^\p{L}\p{N} -]/gu, '')
    .replace(/ /g, '-');
}

function anchorsOf(markdown: string): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    const m = !inFence ? /^#{1,6}\s+(.*)$/.exec(line) : null;
    if (!m) continue;
    const base = slug(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

/** One `## …` section of a markdown file (up to the next `## `). */
function section(markdown: string, heading: RegExp): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => heading.test(l));
  assert.ok(start >= 0, `section ${heading} not found`);
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

/** How a key of shortcuts.ts is written in the guide. */
function guideKey(key: string): string {
  return key.replace(/^Escape$/, 'Esc').replace(/ArrowUp/g, '↑').replace(/ArrowDown/g, '↓');
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/**
 * Source of the screens in the guide's "Keys of particular screens" table (paths under
 * src/renderer/modules; a folder means every file in it). The app shell is always included: it binds
 * the report keys (Alt+F2, Alt+E, Alt+P) of every report screen.
 */
const SCREEN_FILES: Record<string, string[]> = {
  'Select a Company': ['company/CompanySelect.tsx'],
  Gateway: [],
  'Day Book': ['vouchers/DayBookScreen.tsx', 'vouchers/VoucherTable.tsx'],
  'Voucher view': [
    'vouchers/VoucherViewScreen.tsx',
    'attachments',
    'cheques/VoucherChequePanel.tsx',
    'pos/VoucherPanel.tsx',
    'tds/VoucherPanel.tsx',
    'forex/VoucherPanel.tsx',
    'documents/components.tsx',
    'print/VoucherSharePanel.tsx',
  ],
  'Print preview': ['print/PrintVoucherScreen.tsx'],
  'Trial Balance': ['reports/TrialBalanceScreen.tsx', 'reports/overlay.tsx'],
  'Balance Sheet / P&L': ['reports/BalanceSheetScreen.tsx', 'reports/ProfitLossScreen.tsx', 'reports/overlay.tsx'],
  Ledger: ['reports/LedgerScreen.tsx'],
  'Receivables / Payables': ['outstanding/OutstandingReport.tsx', 'outstanding/lib/model.ts'],
  'Bank Reconciliation': ['banking/BrsScreen.tsx'],
  'Match Statement': ['banking/MatchScreen.tsx'],
  'GSTR-1 / GSTR-3B': ['gst/Gstr1Screen.tsx', 'gst/Gstr3bScreen.tsx'],
  'GST Set-off': ['gst/SetoffScreen.tsx'],
  'e-Invoice / e-Way Bills': ['gst/EinvoiceScreen.tsx', 'gst/EwaybillScreen.tsx'],
  'POS Counter': ['pos/CounterScreen.tsx'],
  'Print Cheques': ['cheques/PrintChequesScreen.tsx'],
  Backup: ['data/BackupScreen.tsx'],
  'Edit Log': ['security/AuditScreen.tsx'],
};

/** Keys bound in the given files: every string literal that is a key or a comma-separated key list. */
function boundKeys(rels: readonly string[]): { keys: Set<string>; ctrlDigits: boolean } {
  const files = [path.join(repoRoot, 'src/renderer/app/Screen.tsx')];
  for (const rel of rels) {
    const p = path.join(modulesDir, rel);
    assert.ok(fs.existsSync(p), `${rel} (SCREEN_FILES) does not exist`);
    files.push(...(fs.statSync(p).isDirectory() ? sourceFiles(p) : [p]));
  }
  const keys = new Set<string>();
  let ctrlDigits = false;
  for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`/g)) {
      const lit = m[1] ?? m[2] ?? m[3] ?? '';
      if (lit.startsWith('Ctrl+${')) ctrlDigits = true;
      const parts = lit.split(/,\s*/);
      if (parts.every((k) => /^(?:(?:Ctrl|Alt|Shift)\+)+\S+$|^Page(?:Up|Down)$/.test(k))) for (const k of parts) keys.add(k);
    }
  }
  return { keys, ctrlDigits };
}

/**
 * The modifier keys (and PgUp / PgDn) written in one bold run of the guide, as the code writes them:
 * "Ctrl+1/2/3" → Ctrl+1, Ctrl+2, Ctrl+3; "Ctrl+1…4" → Ctrl+1 … Ctrl+4; "Ctrl+PgUp / PgDn" →
 * Ctrl+PageUp, Ctrl+PageDown. Plain keys (Enter, Space, arrows, letters) belong to the lists and grids.
 */
function expandGuideKeys(bold: string): string[] {
  const out: string[] = [];
  const parts = bold.split(/\s*\/\s*/);
  const prefix = /^((?:(?:Ctrl|Alt|Shift)\+)+)/.exec(parts[0] ?? '')?.[1] ?? '';
  for (const [i, raw] of parts.entries()) {
    const part = i > 0 && !raw.includes('+') && prefix ? prefix + raw : raw;
    const range = /^(.*\+)(\d)…(\d)$/.exec(part);
    const keys = range ? Array.from({ length: Number(range[3]) - Number(range[2]) + 1 }, (_, j) => `${range[1]}${Number(range[2]) + j}`) : [part];
    for (const k of keys) {
      const code = k.replace(/PgUp$/, 'PageUp').replace(/PgDn$/, 'PageDown');
      if (/^(?:(?:Ctrl|Alt|Shift)\+)+\S+$|^Page(?:Up|Down)$/.test(code)) out.push(code);
    }
  }
  return out;
}

/**
 * Convention keys some screens use for something else (shortcuts.ts allows it where the convention has
 * nothing to act on): the label of a conventional use, and the phrase of 15.2 that names each other
 * screen (path under src/renderer/modules).
 */
const KEY_DEVIATIONS: Record<string, { conventional: RegExp; screens: Record<string, string> }> = {
  'Alt+W': {
    conventional: /share/i,
    screens: {
      'outstanding/OutstandingReport.tsx': '*Receivables* / *Payables*',
      'outstanding/RemindersScreen.tsx': '*Payment Reminders*',
      'stock/AnalysisScreens.tsx': '*Batch Summary*',
      'security/SessionScreen.tsx': '*My Session*',
    },
  },
  'Alt+X': {
    conventional: /cancel|expand|collapse/i,
    screens: {
      'banking/BrsScreen.tsx': '*Bank Reconciliation*',
      'cheques/PrintChequesScreen.tsx': '*Print Cheques*',
      'gst/Gstr1Screen.tsx': 'GSTR-1 / GSTR-3B',
      'gst/Gstr3bScreen.tsx': 'GSTR-1 / GSTR-3B',
      'data/ImportScreen.tsx': '*Import from Excel*',
      'security/AuditScreen.tsx': '*Edit Log*',
    },
  },
};

const guide = read('docs/USER_GUIDE.md');
/**
 * The guide with the line breaks inside a paragraph or list item joined, so a path wrapped across two
 * lines ("*TDS / TCS ›\n**TDS / TCS Setup***") is checked like any other. New list items, table rows,
 * headings and blank lines keep their break.
 */
const flatGuide = guide.replace(/\n(?!\n|\s*[-|#>]\s|\s*\d+\.\s|\s*\*\*\d+\.)/g, ' ').replace(/ {2,}/g, ' ');

describe('docs/USER_GUIDE.md', () => {
  test('keeps one structure: Getting started → … → Troubleshooting, numbered in order', () => {
    const expected = [
      'Getting started',
      'Company, features (F11) and configuration (F12)',
      'Masters',
      'Vouchers',
      'Inventory and manufacturing',
      'GST',
      'TDS and TCS',
      'Banking and cheques',
      'Outstanding: receivables and payables',
      'Reports and budgets',
      'Multiple currencies',
      'Printing and sharing',
      'Data: backup, restore, import, Tally, attachments',
      'Security and users',
      'Keyboard reference',
      'Troubleshooting and FAQ',
    ];
    const headings = [...guide.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => `${m[1]}. ${m[2]}`);
    assert.deepEqual(headings, expected.map((h, i) => `${i + 1}. ${h}`));
  });

  test('the keyboard reference lists every global key of shortcuts.ts with its action', () => {
    const ref = section(guide, /^## \d+\. Keyboard reference/);
    const missing: string[] = [];
    for (const s of GLOBAL_SHORTCUTS) {
      for (const key of s.keys.split(',').map((k) => guideKey(k.trim()))) {
        if (!ref.includes(`**${key}**`)) missing.push(`${key} (${s.label})`);
      }
      // Voucher keys: the key and the voucher name are on the same table row.
      if (s.baseType) {
        const row = ref.split('\n').find((l) => l.includes(`| **${s.keys}** |`));
        if (!row || !row.includes(s.label)) missing.push(`${s.keys} row naming ${s.label}`);
      }
    }
    assert.deepEqual(missing, []);
  });

  test('the keyboard reference lists every convention key of shortcuts.ts', () => {
    const ref = section(guide, /^## \d+\. Keyboard reference/);
    const missing: string[] = [];
    for (const s of CONVENTION_SHORTCUTS) {
      for (const key of s.keys.split(',').map((k) => guideKey(k.trim()))) {
        if (!ref.includes(`**${key}**`)) missing.push(`${key} (${s.label})`);
      }
    }
    assert.deepEqual(missing, []);
  });

  test('every key of "Keys of particular screens" is bound by that screen', () => {
    const ref = section(guide, /^## \d+\. Keyboard reference/);
    const table = ref.slice(ref.indexOf('### 15.4'));
    const rows = table.split('\n').filter((l) => /^\| [^-|]/.test(l) && !l.startsWith('| Screen |'));
    assert.ok(rows.length >= 15, `only ${rows.length} screen rows found — has the table moved?`);
    const missingScreens: string[] = [];
    const unbound: string[] = [];
    let checked = 0;
    for (const row of rows) {
      const [, name = '', keys = ''] = row.split('|').map((c) => c.trim());
      const files = SCREEN_FILES[name];
      if (!files) {
        missingScreens.push(name);
        continue;
      }
      const bound = boundKeys(files);
      for (const m of keys.matchAll(/\*\*([^*]+)\*\*/g)) {
        for (const key of expandGuideKeys(m[1])) {
          checked++;
          const ok = bound.keys.has(key) || (bound.ctrlDigits && /^Ctrl\+\d$/.test(key));
          if (!ok) unbound.push(`${name}: ${key}`);
        }
      }
    }
    assert.deepEqual(missingScreens, [], 'map each new row of 15.4 to its source files in SCREEN_FILES');
    assert.ok(checked > 80, `only ${checked} keys checked`);
    assert.deepEqual(unbound, []);
  });

  test('every screen giving Alt+W / Alt+X another meaning is named in 15.2', () => {
    const conventions = section(guide, /^## \d+\. Keyboard reference/);
    const text = conventions
      .slice(conventions.indexOf('### 15.2'), conventions.indexOf('### 15.3'))
      .replace(/\s*\n\s*/g, ' ');
    const found: string[] = [];
    const undocumented: string[] = [];
    for (const [key, { conventional, screens }] of Object.entries(KEY_DEVIATIONS)) {
      for (const file of sourceFiles(modulesDir)) {
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(new RegExp(`key: '${key.replace('+', '\\+')}',[\\s\\S]{0,40}?label: ([^,\\n]+)`, 'g'))) {
          if (conventional.test(m[1])) continue;
          const rel = path.relative(modulesDir, file).split(path.sep).join('/');
          found.push(`${key} ${rel}`);
          const phrase = screens[rel];
          if (!phrase || !text.includes(phrase)) undocumented.push(`${key} in ${rel} (${m[1].trim()})`);
        }
      }
    }
    assert.ok(found.length >= 8, `only ${found.length} deviations found — has the action notation changed?`);
    assert.deepEqual(undocumented, []);
  });

  test('every Gateway path `Section › **Item**` names an item of that section', () => {
    const items = gatewayItems();
    const names = Object.values(SECTION_LABELS)
      .sort((a, b) => b.length - a.length)
      .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`(?<![\\w/&])(?<![\\w/&]\\s)(${names.join('|')}) › (\\*{1,2})([^*\\n]+?)\\2`, 'g');
    const checked: string[] = [];
    const wrong: string[] = [];
    for (const m of flatGuide.matchAll(re)) {
      const [, sectionName, , label] = m;
      checked.push(`${sectionName} › ${label}`);
      if (!items.get(sectionName)?.has(label)) wrong.push(`${sectionName} › ${label}`);
    }
    assert.ok(checked.length > 100, `only ${checked.length} menu paths found — has the guide's notation changed?`);
    assert.deepEqual(wrong, []);
  });

  test('every F11 switch `F11 › Group › **Feature**` exists in that group', () => {
    const groups = new Map<string, Set<string>>();
    for (const f of FEATURE_CATALOG) {
      const g = FEATURE_GROUP_LABELS[f.group];
      if (!groups.has(g)) groups.set(g, new Set());
      groups.get(g)?.add(f.label);
    }
    const wrong: string[] = [];
    let count = 0;
    for (const m of flatGuide.matchAll(/F11 › (\w+) › \*\*([^*\n]+)\*\*/g)) {
      count++;
      if (!groups.get(m[1])?.has(m[2])) wrong.push(`F11 › ${m[1]} › ${m[2]}`);
    }
    assert.ok(count >= 8, `only ${count} F11 paths found`);
    assert.deepEqual(wrong, []);
  });

  test('every F11 feature appears in the guide', () => {
    const missing = FEATURE_CATALOG.filter((f) => !guide.includes(`**${f.label}**`)).map((f) => f.label);
    assert.deepEqual(missing, []);
  });
});

describe('links between the documents', () => {
  const docs = ['README.md', 'CHANGELOG.md', 'docs/USER_GUIDE.md', 'docs/INSTALL.md', 'docs/SCOPE.md', 'docs/ARCHITECTURE.md', 'docs/SECURITY.md', 'docs/BUILD.md'];

  test('the user-facing documents exist', () => {
    for (const d of docs) assert.ok(fs.existsSync(path.join(repoRoot, d)), `${d} is missing`);
  });

  test('every relative link points at an existing file and, for a markdown file, an existing heading', () => {
    const broken: string[] = [];
    for (const d of docs) {
      const text = read(d);
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (/^[a-z]+:/i.test(target)) continue; // https:, mailto:
        const [file, anchor] = target.split('#') as [string, string | undefined];
        const resolved = file === '' ? path.join(repoRoot, d) : path.resolve(path.dirname(path.join(repoRoot, d)), file);
        if (!fs.existsSync(resolved)) {
          broken.push(`${d}: ${target} (no such file)`);
          continue;
        }
        if (anchor && resolved.endsWith('.md') && !anchorsOf(fs.readFileSync(resolved, 'utf8')).has(anchor)) {
          broken.push(`${d}: ${target} (no such heading)`);
        }
      }
    }
    assert.deepEqual(broken, []);
  });

  test('README links the guide, install, scope, architecture, security, build docs and the changelog', () => {
    const readme = read('README.md');
    for (const target of ['docs/USER_GUIDE.md', 'docs/INSTALL.md', 'docs/SCOPE.md', 'docs/ARCHITECTURE.md', 'docs/SECURITY.md', 'docs/BUILD.md', 'CHANGELOG.md']) {
      assert.ok(readme.includes(`](${target}`), `README.md does not link ${target}`);
    }
  });
});
