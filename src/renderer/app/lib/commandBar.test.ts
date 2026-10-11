import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { actionsSignature, COMMAND_BAR_BREAKPOINTS, commandBarSlots, hotkeyActions, isConvention, isKeyless, layoutCommandBar } from './commandBar.ts';
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

/** 2.1 additions (SPEC-21 §3.1 rules 2b and 4, WP-B1): the command bar lives in the title row. */
describe('command bar selection (2.1)', () => {
  test('slots come from the title-row width with the 2.0 thresholds', () => {
    assert.deepEqual(COMMAND_BAR_BREAKPOINTS, { wide: 900, medium: 640 });
    // A 1366 px window: the title row is 1366 − 2 × 24 px wide → 3; a form column of 960 px → 3; 1024 px narrow → 3.
    assert.equal(commandBarSlots(1366 - 48), 3);
    assert.equal(commandBarSlots(960 - 48), 3);
    assert.equal(commandBarSlots(640 - 48), 1);
  });

  test('conventions match key AND verb: "Payables Alt+W", "Compare Alt+C", "Tick all Alt+A" take no convention slot', () => {
    assert.ok(isConvention(a('Alt+A', 'Alter voucher'), 'Alt+A'));
    assert.ok(isConvention(a('alt + p', 'Print rows'), 'Alt+P'));
    assert.ok(isConvention(a('Alt+P', 'Reprint last bill'), 'Alt+P'));
    assert.ok(isConvention(a('Alt+E', 'Save as PDF'), 'Alt+E'));
    assert.ok(isConvention(a('Alt+E', 'Save preview as PDF'), 'Alt+E'));
    assert.ok(isConvention(a('Ctrl+I', 'More details'), 'Ctrl+I'));
    assert.ok(isConvention(a('Alt+C', 'Create ledger'), 'Alt+C'));
    assert.ok(isConvention(a('Alt+W', 'Share (e-mail / WhatsApp)'), 'Alt+W'));
    assert.equal(isConvention(a('Alt+W', 'Payables'), 'Alt+W'), false);
    assert.equal(isConvention(a('Alt+C', 'Compare last year'), 'Alt+C'), false);
    assert.equal(isConvention(a('Alt+A', 'Tick all'), 'Alt+A'), false);
    assert.equal(isConvention(a('Alt+P', 'Print'), 'Alt+E'), false, 'the key must match too');

    const screen = [a('Alt+W', 'Payables'), a('Alt+C', 'Compare last year'), a('Alt+P', 'Print'), a('Alt+E', 'Export')];
    const l = layoutCommandBar(screen, [], 3);
    assert.deepEqual(keys(l.buttons), ['Alt+P', 'Alt+E']);
    assert.deepEqual(keys(l.more), ['Alt+W', 'Alt+C']);
    // `prominent` still makes any action a button.
    assert.deepEqual(keys(layoutCommandBar([a('Alt+W', 'Payables', { prominent: true }), a('Alt+P', 'Print')], [], 3).buttons), ['Alt+W', 'Alt+P']);
  });

  test('`demoted` sends an action to More whatever prominent, primary or a convention say — its key stays in the layout', () => {
    const screen = [
      a('Ctrl+A', 'Save', { primary: true }),
      a('Alt+P', 'Print', { demoted: true }),
      a('Alt+E', 'Export', { demoted: true, prominent: true }),
      a('Ctrl+I', 'More details', { demoted: true }),
      a('Alt+H', 'Edit history'),
    ];
    const l = layoutCommandBar(screen, GLOBALS, 3);
    assert.equal(l.primary?.key, 'Ctrl+A');
    assert.deepEqual(keys(l.buttons), []);
    assert.deepEqual(keys(l.more), ['Alt+P', 'Alt+E', 'Ctrl+I', 'Alt+H', 'F11', 'F12', 'F1']);
    assert.equal(layoutCommandBar([a('Ctrl+A', 'Accept', { primary: true, demoted: true })], [], 3).primary, null, 'a demoted primary is no filled button');
    // A demoted action still owns its key: the global with the same key is not listed twice.
    assert.deepEqual(keys(layoutCommandBar([a('F12', 'Configure this report', { demoted: true })], GLOBALS, 3).more), ['F12', 'F11', 'F1']);
  });

  test('NO_KEY items are never promoted, never block a global, and keep their place in More', () => {
    assert.ok(isKeyless(a('', 'About this report')));
    assert.ok(isKeyless(a(' ', 'Columns…')));
    assert.equal(isKeyless(a('Alt+P', 'Print')), false);
    const screen = [
      a('', 'About this report', { prominent: true }),
      a('', 'Only parties over their credit limit', { checked: false, primary: true }),
      a('Alt+P', 'Print'),
      a('', 'Show empty tables', { checked: true }),
    ];
    const l = layoutCommandBar(screen, GLOBALS, 3);
    assert.equal(l.primary, null);
    assert.deepEqual(keys(l.buttons), ['Alt+P']);
    assert.deepEqual(
      l.more.map((x) => x.label),
      ['About this report', 'Only parties over their credit limit', 'Show empty tables', 'Features', 'Configure', 'Help'],
    );
    assert.deepEqual(
      l.more.filter((x) => x.checked !== undefined).map((x) => [x.label, x.checked]),
      [
        ['Only parties over their credit limit', false],
        ['Show empty tables', true],
      ],
      'checkable items keep their state for the menu',
    );
    assert.deepEqual(keys(layoutCommandBar([a('', 'Whole period')], [a('', 'Keyless global')], 3).more), ['', ''], 'a keyless global is not "taken" by a keyless item');
  });

  test('useScreenActions registers the keys of visible, enabled actions — never a NO_KEY item, always a demoted one', () => {
    const items = [
      a('Alt+P', 'Print', { demoted: true }),
      a('', 'About this report'),
      a(' ', 'Columns…'),
      a('Alt+E', 'Export', { disabled: true }),
      a('Alt+D', 'Delete', { hidden: true }),
      a('Alt+H', 'Edit history'),
      a('Ctrl+A', 'Save', { primary: true }),
    ];
    assert.deepEqual(keys(hotkeyActions(items)), ['Alt+P', 'Alt+H', 'Ctrl+A']);
  });

  test('the bars republish when prominent, demoted or checked change — not when only a handler does', () => {
    const base = [a('Alt+P', 'Print'), a('', 'Show empty tables', { checked: false })];
    const sig = actionsSignature(base);
    assert.equal(actionsSignature([{ ...base[0], onClick: () => undefined } as CommandBarAction, base[1]]), sig);
    assert.notEqual(actionsSignature([a('Alt+P', 'Print', { prominent: true }), base[1]]), sig);
    assert.notEqual(actionsSignature([a('Alt+P', 'Print', { demoted: true }), base[1]]), sig);
    assert.notEqual(actionsSignature([base[0], a('', 'Show empty tables', { checked: true })]), sig);
    assert.notEqual(actionsSignature([base[0], a('', 'Show empty tables')]), sig, 'checkable → plain item');
    assert.notEqual(actionsSignature([{ ...a('Alt+P', 'Print'), hint: 'Needs the Export permission' }, base[1]]), sig);
  });
});

/**
 * keyConventions.test.ts finds screen actions with `key: …, label: …, <icon|onClick|primary|…>` — a new
 * field written straight after `label` (e.g. `prominent`) would hide an action from it. docs/ARCHITECTURE.md §7: new
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
