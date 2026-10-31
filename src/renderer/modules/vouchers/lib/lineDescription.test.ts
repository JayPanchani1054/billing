/**
 * 2.2 line descriptions: the one rule (when the field shows / is an Enter stop), the Enter chain per mode, the
 * opened set, the close that waits for a press to end, and — read from source, like entryCalm.test.ts, because
 * the entry screen and its grids are TSX — the wiring the pure rule cannot prove: the field under the item /
 * ledger name, the one Ctrl+E action (also from More ▾: the line the cursor was last on), the row tool, the reset
 * for the next voucher, the old "Line narration" column gone, the stock journal's narrow tools column, the Alt+T
 * list naming a line by its description and the voucher type flag's former name.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cellId, parseCellId } from './errorPaths.ts';
import { blankItem, formReducer, newForm } from './formState.ts';
import { nextCell, verticalCell } from './gridNav.ts';
import type { GridModel } from './gridNav.ts';
import { afterPointerRelease, DESC_COLUMN, DESC_MAX_LENGTH, descriptionShown, navColumnsWithDescription, NO_OPENED, openedAfterLeaving, openedWith, PRESS_END_EVENTS, skipHiddenDescription } from './lineDescription.ts';
import type { DescribedLine, DescriptionRule } from './lineDescription.ts';

const rule = (o: Partial<DescriptionRule> = {}): DescriptionRule => ({ everyLine: false, opened: NO_OPENED, ...o });
const filled = (text = ''): DescribedLine => ({ filled: true, text });

describe('when a line shows its description', () => {
  it('a filled line: with text, when opened, or when the voucher type wants one on every line', () => {
    assert.equal(descriptionShown(rule(), 'i1', filled()), false, 'hidden by default');
    assert.equal(descriptionShown(rule(), 'i1', filled('Serial 4471')), true);
    assert.equal(descriptionShown(rule(), 'i1', filled(' \n ')), false, 'blank text is no description');
    assert.equal(descriptionShown(rule({ opened: new Set(['i1']) }), 'i1', filled()), true);
    assert.equal(descriptionShown(rule({ opened: new Set(['i2']) }), 'i1', filled()), false, 'opening is per line');
    assert.equal(descriptionShown(rule({ everyLine: true }), 'i1', filled()), true);
  });

  it('never on an empty line (no item / ledger chosen), whatever the reason', () => {
    const blank: DescribedLine = { filled: false, text: 'left over' };
    assert.equal(descriptionShown(rule({ everyLine: true, opened: new Set(['i1']) }), 'i1', blank), false);
  });

  it('the opened set: added once, closed again when left empty, kept with text — the same set when nothing changes', () => {
    const one = openedWith(NO_OPENED, 'l2');
    assert.deepEqual([...one], ['l2']);
    assert.equal(openedWith(one, 'l2'), one, 'no new set, so no re-render');
    assert.deepEqual([...NO_OPENED], [], 'never mutated');
    assert.equal(openedAfterLeaving(one, 'l2', 'Door delivery'), one, 'text keeps it on screen anyway');
    assert.deepEqual([...openedAfterLeaving(one, 'l2', '  ')], []);
    assert.equal(openedAfterLeaving(one, 'i9', ''), one, 'a line that was not opened');
  });

  it('the next voucher reuses the row keys (i1, l2 …): the screen must drop the opened set with it', () => {
    let f = newForm({ voucherTypeId: 5, baseType: 'sales', mode: 'item_invoice', date: '2026-10-05' });
    const first = f.items[0].key;
    f = formReducer(f, { type: 'item', key: first, patch: { itemId: 3, qty: 1, rate: 10 } });
    const next = formReducer(f, { type: 'next', date: '2026-10-05' });
    assert.equal(next.items[0].key, first, 'same key, another voucher');
    assert.equal(next.items[0].description, '');
  });

  it('the description is a cell of its own: letters-only column id, read back by parseCellId; 1000 characters', () => {
    assert.equal(DESC_COLUMN, 'desc');
    assert.deepEqual(parseCellId(cellId('ledgers', 'l12', DESC_COLUMN)), { section: 'ledgers', rowKey: 'l12', column: 'desc' });
    assert.equal(DESC_MAX_LENGTH, 1000);
    assert.equal(blankItem('i1').description, '', 'a new line starts without one');
  });
});

describe('the Enter chain with descriptions', () => {
  it('columns: under the name for items and invoice ledgers; last (after the amount) in a ledger-mode voucher', () => {
    assert.deepEqual(navColumnsWithDescription(['item', 'godown', 'batch', 'qty', 'rate', 'disc', 'amount'], 'items', 'item_invoice'), ['item', 'desc', 'godown', 'batch', 'qty', 'rate', 'disc', 'amount']);
    assert.deepEqual(navColumnsWithDescription(['item', 'qty'], 'items', 'inventory'), ['item', 'desc', 'qty']);
    assert.deepEqual(navColumnsWithDescription(['ledger', 'amount'], 'ledgers', 'item_invoice'), ['ledger', 'desc', 'amount'], 'Charges & discounts');
    assert.deepEqual(navColumnsWithDescription(['ledger', 'amount'], 'ledgers', 'accounting_invoice'), ['ledger', 'desc', 'amount']);
    assert.deepEqual(navColumnsWithDescription(['ledger', 'amount'], 'ledgers', 'ledger'), ['ledger', 'amount', 'desc'], 'where the Line narration column was');
    assert.deepEqual(navColumnsWithDescription(['ledger', 'desc', 'amount'], 'ledgers', 'ledger'), ['ledger', 'amount', 'desc'], 'never twice');
  });

  /** An item grid as the screen builds it: i1 Rice (no batches), i2 Soap (batches), i3 empty. */
  function itemGrid(r: DescriptionRule, texts: Readonly<Record<string, string>> = {}, filledKey?: string): GridModel {
    const isFilled = (k: string) => k === filledKey || k === 'i1' || k === 'i2';
    return {
      columns: navColumnsWithDescription(['item', 'batch', 'qty', 'rate', 'amount'], 'items', 'item_invoice'),
      rowKeys: ['i1', 'i2', 'i3'],
      isBlank: (k) => !isFilled(k),
      skip: skipHiddenDescription(r, (k) => ({ filled: isFilled(k), text: texts[k] ?? '' }), (k, c) => c === 'batch' && k !== 'i2'),
    };
  }

  it('items, descriptions hidden: item → quantity exactly as before 2.2 (the first-day and invoice-flow chains)', () => {
    const m = itemGrid(rule());
    assert.deepEqual(nextCell(m, { rowKey: 'i1', column: 'item' }, 'forward'), { kind: 'cell', rowKey: 'i1', column: 'qty' });
    assert.deepEqual(nextCell(m, { rowKey: 'i2', column: 'item' }, 'forward'), { kind: 'cell', rowKey: 'i2', column: 'batch' }, 'the batch skip is kept');
    assert.deepEqual(nextCell(m, { rowKey: 'i1', column: 'qty' }, 'back'), { kind: 'cell', rowKey: 'i1', column: 'item' });
    assert.deepEqual(nextCell(m, { rowKey: 'i3', column: 'item' }, 'forward'), { kind: 'exit-forward' }, 'an empty line still leaves the grid');
  });

  it('items, a description shown: item → description → batch / quantity, and Shift+Enter back through it', () => {
    const m = itemGrid(rule({ opened: new Set(['i2']) }), { i1: 'Basmati, 25 kg' });
    assert.deepEqual(nextCell(m, { rowKey: 'i1', column: 'item' }, 'forward'), { kind: 'cell', rowKey: 'i1', column: 'desc' });
    assert.deepEqual(nextCell(m, { rowKey: 'i1', column: 'desc' }, 'forward'), { kind: 'cell', rowKey: 'i1', column: 'qty' });
    assert.deepEqual(nextCell(m, { rowKey: 'i2', column: 'desc' }, 'forward'), { kind: 'cell', rowKey: 'i2', column: 'batch' });
    assert.deepEqual(nextCell(m, { rowKey: 'i1', column: 'qty' }, 'back'), { kind: 'cell', rowKey: 'i1', column: 'desc' });
    assert.deepEqual(nextCell(m, { rowKey: 'i1', column: 'desc' }, 'back'), { kind: 'cell', rowKey: 'i1', column: 'item' });
    // ↑ / ↓ keep the column (outside a description, which keeps them for its caret).
    assert.deepEqual(verticalCell(m, { rowKey: 'i1', column: 'qty' }, 'down'), { kind: 'cell', rowKey: 'i2', column: 'qty' });
  });

  it('every line (the voucher type flag): a line just filled by the picker goes on to its description', () => {
    const m = itemGrid(rule({ everyLine: true }), {}, 'i3');
    assert.deepEqual(nextCell(m, { rowKey: 'i3', column: 'item' }, 'forward'), { kind: 'cell', rowKey: 'i3', column: 'desc' });
  });

  /** A ledger grid: l1 and l2 filled, l3 empty. */
  function ledgerGrid(mode: 'item_invoice' | 'accounting_invoice' | 'ledger', r: DescriptionRule, texts: Readonly<Record<string, string>> = {}): GridModel {
    const isFilled = (k: string) => k !== 'l3';
    return {
      columns: navColumnsWithDescription(['ledger', 'amount'], 'ledgers', mode),
      rowKeys: ['l1', 'l2', 'l3'],
      isBlank: (k) => !isFilled(k),
      skip: skipHiddenDescription(r, (k) => ({ filled: isFilled(k), text: texts[k] ?? '' })),
    };
  }

  it('an invoice ledger line: ledger → description → amount; hidden: ledger → amount', () => {
    const shown = ledgerGrid('accounting_invoice', rule({ everyLine: true }));
    assert.deepEqual(nextCell(shown, { rowKey: 'l1', column: 'ledger' }, 'forward'), { kind: 'cell', rowKey: 'l1', column: 'desc' });
    assert.deepEqual(nextCell(shown, { rowKey: 'l1', column: 'desc' }, 'forward'), { kind: 'cell', rowKey: 'l1', column: 'amount' });
    const hidden = ledgerGrid('item_invoice', rule());
    assert.deepEqual(nextCell(hidden, { rowKey: 'l1', column: 'ledger' }, 'forward'), { kind: 'cell', rowKey: 'l1', column: 'amount' });
  });

  it('a ledger-mode line: ledger → amount → description → next line; hidden: amount → next line (the forex / bill-wise stops continue from the amount)', () => {
    const shown = ledgerGrid('ledger', rule(), { l1: 'October rent' });
    assert.deepEqual(nextCell(shown, { rowKey: 'l1', column: 'ledger' }, 'forward'), { kind: 'cell', rowKey: 'l1', column: 'amount' });
    assert.deepEqual(nextCell(shown, { rowKey: 'l1', column: 'amount' }, 'forward'), { kind: 'cell', rowKey: 'l1', column: 'desc' });
    assert.deepEqual(nextCell(shown, { rowKey: 'l1', column: 'desc' }, 'forward'), { kind: 'cell', rowKey: 'l2', column: 'ledger' });
    assert.deepEqual(nextCell(shown, { rowKey: 'l2', column: 'ledger' }, 'back'), { kind: 'cell', rowKey: 'l1', column: 'desc' }, 'Shift+Enter lands on the last stop of the line above');
    assert.deepEqual(nextCell(shown, { rowKey: 'l2', column: 'amount' }, 'forward'), { kind: 'cell', rowKey: 'l3', column: 'ledger' }, 'l2 has none');
    assert.deepEqual(nextCell(shown, { rowKey: 'l3', column: 'ledger' }, 'forward'), { kind: 'exit-forward' });
  });
});

