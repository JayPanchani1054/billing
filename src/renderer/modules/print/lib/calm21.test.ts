/**
 * (2.1, SPEC-21 §1.11, §3.4, D5) The calm print screens, read from the React sources (the screens import
 * React, so their structure is checked from source like editorA11y.test.ts):
 *
 *   - every 2.0 key of Print Preview and Print Vouchers is still a screen action (none hidden, none
 *     remapped): Alt+P, Alt+E, Alt+W, PgUp/PgDn, Alt+V, Alt+L, Alt+T, Alt+S, Ctrl+1/2/3 (and Alt+A,
 *     Ctrl+A on the picker); the command bar shows Print · Save as PDF · Share · More (the real
 *     app/lib/commandBar.ts rule run on the screen's actions) — Customize layout is no longer `prominent`
 *     (Alt+L unchanged);
 *   - the printer for direct printing left the controls line for a keyless More item ("Printer: …");
 *   - the controls are one line: no printed "Ctrl+1" description, the paper select keeps "Paper size"
 *     (parity.spec), the copies keep `group "Copies to print"`;
 *   - one filled button per screen: the layout panels' buttons are not `primary` (Print / Save in the
 *     title row are the filled ones);
 *   - no icon tile beside a title, and the context run carries the ‹ › buttons (PgUp / PgDn) — kept in view
 *     and with native tooltips, since the run clips whatever leaves its box;
 *   - the layout editor's notes row never moves on a mouse press (lib/calm.ts activeNoteRow);
 *   - "Earlier changes in this session" / "Apply them" stay (print-layout.spec), as does the Rule 46
 *     warning in the panel and the "Before you print" banner.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { layoutCommandBar } from '../../../app/lib/commandBar.ts';

const printDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const code = (rel: string): string =>
  fs
    .readFileSync(path.resolve(printDir, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

/** The keys of the `{ key: 'X', label: … }` screen actions of a source. */
function actionKeys(src: string): string[] {
  return [...src.matchAll(/\{\s*key:\s*'([^']+)',\s*label:/g)].map((m) => m[1]);
}

/**
 * The screen actions of a source's first `actions={[ … ]}` list, as the command bar reads them (key, label,
 * primary, prominent, hidden, demoted). A label that is an expression is kept as its source text.
 */
function screenActions(src: string): Array<{ key: string; label: string; primary?: boolean; prominent?: boolean; hidden?: boolean; demoted?: boolean }> {
  const start = src.indexOf('actions={[');
  assert.ok(start >= 0, 'an actions list');
  const out: Array<{ key: string; label: string; primary?: boolean; prominent?: boolean; hidden?: boolean; demoted?: boolean }> = [];
  let depth = 0;
  let from = -1;
  for (let i = start + 'actions={['.length; i < src.length; i++) {
    const c = src[i];
    if (c === '{') {
      if (depth === 0) from = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        const obj = src.slice(from, i + 1);
        const key = /key: NO_KEY/.test(obj) ? '' : (/key: '([^']+)'/.exec(obj)?.[1] ?? '?');
        const label = /label: '([^']+)'/.exec(obj)?.[1] ?? /label: ([^,\n]+)/.exec(obj)?.[1] ?? '?';
        out.push({ key, label, primary: /\bprimary: true/.test(obj), prominent: /\bprominent: true/.test(obj), hidden: /\bhidden: true/.test(obj), demoted: /\bdemoted: true/.test(obj) });
      }
    } else if (c === ']' && depth === 0) break;
  }
  return out;
}

const preview = code('PrintVoucherScreen.tsx');
const batch = code('PrintBatchScreen.tsx');
const settings = code('PrintSettingsScreen.tsx');
const components = code('components.tsx');
const editor = code('LayoutEditor.tsx');

