/**
 * Invoice printing moved out of F12 to its own screen ('print.settings', "Invoice Printing"); F12 ›
 * Invoices only summarises it. Comments, READMEs and messages must not send people to the old
 * "F12 › Invoice printing" (follow-up 13).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function files(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else if (/\.(tsx?|md)$/.test(e.name) && p !== fileURLToPath(import.meta.url)) out.push(p);
  }
  return out;
}

describe('wording', () => {
  test('nothing points to "F12 › Invoice printing" any more (it is Invoice Printing, print.settings)', () => {
    const stale = [...files(path.join(root, 'src')), ...files(path.join(root, 'docs'))].filter((f) => /F12\s*›\s*(?:\*\s*)?Invoice\s+printing/i.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(stale.map((f) => path.relative(root, f)), []);
  });
});