describe('an empty description left for a pressed control closes once the press is over (afterPointerRelease)', () => {
  it('it waits for the pointer to go up, then one more turn (the click of that release comes first); once', () => {
    const doc = new EventTarget();
    const ran: string[] = [];
    const later: Array<() => void> = [];
    afterPointerRelease(doc, () => ran.push('closed'), (run) => later.push(run));
    for (const type of ['pointerdown', 'mousedown', 'pointermove', 'focusin']) doc.dispatchEvent(new Event(type));
    assert.equal(later.length, 0, 'still pressed: the field stays, so what was pressed stays under the pointer');
    doc.dispatchEvent(new Event('pointerup'));
    assert.deepEqual(ran, [], 'not during the release');
    assert.equal(later.length, 1);
    later[0]();
    assert.deepEqual(ran, ['closed']);
    for (const type of PRESS_END_EVENTS) doc.dispatchEvent(new Event(type));
    assert.equal(later.length, 1, 'every listener is gone (one-shot, removed with the capture flag they were added with)');
  });

  it('a cancelled pointer ends the press too, and so does the click of a tap (its pointer went up before the cursor moved)', () => {
    assert.deepEqual([...PRESS_END_EVENTS], ['pointerup', 'pointercancel', 'click']);
    for (const type of PRESS_END_EVENTS) {
      const doc = new EventTarget();
      let closed = 0;
      afterPointerRelease(doc, () => closed++, (run) => run());
      doc.dispatchEvent(new Event(type));
      for (const again of PRESS_END_EVENTS) doc.dispatchEvent(new Event(again));
      assert.equal(closed, 1, type);
    }
  });

  it('by default it runs on a timeout of 0 after the release', async () => {
    const doc = new EventTarget();
    let closed = 0;
    afterPointerRelease(doc, () => closed++);
    doc.dispatchEvent(new Event('pointerup'));
    assert.equal(closed, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(closed, 1);
  });
});

// ─────────────── Wiring, read from source ───────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.resolve(here, '..', rel), 'utf8');
const screen = read('entry/VoucherEntryScreen.tsx');
const grids = read('entry/grids.tsx');
const css = read('vouchers-entry.css');
const modulesDir = path.resolve(here, '../..');

/** `key: 'X', label: …` actions (one line or spread over lines) and `'X': () =>` hotkey maps using `key`. */
function uses(text: string, key: string): string[] {
  const k = key.replace(/\+/g, '\\+');
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(`key:\\s*'${k}'\\s*,\\s*label:\\s*([^\\n,]+)`, 'g'))) out.push(m[1].trim());
  for (const m of text.matchAll(new RegExp(`'(?:[^']*, )?${k}(?:, [^']*)?'\\s*:\\s*(?:\\(|[a-z])`, 'g'))) out.push(`(hotkey) ${m[0]}`);
  return out;
}

