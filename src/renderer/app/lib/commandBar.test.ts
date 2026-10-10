import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commandBarSlots, layoutCommandBar } from './commandBar.ts';
import type { CommandBarAction } from './commandBar.ts';

const a = (key: string, label: string, extra: Partial<CommandBarAction> = {}): CommandBarAction => ({ key, label, ...extra });
const keys = (list: readonly CommandBarAction[]) => list.map((x) => x.key);

const GLOBALS = [a('F11', 'Features'), a('F12', 'Configure'), a('F1', 'Help')];

describe('command bar selection', () => {
  test('widths: 3 buttons from 900 px, 2 from 640 px, else 1', () => {
    assert.equal(commandBarSlots(1400), 3);
    assert.equal(commandBarSlots(900), 3);
    assert.equal(commandBarSlots(899), 2);
    assert.equal(commandBarSlots(640), 2);
    assert.equal(commandBarSlots(639), 1);
    assert.equal(commandBarSlots(0), 1);
  });

  test('primary is the filled button; conventions fill the rest in the agreed order', () => {
    // A voucher view: Alt+A alter, Alt+P print, Alt+W share, Alt+H history, Alt+X cancel, Alt+D delete.
    const screen = [a('Alt+H', 'Edit history'), a('Alt+X', 'Cancel'), a('Alt+W', 'Share'), a('Alt+P', 'Print'), a('Alt+D', 'Delete'), a('Alt+A', 'Alter', { primary: true })];
    const l = layoutCommandBar(screen, GLOBALS, 3);
    assert.equal(l.primary?.key, 'Alt+A');
    assert.deepEqual(keys(l.buttons), ['Alt+P', 'Alt+W']);
    // More: every other visible action with its key (declaration order), then the globals.
    assert.deepEqual(keys(l.more), ['Alt+H', 'Alt+X', 'Alt+D', 'F11', 'F12', 'F1']);
  });

  test('prominent actions come first, in declaration order, before the conventions', () => {
    const screen = [a('Alt+E', 'Export'), a('Alt+R', 'Make recurring', { prominent: true }), a('Alt+P', 'Print'), a('Alt+K', 'Pre-close', { prominent: true })];
    assert.deepEqual(keys(layoutCommandBar(screen, [], 3).buttons), ['Alt+R', 'Alt+K', 'Alt+P']);
    assert.deepEqual(keys(layoutCommandBar(screen, [], 1).buttons), ['Alt+R']);
    assert.deepEqual(keys(layoutCommandBar(screen, [], 1).more), ['Alt+E', 'Alt+P', 'Alt+K']);
  });

  test('hidden actions never count (not even in More); disabled ones only when nothing enabled is left', () => {
    const screen = [a('Alt+A', 'Alter', { disabled: true }), a('Alt+P', 'Print', { hidden: true }), a('Alt+W', 'Share'), a('Alt+E', 'Export'), a('Ctrl+I', 'More details', { hidden: true })];
    const l = layoutCommandBar(screen, [], 2);
    assert.deepEqual(keys(l.buttons), ['Alt+W', 'Alt+E']);
    assert.deepEqual(keys(l.more), ['Alt+A']);
    const wide = layoutCommandBar(screen, [], 3);
    assert.deepEqual(keys(wide.buttons), ['Alt+A', 'Alt+W', 'Alt+E']); // shown in rule order
    assert.deepEqual(keys(wide.more), []);
  });

  test('a hidden primary is no primary; at most one primary', () => {
    assert.equal(layoutCommandBar([a('Ctrl+A', 'Accept', { primary: true, hidden: true })], [], 3).primary, null);
    const l = layoutCommandBar([a('Ctrl+A', 'Accept', { primary: true }), a('Alt+S', 'Save as', { primary: true })], [], 3);
    assert.equal(l.primary?.key, 'Ctrl+A');
    assert.deepEqual(keys(l.more), ['Alt+S']);
  });

  test('globals go to More, after the screen actions, unless a screen action already uses the key', () => {
    const screen = [a('F12', 'Configure this report'), a('Alt+F1', 'Detailed')];
    const l = layoutCommandBar(screen, GLOBALS, 3);
    assert.deepEqual(keys(l.more), ['F12', 'Alt+F1', 'F11', 'F1']);
    assert.equal(l.more[0].label, 'Configure this report');
    assert.deepEqual(keys(layoutCommandBar([], [...GLOBALS, a('F2', 'Date', { hidden: true })], 3).more), ['F11', 'F12', 'F1']);
  });

  test('keys compare without case or spaces; nothing appears twice', () => {
    const screen = [a('alt+p', 'Print'), a('Alt + E', 'Export'), a('Ctrl+P', 'Print highlighted')];
    const l = layoutCommandBar(screen, [], 3);
    assert.deepEqual(keys(l.buttons), ['alt+p', 'Alt + E']);
    const all = [...(l.primary ? [l.primary] : []), ...l.buttons, ...l.more];
    assert.equal(new Set(all).size, all.length);
    assert.equal(all.length, 3);
  });
});

/**
 * keyConventions.test.ts finds screen actions with `key: …, label: …, <icon|onClick|primary|…>` — a new
 * field written straight after `label` (e.g. `prominent`) would hide an action from it. SPEC §12.4: new
 * fields go after `onClick`. This guard fails if that scan suddenly finds far fewer actions.
 */
describe('convention scan guard', () => {
  test('the key-convention scan still matches at least 600 actions, and no action puts `prominent` straight after `label`', () => {
    const modulesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../modules');
    let matched = 0;
    const misplaced: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts')) {
          const text = fs.readFileSync(p, 'utf8');
          matched += [...text.matchAll(/key:\s*(?:'([^']+)'|([A-Z_]+))\s*,\s*label:\s*([^\n]+?),\s*(?:icon|onClick|primary|disabled|hidden|group|hint)\b/g)].length;
          for (const m of text.matchAll(/key:\s*'[^']+'\s*,\s*label:\s*[^\n]+?,\s*prominent\b/g)) misplaced.push(`${path.relative(modulesDir, p)}: ${m[0]}`);
        }
      }
    };
    walk(modulesDir);
    assert.ok(matched >= 600, `the convention scan matches only ${matched} actions`);
    assert.deepEqual(misplaced, []);
  });
});
