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

const guide = read('docs/USER_GUIDE.md');

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

  test('every Gateway path `Section › **Item**` names an item of that section', () => {
    const items = gatewayItems();
    const names = Object.values(SECTION_LABELS)
      .sort((a, b) => b.length - a.length)
      .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`(?<![\\w/&])(?<![\\w/&] )(${names.join('|')}) › (\\*{1,2})([^*\\n]+?)\\2(?!\\*)`, 'g');
    const checked: string[] = [];
    const wrong: string[] = [];
    for (const m of guide.matchAll(re)) {
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
    for (const m of guide.matchAll(/F11 › (\w+) › \*\*([^*\n]+)\*\*/g)) {
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