function sources(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts')) out.push({ file: path.relative(modulesDir, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') });
  }
  return out;
}

/** The `case 'x':` branch of a row's cell switch, up to the next `case` / `default`. */
function cellCase(src: string, component: string, column: string): string {
  const from = src.indexOf(`const ${component} = memo(`);
  assert.ok(from >= 0, component);
  const start = src.indexOf(`case '${column}':`, from);
  assert.ok(start > from, `${component} › case '${column}'`);
  const end = src.slice(start + 1).search(/\n\s+(case '|default:)/);
  return src.slice(start, start + 1 + end);
}

describe('voucher entry wiring (2.2)', () => {
  it('the field sits inside the name cell (.bx-vch-cell-item) of item and ledger lines, with the agreed attributes', () => {
    for (const [component, column, value] of [
      ['ItemRowView', 'item', 'row.description'],
      ['LedgerRowView', 'ledger', 'row.narration'],
    ] as const) {
      const branch = cellCase(grids, component, column);
      assert.match(branch, /<div className="bx-vch-cell-item">/, `${component}: the name cell is a column of name and description`);
      assert.match(branch, new RegExp(`\\{descShown \\? <LineDescription section="${column === 'item' ? 'items' : 'ledgers'}" rowKey=\\{k\\} index=\\{index\\} value=\\{${value.replace('.', '\\.')}\\}`), component);
      assert.ok(branch.indexOf('<LineDescription') < branch.lastIndexOf('</div>'), `${component}: inside the cell`);
    }
    const field = grids.slice(grids.indexOf('function LineDescription('), grids.indexOf('function DescriptionTool('));
    for (const attr of ['id={id}', 'className="bx-vch-desc"', 'aria-label={`Description, line ${index + 1}`}', 'rows={1}', 'autoGrow', 'maxRows={4}', 'maxLength={DESC_MAX_LENGTH}', 'placeholder="Description"', 'aria-describedby={error ? errId(id) : undefined}']) {
      assert.ok(field.includes(attr), attr);
    }
    assert.match(field, /<TextArea\b/);
    assert.match(field, /className="bx-vch-cell-error"/, 'its own error text');
    assert.match(field, /onBlur=\{\(e\) => \{[\s\S]*env\.onDescriptionBlur\(rowKey, e\.currentTarget\.value\)/, 'leaving it empty closes it');
  });

  it('the row tool opens a hidden description, on filled lines only; Remove stays last', () => {
    const tool = grids.slice(grids.indexOf('function DescriptionTool('));
    assert.match(tool, /<IconButton icon="text" size="sm" variant="ghost" tabIndex=\{-1\} aria-label=\{`Description, line \$\{index \+ 1\}`\} tooltip="Description \(Ctrl\+E\)" onClick=\{\(\) => env\.openDescription\(section, rowKey\)\} \/>/);
    for (const section of ['items', 'ledgers']) {
      const use = `{descShown ? null : <DescriptionTool section="${section}" rowKey={k} index={index} />}`;
      const at = grids.indexOf(use);
      assert.ok(at > 0, section);
      assert.ok(grids.indexOf(`env.deleteRow('${section}', k)`, at) > at, `${section}: Remove comes after it`);
      assert.ok(grids.lastIndexOf('{blank ? null : (', at) > grids.lastIndexOf('<td className="bx-vch-table__act">', at), `${section}: not on an empty line`);
    }
    assert.match(css, /\.bx-vch-table__act \{\s*width: 136px;/, 'five small tools fit: 5 × 24 + 4 × 2 + 8');
  });

  it('the opened lines live on the screen (state + ref), not in the form nor in GridEnvContext', () => {
    assert.match(screen, /const \[descOpen, setDescOpenState\] = useState<ReadonlySet<string>>\(NO_OPENED\);/);
    assert.match(screen, /const descOpenRef = useRef\(descOpen\);/);
    const env = grids.slice(grids.indexOf('export interface GridEnv {'), grids.indexOf('export const GridEnvContext'));
    assert.doesNotMatch(env, /ReadonlySet|descOpen|everyLine/, 'the context only carries stable callbacks');
    assert.doesNotMatch(read('lib/formState.ts'), /descOpen|NO_OPENED|openedWith|lineDescription/, 'never in VoucherForm: no "touched", never sent');
    // The grids pass one boolean per row to the memoised rows.
    assert.equal(grids.match(/descShown=\{descriptionShown\(\{ everyLine, opened: descOpen \}, r\.key, /g)?.length, 2);
    assert.equal(screen.match(/descOpen=\{descOpen\}\s+everyLine=\{everyLine\}/g)?.length, 4, 'the item grid (or both stock-journal grids) and the ledger grid');
  });

  it('the next voucher after a save starts with no line opened and no last line (its row keys start again)', () => {
    assert.match(screen, /setDescOpen\(NO_OPENED\);\s*lastLineRef\.current = null;\s*dispatch\(\{ type: 'next',/);
  });

  it('Ctrl+E from More ▾ or the shortcut bar (the focus is on the menu / button) describes the line the cursor was last on', () => {
    // Focus events of the whole voucher column bubble to one handler: a cell or a row tool sets the line …
    assert.match(screen, /<div className="bx-vch__main" onFocus=\{onMainFocus\}>/);
    assert.match(screen, /const lastLineRef = useRef<\{ section: Section; rowKey: string \} \| null>\(null\);/);
    const onFocus = screen.slice(screen.indexOf('const onMainFocus = ('), screen.indexOf('const deleteRow = useCallback('));
    assert.match(onFocus, /const line = lineOfElement\(t\);\s*if \(line\) lastLineRef\.current = line;/);
    // … the header and the narration clear it (Ctrl+E there says "Move to a line first").
    assert.match(onFocus, /else if \(t\.id === headerId\('narration'\) \|\| headerRef\.current\?\.contains\(t\)\) lastLineRef\.current = null;/);
    // Row tools have no cell id: their row names the line (lib/errorPaths.ts › lineOfElement).
    assert.equal(grids.match(/<tr className=\{blank \? 'bx-vch-row is-blank' : 'bx-vch-row'\} data-row=\{k\} data-section="items">/g)?.length, 1);
    assert.equal(grids.match(/<tr className=\{blank \? 'bx-vch-row is-blank' : 'bx-vch-row'\} data-row=\{k\} data-section="ledgers">/g)?.length, 1);
    const describeLine = screen.slice(screen.indexOf('const describeLine = () => {'), screen.indexOf('// ── Hotkeys not shown in the rail ──'));
    assert.match(describeLine, /const c = activeCell\(\) \?\? lastLineRef\.current;/);
    // Already on screen: the cursor goes in at once (the deferred close of an empty one then sees it back), and
    // again next frame (More ▾ gives the focus back to its button after the item ran).
    assert.match(describeLine, /const id = cellId\(c\.section, c\.rowKey, DESC_COLUMN\);\s*document\.getElementById\(id\)\?\.focus\(\);\s*focusId\(id\);/);
  });

  it('an empty description left for a pressed control (a button or label below it) closes after the press — the click lands; keys close it at once', () => {
    const field = grids.slice(grids.indexOf('function LineDescription('), grids.indexOf('function DescriptionTool('));
    const blur = field.slice(field.indexOf('onBlur={(e) => {'));
    const pressed = blur.indexOf("if ((to instanceof Element ? to : document.documentElement).matches(':active')) {");
    assert.ok(pressed > 0, 'a press under way: the control that took the cursor (or, with none, the page) is :active');
    assert.ok(pressed > blur.indexOf(`closest('[role="dialog"], [role="alertdialog"]')`) && pressed > blur.indexOf('if (!document.hasFocus()) return;'), 'after the dialog and window rules');
    assert.match(
      blur.slice(pressed),
      /^[^\n]*\n\s*const field = e\.currentTarget;\s*afterPointerRelease\(document, \(\) => \{\s*if \(document\.activeElement !== field\) env\.onDescriptionBlur\(rowKey, field\.value\);\s*\}\);\s*return;\s*\}\s*env\.onDescriptionBlur\(rowKey, e\.currentTarget\.value\);/,
      'deferred, and skipped when the cursor is back; otherwise (Enter, Tab, focusId) at once',
    );
  });

  it('the Enter chain uses the same rule; ↑ / ↓ are left to the caret inside a description', () => {
    const model = screen.slice(screen.indexOf('const modelOf = ('), screen.indexOf('const focusHeaderLast'));
    assert.equal(model.match(/navColumnsWithDescription\(/g)?.length, 2, 'items and ledgers');
    assert.equal(model.match(/skipHiddenDescription\(/g)?.length, 2);
    assert.match(model, /opened: descOpenRef\.current/, 'the key handlers read the ref (updated at once)');
    assert.match(model, /c !== 'batch'/, 'the batch skip is kept');
    const keys = screen.slice(screen.indexOf('const onGridKeyDown = ('), screen.indexOf('const activeCell = ()'));
    assert.match(keys, /const multiLine = t\.tagName === 'TEXTAREA';/);
    assert.match(keys, /\(e\.key === 'ArrowDown' \|\| e\.key === 'ArrowUp'\)[^\n]*&& !multiLine\)/);
  });

  it('Ctrl+E is one action — "Line description", under More (not primary, not prominent, no hotkey map entry); one primary stays', () => {
    assert.deepEqual(uses(screen, 'Ctrl+E'), ["'Line description'"]);
    assert.match(screen, /\{ key: 'Ctrl\+E', label: 'Line description', icon: 'text', onClick: describeLine, group: 'details' \},/);
    assert.equal(screen.match(/primary: true/g)?.length, 1, 'one primary action');
    const hotkeys = screen.slice(screen.indexOf('const hotkeys = {'), screen.indexOf('// ── Rail actions ──'));
    assert.doesNotMatch(hotkeys, /Ctrl\+E/);
    const describe = screen.slice(screen.indexOf('const describeLine = () => {'), screen.indexOf('// ── Hotkeys not shown in the rail ──'));
    assert.match(describe, /toast\.info\('Move to a line first', \{ message: 'Ctrl\+E adds a description under the item or ledger the cursor is on\.' \}\)/);
    assert.match(describe, /openDescription\(c\.section, c\.rowKey\)/);
    assert.match(screen, /hint="Enter Next · Shift\+Enter Back · Ctrl\+A Save · [^"]*· Ctrl\+E Description · Esc Back"/);
  });

  it('Ctrl+E means "Line description" in voucher entry only: no panel, dialog or other screen takes it, nor an Electron menu', () => {
    const files = sources(modulesDir);
    const taken = files.flatMap((f) => uses(f.text, 'Ctrl+E').map((u) => `${f.file}: ${u}`));
    assert.deepEqual(taken, ["vouchers/entry/VoucherEntryScreen.tsx: 'Line description'"]);
    // Rendered inside voucher entry or over it: the TDS / forex panels and every dialog.
    const overEntry = ['tds/EntryPanel.tsx', 'forex/EntryPanel.tsx', 'forex/ForexDialogs.tsx', 'gst/GstDetailsDialog.tsx', 'accounts/QuickPartyDialog.tsx', 'vouchers/ChangeNumberDialog.tsx', 'vouchers/entry/dialogs.tsx', 'vouchers/entry/BillsDialog.tsx', 'vouchers/entry/SavedBar.tsx', 'vouchers/entry/panels.tsx', 'vouchers/entry/grids.tsx'];
    for (const f of overEntry) {
      const text = files.find((x) => x.file === f)?.text;
      assert.ok(text !== undefined, `${f} scanned`);
      assert.doesNotMatch(text, /'(?:[^'\n]*, )?Ctrl\+E(?:, [^'\n]*)?'/, f);
    }
    const menu = fs.readFileSync(path.resolve(modulesDir, '../../main/menu.ts'), 'utf8');
    assert.doesNotMatch(menu, /(?:CmdOrCtrl|CommandOrControl|Ctrl|Control)\+E['"]/i);
  });

  it('the 2.1 "Line narration" column is gone: the description replaces it in every mode', () => {
    assert.doesNotMatch(grids, /'narr'|Line narration/);
    assert.doesNotMatch(screen, /'narr'/);
    assert.doesNotMatch(css, /bx-vch-col--lnarr/);
    assert.match(grids, /export type LedgerColumn = 'ledger' \| 'gst' \| 'hsn' \| 'amount';/);
  });

  it("the stock journal's side-by-side item grids keep a narrow tools column: an item line has at most Description and Remove", () => {
    assert.match(css, /\.bx-vch-sj \.bx-vch-table__act \{\s*width: 64px;\s*\}/, '2 × 24 + 2 + 8 = 58 px fit');
    assert.match(css, /\.bx-vch-table__act \{\s*width: 136px;/, 'elsewhere five tools still fit');
    const itemRow = grids.slice(grids.indexOf('const ItemRowView = memo('), grids.indexOf('// ───────────────────────────── Ledger grid'));
    const at = itemRow.indexOf('<span className="bx-vch-rowtools">');
    const tools = itemRow.slice(at, itemRow.indexOf('</span>', at));
    assert.equal(tools.match(/<DescriptionTool |<IconButton /g)?.length, 2, 'the tools of an item line: Description and Remove');
    assert.match(screen, /<div key="sj" className="bx-vch-sj">\s*<ItemGrid/, 'the stock journal draws item grids only');
  });

  it('Alt+T names each pending line with its description, so pieces of one item can be told apart (React text)', () => {
    const dialogs = read('entry/dialogs.tsx');
    const tracking = dialogs.slice(dialogs.indexOf('export function TrackingDialog('), dialogs.indexOf('// ───────────────────────────── Cancel with reason'));
    assert.match(tracking, /description=\{used \? 'Already on this voucher' : d\.lines\.map\(trackingLineText\)\.join\(' · '\)\}/);
    assert.doesNotMatch(dialogs, /dangerouslySetInnerHTML/);
  });

  it('the voucher type flag "Description on every line" gives its former name in its hint, for long-time users', () => {
    const types = fs.readFileSync(path.resolve(modulesDir, 'accounts/VoucherTypeScreens.tsx'), 'utf8');
    assert.match(types, /\{ key: 'narrationPerEntry', label: 'Description on every line', hint: 'A description under every item and ledger line as you enter \(Ctrl\+E adds one to any line\)\. Formerly "Narration for each entry"\.' \},/);
  });

  it('the field looks like the quiet inputs: no border or fill until hover / focus, one line high, no resize grip', () => {
    const base = /\.bx-textarea\.bx-vch-desc \{([^}]*)\}/.exec(css)?.[1] ?? '';
    assert.match(base, /min-height: var\(--control-h-sm\);/);
    assert.match(base, /resize: none;/);
    assert.match(css, /\.bx-textarea\.bx-vch-desc:not\(:hover, :focus, \.is-invalid\) \{\s*border-color: transparent;\s*background: none;\s*\}/);
    assert.doesNotMatch(read('vouchers-view.css'), /bx-vch-desc\b/, 'one class, one stylesheet');
  });
});
