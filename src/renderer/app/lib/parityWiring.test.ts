/**
 * Wiring of the parity-wave UX fixes whose logic lives in pure, separately tested helpers: the screens
 * import React, so their use of the helper is checked on the source (removing the call must fail here),
 * and permission names quoted to users must be the names the Users & Roles screen shows
 * (src/core/modules/security/catalog.ts), or nobody can find the permission to grant.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const modulesDir = path.resolve(here, '../../modules');
const read = (rel: string): string => fs.readFileSync(path.join(modulesDir, rel), 'utf8');

function sources(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts')) out.push({ file: path.relative(path.resolve(here, '../..'), p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') });
  }
  return out;
}

describe('parity-wave UX fixes are wired into their screens', () => {
  test('GST Set-off: Esc asks before dropping typed penalty / other amounts (setoffDirty → useDirty)', () => {
    const src = read('gst/SetoffScreen.tsx');
    assert.match(src, /useDirty\(setoffDirty\(penalty, others, s \? posted : null\)\)/);
  });

  test('POS Return: Enter moves through the return quantities to the reason, then opens the refund', () => {
    const src = read('pos/ReturnScreen.tsx');
    assert.match(src, /const linesRef = useEnterAdvance<HTMLElement>\(\{ onComplete: openRefund \}\)/);
    // The container holds the quantity grid and the reason box.
    const start = src.indexOf('ref={linesRef}');
    assert.ok(start > 0, 'linesRef is attached');
    const block = src.slice(start, src.indexOf('</Stack>', src.indexOf('id="pos-ret-reason"')));
    assert.match(block, /aria-label="Lines of the bill"/);
    assert.match(block, /id="pos-ret-reason"/);
  });

  test('Quotation status dialog: starts on the right choice once the status loads, unless the user chose', () => {
    const src = read('documents/QuotationsScreen.tsx');
    assert.match(src, /if \(!chosen && current !== undefined\) setDecision\(defaultDecision\(current\)\)/);
    assert.match(src, /setChosen\(true\);\s*setDecision\(v\);/);
  });
});

describe('permission names quoted in screens', () => {
  const catalog = fs.readFileSync(path.resolve(here, '../../../core/modules/security/catalog.ts'), 'utf8');
  const labels = new Set([...catalog.matchAll(/'[a-z]+\.[a-z]+':\s*\{[^}]*?\blabel:\s*'([^']+)'/g)].map((m) => m[1]));

  test('the catalog scan finds the permission labels', () => {
    for (const l of ['Change company settings', 'Prepare GST filings', 'Manage TDS/TCS setup', 'Prepare TDS/TCS statements', 'Create vouchers', 'Alter masters']) assert.ok(labels.has(l), l);
  });

  test('every “…” permission named in a hint or banner is a real permission label', () => {
    const files = [...sources(modulesDir), ...sources(path.resolve(here, '..'))];
    const bad: string[] = [];
    let named = 0;
    for (const f of files) {
      for (const m of f.text.matchAll(/the [“"]([^”"$]+)[”"] permission/g)) {
        named++;
        if (!labels.has(m[1])) bad.push(`${f.file}: "${m[1]}"`);
      }
      // Templates: `Needs the “${saved ? 'Alter' : 'Create'} masters” permission`.
      for (const m of f.text.matchAll(/the “\$\{[^?]+\? '(\w+)' : '(\w+)'\} (\w+)” permission/g)) {
        named++;
        for (const v of [m[1], m[2]]) if (!labels.has(`${v} ${m[3]}`)) bad.push(`${f.file}: "${v} ${m[3]}"`);
      }
    }
    assert.ok(named >= 20, `only ${named} permission names found`);
    assert.deepEqual(bad, []);
  });
});