describe('Print Preview (print.voucher)', () => {
  test('every 2.0 key is still a screen action, none hidden', () => {
    const keys = actionKeys(preview);
    for (const k of ['Alt+P', 'Alt+E', 'Alt+W', 'PageUp', 'PageDown', 'Alt+V', 'Alt+L', 'Alt+T', 'Alt+S', 'Ctrl+1', 'Ctrl+2', 'Ctrl+3']) {
      assert.ok(keys.includes(k), `${k} is a screen action`);
    }
    assert.doesNotMatch(preview, /\bhidden:/, 'no action is hidden (a hidden action registers no key)');
  });

  test('the command bar: Print (filled) · Save as PDF · Share · More — Customize layout is under More', () => {
    const list = screenActions(preview);
    assert.equal(list.length, 13, 'every action parsed (12 keys and the printer item)');
    for (const [slots, buttons] of [
      [3, ['Save as PDF', 'Share']],
      [2, ['Save as PDF', 'Share']],
      [1, ['Save as PDF']],
    ] as const) {
      const bar = layoutCommandBar(list, [], slots);
      assert.equal(bar.primary?.label, 'Print', 'Print is the filled button');
      assert.deepEqual(
        bar.buttons.map((b) => b.label),
        buttons,
        `${slots} slot(s): the wireframe's order`,
      );
      const more = bar.more.map((a) => a.label);
      for (const l of ['Customize layout', 'Previous voucher', 'Next voucher', 'Open voucher', 'Change template', 'Change paper size', 'Original copy']) assert.ok(more.includes(l), `${l} is under More`);
      assert.ok(
        more.some((l) => l.startsWith('printerItemLabel(')),
        'the printer item is under More',
      );
    }
    const customize = /key: 'Alt\+L',[\s\S]*?\n\s*\},/.exec(preview)?.[0] ?? '';
    assert.match(customize, /label: 'Customize layout'/);
    assert.doesNotMatch(customize, /prominent/, 'Alt+L is a More item (its key unchanged)');
  });

  test('the printer is a keyless More item opening the printer dialog, not a select beside the paper', () => {
    assert.match(preview, /key: NO_KEY, label: printerItemLabel\(printer\.printer, printer\.printers, isRoll\(pageSize\)\), onClick: \(\) => setChoosingPrinter\(true\)/);
    assert.match(preview, /<PrinterDialog printer=\{printer\}/);
    assert.doesNotMatch(preview, /<PrintControls[^>]*printer=/);
  });

  test('the title row: no icon tile, the context run with ‹ › (PgUp / PgDn) and one coloured state word', () => {
    assert.doesNotMatch(preview, /icon="print"/);
    assert.match(preview, /subtitle=\{context\}/);
    assert.doesNotMatch(preview, /\bmeta=/, 'the state words are in the context run, not a second meta run');
    assert.match(preview, /aria-label="Previous voucher"[^\n]*aria-keyshortcuts="PageUp"[^\n]*onClick=\{\(\) => go\(prevId\)\}/);
    assert.match(preview, /aria-label="Next voucher"[^\n]*aria-keyshortcuts="PageDown"[^\n]*onClick=\{\(\) => go\(nextId\)\}/);
    assert.match(preview, /previewStateWords\(/);
  });

  test('‹ › stay usable inside the clipping context run: native tooltips, inset focus ring, never ellipsized', () => {
    for (const label of ['Previous voucher', 'Next voucher']) {
      const button = new RegExp(`<IconButton [^\\n]*aria-label="${label}"[^\\n]*/>`).exec(preview)?.[0] ?? '';
      assert.match(button, /tooltip=\{false\}/, `${label}: no tooltip box (the run's overflow: hidden would cut it off)`);
      assert.match(button, /title=\{keyTip\(/, `${label}: the key is in the native tooltip`);
      assert.match(button, /style=\{INSET_RING\}/, `${label}: the focus ring is drawn inside`);
    }
    assert.match(preview, /const INSET_RING = \{ outlineOffset: -2 \}/);
    // Only the words shrink (ellipsis); the state words and the buttons keep their size.
    assert.match(preview, /<span className="bx-truncate">\{previewContext\(doc\)\}<\/span>/);
    assert.match(preview, /const NAV_BUTTONS = \{[^}]*flexShrink: 0/);
    assert.match(preview, /const KEEP = \{[^}]*flexShrink: 0/);
    assert.match(preview, /const CONTEXT_RUN = \{[^}]*maxWidth: '100%'[^}]*minWidth: 0/);
  });

  test('the layout panel: no second filled button; "Earlier changes" and "Apply them" on one line', () => {
    assert.doesNotMatch(preview, /variant="primary"/);
    assert.match(preview, /title="Earlier changes in this session"/);
    assert.match(preview, />\s*Apply them\s*</);
    assert.match(preview, /`Save for \$\{vtName\}`/);
    assert.match(preview, /<WarningsBanner warnings=/, 'the "Before you print" banner stays above the sheet');
  });
});

describe('Print Vouchers (print.batch)', () => {
  test('every 2.0 key is still a screen action, none hidden; the printer is a keyless More item', () => {
    const keys = actionKeys(batch);
    for (const k of ['Alt+P', 'Alt+E', 'Alt+T', 'Alt+S', 'Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+A', 'Alt+A']) assert.ok(keys.includes(k), `${k} is a screen action`);
    assert.doesNotMatch(batch, /\bhidden:/);
    assert.match(batch, /key: NO_KEY, label: printerItemLabel\(/);
    assert.doesNotMatch(batch, /<PrintControls[^>]*printer=/);
    const bar = layoutCommandBar(screenActions(batch), [], 3);
    assert.equal(bar.primary?.label, 'Print all');
    assert.deepEqual(
      bar.buttons.map((b) => b.label),
      ['Save as PDF'],
    );
  });

  test('"Before you print" names each warning once, with its documents (mergeDocWarnings)', () => {
    assert.match(batch, /out\.push\(\.\.\.mergeDocWarnings\(/);
  });

  test('the period is the context run token (Alt+F2), not a second button in the title row', () => {
    assert.match(batch, /className="bx-report__token" onClick=\{openDialog\} title="Change period · Alt\+F2" aria-keyshortcuts="Alt\+F2"/);
    assert.doesNotMatch(batch, /toolbar=\{/);
    assert.doesNotMatch(batch, /icon="print"/);
  });
});

describe('Invoice Printing (print.settings)', () => {
  test('one Save (the title row, Ctrl+A): the layout panel has no Save of its own', () => {
    assert.match(settings, /key: 'Ctrl\+A', label: 'Save', icon: 'save', primary: true/);
    assert.doesNotMatch(settings, /variant="primary"/);
    assert.doesNotMatch(settings, /subtitle=/);
    assert.doesNotMatch(settings, /icon="print"/);
  });

  test('group descriptions became field hints (shown on focus), nothing lost', () => {
    assert.doesNotMatch(settings, /<FieldGroup[^>]*description=/);
    assert.match(settings, /'Printed on sales invoices so customers know how to pay\.'/);
    assert.match(settings, /Placeholders: \{document\} \{number\} \{date\} \{amount\} \{party\} \{company\} \{period\}/);
  });
});

describe('the controls line and the banner (components.tsx)', () => {
  test('Template · Paper · Copies: inline labels, "Paper size" kept, no printed key descriptions', () => {
    assert.match(components, /aria-label="Paper size"/);
    assert.match(components, /aria-label="Template"/);
    assert.match(components, /role="group" aria-label="Copies to print"/);
    assert.doesNotMatch(components, /description=\{`Ctrl\+/, 'Ctrl+1/2/3 are tooltips, not a second line under each copy');
    assert.match(components, /aria-keyshortcuts=\{`Control\+\$\{i \+ 1\}`\}/);
    const controls = /export function PrintControls[\s\S]*?\n\}\n/.exec(components)?.[0] ?? '';
    assert.doesNotMatch(controls, /aria-label="Printer"/, 'the printer is chosen from More');
  });

  test('"Before you print" keeps its title and is one line', () => {
    assert.match(components, /title = 'Before you print'/);
    assert.match(components, /const line = warningsLine\(warnings\)/);
    assert.doesNotMatch(/export function WarningsBanner[\s\S]*?\n\}\n/.exec(components)?.[0] ?? '', /<ul>/);
  });
});

describe('Customize what prints (LayoutEditor.tsx)', () => {
  test('title kept, description for screen readers, counts gone, notes on focus, locked parts on one line', () => {
    assert.match(editor, /<aside aria-label="Customize what prints" aria-describedby=\{descId\}/);
    assert.match(editor, /<Card title="Customize what prints" padding="sm">/);
    assert.doesNotMatch(editor, /subtitle=\{description\}/);
    assert.match(editor, /<p id=\{descId\} className="bx-sr-only">/);
    assert.match(editor, /\{groupCaption\(g\.label, g\.rows\)\}/);
    assert.doesNotMatch(editor, /of \$\{g\.rows\.length\} shown/);
    assert.match(editor, /className=\{notesShown \? 'bx-muted' : 'bx-muted bx-sr-only'\}/);
    assert.match(editor, /notesShown=\{readOnly \|\| noteRow === row\.id\}/);
    assert.match(editor, /aria-describedby=\{notes\.length > 0 \? noteId : undefined\}/);
    assert.match(editor, /<AlwaysPrinted rows=\{locked\} \/>/);
    assert.match(editor, /\{'Always printed: '\}/);
  });

  test('a mouse press never moves the rows: the notes row changes on keyboard focus or after the click', () => {
    assert.match(editor, /onFocusRow=\{\(\) => onNote\(\{ type: 'focus', row: row\.id, pointerDown: pointerDown\.current \}\)\}/);
    assert.match(editor, /onClickRow=\{\(\) => onNote\(\{ type: 'click', row: row\.id \}\)\}/);
    assert.match(editor, /const down = \(\): void => \{\s*pointerDown\.current = true;/);
    assert.match(editor, /root\?\.addEventListener\('pointerdown', down, true\)/);
    assert.match(editor, /window\.addEventListener\('pointerup', up, true\)/);
    assert.match(editor, /<Stack gap=\{1\} onFocus=\{onFocusRow\} onClick=\{onClickRow\}>/);
    assert.doesNotMatch(editor, /onBlur=\{\(\) => setFocused\(false\)\}/, 'no collapse on blur (it moved the pressed control)');
  });

  test('the panel keeps the Rule 46 warning (print-layout.spec:169)', () => {
    assert.match(editor, /title="Hidden details GST rules require"/);
  });
});
