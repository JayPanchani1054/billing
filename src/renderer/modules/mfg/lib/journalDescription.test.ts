/**
 * 2.2 line descriptions on the Manufacturing Journal / Material In / Out screen (mfg.journal.entry): the rule
 * (voucher entry's, imported), Ctrl+E's choice, the Enter neighbour, the BOM fill keeping the descriptions of the
 * items it still has, the description's way through the screen's model — and, read from source like
 * vouchers/lib/lineDescription.test.ts because the screen is TSX, the wiring the pure rule cannot prove: the field
 * under each item (finished goods, components, by-products / scrap, material), Enter moving on from it, the close
 * rules, the one Ctrl+E action and the last line, the row tools, the reset for the next voucher and the quiet look.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { BomDetail, MfgJournalDetail } from '../../../../shared/types/mfg.ts';
import { NO_OPENED, openedAfterLeaving, openedWith } from '../../vouchers/lib/lineDescription.ts';
import { describeAction, describedLine, descriptionId, enterNeighbour, lineDescriptionShown } from './journalDescription.ts';
import { applyBom, blankCost, blankRow, carryDescriptions, emptyForm, fromDetail, sectionsFor, toVoucherInput, withTrailingBlanks } from './journalForm.ts';
import type { JournalForm, JournalRow } from './journalForm.ts';

const BOM: BomDetail = {
  id: 7,
  guid: 'g',
  itemId: 3,
  itemName: 'Chair',
  unit: 'Nos',
  unitDecimals: 0,
  name: 'Standard',
  outputQty: 10,
  isDefault: true,
  isActive: true,
  revision: 2,
  notes: null,
  usedInVouchers: 0,
  createdAt: '',
  updatedAt: '',
  lines: [
    { lineNo: 1, kind: 'component', itemId: 1, itemName: 'Steel', unit: 'Kg', unitDecimals: 3, qty: 50, godownId: null, godownName: null, valueBasis: null, valueRate: null, valuePct: null, notes: null },
    { lineNo: 2, kind: 'component', itemId: 2, itemName: 'Paint', unit: 'Ltr', unitDecimals: 3, qty: 4, godownId: null, godownName: null, valueBasis: null, valueRate: null, valuePct: null, notes: null },
    { lineNo: 3, kind: 'scrap', itemId: 4, itemName: 'Scrap', unit: 'Kg', unitDecimals: 3, qty: 5, godownId: null, godownName: null, valueBasis: 'rate', valueRate: 20, valuePct: null, notes: null },
  ],
};

/** The patch the screen makes when a description is typed (JournalEntryScreen › setDescription → patchRow). */
const typed = (f: JournalForm, key: string, description: string): JournalForm => ({ ...f, rows: f.rows.map((r) => (r.key === key ? { ...r, description } : r)) });
const rowOf = (f: JournalForm, role: JournalRow['role'], itemId: number | null): JournalRow => {
  const r = f.rows.find((x) => x.role === role && x.itemId === itemId);
  assert.ok(r, `${role} ${itemId}`);
  return r;
};

describe('when a journal line shows its description (voucher entry rule)', () => {
  it('a line with an item: with text or when opened; never on a line without an item', () => {
    const steel = blankRow('component', { itemId: 1, itemName: 'Steel' });
    assert.deepEqual(describedLine(steel), { filled: true, text: '' });
    assert.equal(lineDescriptionShown(NO_OPENED, steel), false, 'hidden by default');
    assert.equal(lineDescriptionShown(NO_OPENED, { ...steel, description: 'Heat 42' }), true);
    assert.equal(lineDescriptionShown(NO_OPENED, { ...steel, description: ' \n ' }), false, 'blank text is no description');
    assert.equal(lineDescriptionShown(openedWith(NO_OPENED, steel.key), steel), true, 'opened (Ctrl+E, the row tool)');
    assert.equal(lineDescriptionShown(openedWith(NO_OPENED, 'r-other'), steel), false, 'opening is per line');
    const blank = { ...blankRow('component'), description: 'left over' };
    assert.equal(lineDescriptionShown(openedWith(NO_OPENED, blank.key), blank), false, 'no item, no field');
    // Every role of the journal is an item line: the finished goods, by-products / scrap, material.
    for (const role of ['product', 'by_product', 'scrap', 'transfer', 'receipt', 'issue'] as const) {
      assert.equal(lineDescriptionShown(NO_OPENED, blankRow(role, { itemId: 9, description: 'x' })), true, role);
    }
  });

  it('left empty an opened line closes again; with text it stays (the shared opened-set helpers)', () => {
    const r = blankRow('scrap', { itemId: 4 });
    const opened = openedWith(NO_OPENED, r.key);
    assert.equal(lineDescriptionShown(openedAfterLeaving(opened, r.key, ''), r), false);
    const kept = openedAfterLeaving(opened, r.key, 'Offcuts');
    assert.equal(lineDescriptionShown(kept, { ...r, description: 'Offcuts' }), true);
  });

  it("a description field's id is the line's: one per row key, an id the page can hold", () => {
    const a = blankRow('component');
    const b = blankRow('component');
    assert.notEqual(descriptionId(a.key), descriptionId(b.key));
    assert.match(descriptionId(a.key), /^mfg-desc-[A-Za-z0-9]+$/);
  });
});

describe('Ctrl+E on a journal line', () => {
  const form = withTrailingBlanks(applyBom(emptyForm('manufacturing', 5, '2026-06-10'), BOM, 20, null), sectionsFor('manufacturing', null));
  const product = rowOf(form, 'product', 3);
  const steel = rowOf(form, 'component', 1);
  const scrap = rowOf(form, 'scrap', 4);
  const blank = form.rows.find((r) => r.role === 'component' && r.itemId === null);
  assert.ok(blank);

  it('a line with an item, its description hidden: open it (then the cursor goes in)', () => {
    for (const r of [product, steel, scrap]) assert.equal(describeAction(form, NO_OPENED, r.key), 'open', r.role);
  });

  it('already on screen (text, or opened): the cursor goes in', () => {
    assert.equal(describeAction(typed(form, steel.key, 'Heat 42'), NO_OPENED, steel.key), 'focus');
    assert.equal(describeAction(form, openedWith(NO_OPENED, product.key), product.key), 'focus');
  });

  it('nowhere to put one: an empty line, an additional cost, the header / narration (no line), a line gone', () => {
    assert.equal(describeAction(form, NO_OPENED, blank.key), null);
    const cost = blankCost({ amount: 100 });
    assert.equal(describeAction({ rows: form.rows }, NO_OPENED, cost.key), null, 'additional costs have their own Description column');
    assert.equal(describeAction(form, NO_OPENED, null), null);
    assert.equal(describeAction(form, NO_OPENED, 'r-removed'), null);
  });
});

describe('Enter / Shift+Enter from a description', () => {
  it('the next / previous field of the Enter chain; nothing past either end or outside the chain', () => {
    const chain = ['item', 'desc', 'qty'];
    assert.equal(enterNeighbour(chain, 'desc', false), 'qty');
    assert.equal(enterNeighbour(chain, 'desc', true), 'item');
    assert.equal(enterNeighbour(chain, 'qty', false), null);
    assert.equal(enterNeighbour(chain, 'item', true), null);
    assert.equal(enterNeighbour(chain, 'narration', false), null, 'not in the chain: never the first field');
  });
});

describe('a BOM fill keeps the descriptions of the items it still has (Alt+B, another BOM, a new quantity)', () => {
  const NEW_BOM: BomDetail = { ...BOM, id: 8, lines: [BOM.lines[0], { ...BOM.lines[2], kind: 'by_product' }] };

  it('components and by-products / scrap of the same item keep their text; an item the BOM drops goes with it', () => {
    let f = applyBom(emptyForm('manufacturing', 5, '2026-06-10'), BOM, 20, null);
    f = typed(f, rowOf(f, 'product', 3).key, 'Order 77');
    f = typed(f, rowOf(f, 'component', 1).key, 'Heat 42');
    f = typed(f, rowOf(f, 'component', 2).key, 'Blue');
    f = typed(f, rowOf(f, 'scrap', 4).key, 'Offcuts');
    // Alt+B with another quantity: every item is still in the BOM.
    const again = applyBom(f, BOM, 30, null);
    assert.deepEqual(
      again.rows.map((r) => [r.role, r.itemId, r.qty, r.description]),
      [
        ['product', 3, 30, 'Order 77'],
        ['scrap', 4, 15, 'Offcuts'],
        ['component', 1, 150, 'Heat 42'],
        ['component', 2, 12, 'Blue'],
      ],
    );
    // Another BOM: Paint is gone (and its text); Scrap is now a by-product there — the same section, the text stays.
    const other = applyBom(f, NEW_BOM, 20, null);
    assert.deepEqual(
      other.rows.map((r) => [r.role, r.itemId, r.description]),
      [
        ['product', 3, 'Order 77'],
        ['by_product', 4, 'Offcuts'],
        ['component', 1, 'Heat 42'],
      ],
    );
  });

  it('material lines keep theirs (Material In); rebuilt lines are new lines (new keys), as before 2.2', () => {
    let f = applyBom({ ...emptyForm('material_in', 6, '2026-06-10'), rows: [blankRow('transfer', { itemId: 8, itemName: 'Die', qty: 1 })] }, BOM, 10, null);
    f = typed(f, rowOf(f, 'transfer', 8).key, 'Returned unused');
    f = typed(f, rowOf(f, 'component', 1).key, 'Heat 42');
    const again = applyBom(f, BOM, 20, null);
    assert.equal(rowOf(again, 'transfer', 8).description, 'Returned unused');
    assert.equal(rowOf(again, 'transfer', 8).key, rowOf(f, 'transfer', 8).key, 'the material line itself is kept');
    assert.equal(rowOf(again, 'component', 1).description, 'Heat 42');
    assert.notEqual(rowOf(again, 'component', 1).key, rowOf(f, 'component', 1).key);
  });

  it('several described lines of one item: in order; blank texts take no turn; a component text never goes to a by-product', () => {
    const before = [
      blankRow('component', { itemId: 1, description: '' }),
      blankRow('component', { itemId: 1, description: 'Lot A' }),
      blankRow('component', { itemId: 1, description: 'Lot B' }),
      blankRow('component', { itemId: 5, description: 'Only as a component' }),
      blankRow('product', { itemId: 5, description: 'The product keeps its own' }),
      blankRow('transfer', { itemId: 1, description: 'Material is not rebuilt' }),
    ];
    const rebuilt = [blankRow('component', { itemId: 1 }), blankRow('component', { itemId: 1 }), blankRow('component', { itemId: 1 }), blankRow('by_product', { itemId: 5 })];
    assert.deepEqual(
      carryDescriptions(before, rebuilt).map((r) => r.description),
      ['Lot A', 'Lot B', '', ''],
    );
    const untouched = carryDescriptions([], rebuilt);
    assert.ok(untouched.every((r, i) => r === rebuilt[i]), 'a line without a carried text is the same object');
  });
});

describe("a typed description's way through the screen's model", () => {
  it('typed under each line → sent trimmed with its line; read back on alteration; the opened set is not in the form', () => {
    let f = withTrailingBlanks(applyBom(emptyForm('manufacturing', 5, '2026-06-10'), BOM, 20, null), sectionsFor('manufacturing', null));
    f = typed(f, rowOf(f, 'product', 3).key, '  Order 77\nexport packing  ');
    f = typed(f, rowOf(f, 'scrap', 4).key, 'Offcuts');
    const lines = toVoucherInput(f).input.stockJournal?.lines ?? [];
    assert.deepEqual(
      lines.map((l) => [l.role, l.itemId, l.description ?? null]),
      [
        ['product', 3, 'Order 77\nexport packing'],
        ['scrap', 4, 'Offcuts'],
        ['component', 1, null],
        ['component', 2, null],
      ],
    );
    const detail: MfgJournalDetail = {
      id: 3,
      voucherTypeId: 5,
      class: 'manufacturing',
      date: '2026-06-10',
      number: '3',
      partyLedgerId: null,
      narration: null,
      isOptional: false,
      updatedAt: 'u',
      bomName: 'Standard',
      orderNumber: null,
      items: [],
      ledgers: [],
      block: { bomId: 7, lines },
    };
    const back = fromDetail(detail);
    assert.deepEqual(back.rows.map((r) => r.description), ['Order 77\nexport packing', 'Offcuts', '', '']);
    // Shown on alteration by their text alone (no line is opened on a voucher just opened).
    assert.deepEqual(back.rows.map((r) => lineDescriptionShown(NO_OPENED, r)), [true, true, false, false]);
    assert.doesNotMatch(read('lib/journalForm.ts'), /descOpen|NO_OPENED|openedWith|lastLine/, 'never in JournalForm: not "unsaved changes", never sent');
  });
});

// ─────────────── Wiring, read from source ───────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => fs.readFileSync(path.resolve(here, '..', rel), 'utf8');
const screen = read('JournalEntryScreen.tsx');
const components = read('components.tsx');
const css = read('mfg.css');
const vouchersCss = fs.readFileSync(path.resolve(here, '../../vouchers/vouchers-entry.css'), 'utf8');
const field = screen.slice(screen.indexOf('function LineDescriptionField('), screen.indexOf('function CancelDialog('));
const body = screen.slice(screen.indexOf('function JournalEntry('), screen.indexOf('function LineDescriptionField('));

/** Declarations of `selector { … }` in a stylesheet, normalised and sorted. */
function declarations(text: string, selector: string): string[] {
  const at = text.indexOf(`${selector} {`);
  assert.ok(at >= 0, selector);
  const block = text.slice(text.indexOf('{', at) + 1, text.indexOf('}', at));
  return block
    .split(';')
    .map((d) => d.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .sort();
}

describe('manufacturing journal wiring (2.2)', () => {
  it("the rule and the opened set are voucher entry's, imported — not copied", () => {
    assert.match(screen, /import \{ afterPointerRelease, DESC_MAX_LENGTH, NO_OPENED, openedAfterLeaving, openedWith \} from '\.\.\/vouchers\/lib\/lineDescription\.ts';/);
    assert.match(read('lib/journalDescription.ts'), /import \{ descriptionShown \} from '\.\.\/\.\.\/vouchers\/lib\/lineDescription\.ts';/);
    for (const [file, text] of [
      ['JournalEntryScreen.tsx', screen],
      ['components.tsx', components],
      ['lib/journalDescription.ts', read('lib/journalDescription.ts')],
    ]) {
      assert.doesNotMatch(text, /function (descriptionShown|openedWith|openedAfterLeaving|afterPointerRelease)\b|const DESC_MAX_LENGTH\b/, file);
    }
  });

  it('the field: a quiet one-line textarea growing to four, 1,000 characters, "Description", its own id and name', () => {
    assert.match(field, /<TextArea\b/);
    for (const attr of ['id={descriptionId(rowKey)}', 'className="bx-mfg-desc"', 'aria-label={label}', 'rows={1}', 'autoGrow', 'maxRows={4}', 'maxLength={DESC_MAX_LENGTH}', 'placeholder="Description"', 'readOnly={readOnly}', 'required={false}', 'invalid={false}', 'onValueChange={onChange}', 'onFocus={() => onFocusLine(rowKey)}']) {
      assert.ok(field.includes(attr), attr);
    }
    assert.doesNotMatch(screen, /bx-vch-/, 'mfg draws its own classes (one class, one stylesheet)');
  });

  it('under the item of every line: components, by-products / scrap, material — and the finished goods', () => {
    const named = body.slice(body.indexOf('const named = ('), body.indexOf('const descriptionTool = ('));
    assert.match(named, /<div className="bx-mfg-name">\s*\{item\}\s*\{lineDescriptionShown\(descOpen, r\) \? \(\s*<LineDescriptionField/);
    assert.match(named, /label=\{`Description of \$\{r\.itemName \|\| 'the line'\}`\}/);
    assert.match(named, /onChange=\{\(s\) => setDescription\(r\.key, s\)\}/);
    assert.match(body, /const itemCell = \(r: JournalRow, label: string\): ReactNode =>\s*named\(\s*r,\s*<ItemPicker/);
    for (const role of ['By-product or scrap item', 'Component', 'Material']) assert.ok(body.includes(`itemCell(r, '${role}')`), role);
    // The finished goods: inside its "Item" field, under the picker.
    const itemField = body.indexOf('label="Item"');
    assert.ok(itemField > 0, 'the finished goods\' "Item" field');
    const product = body.slice(itemField, body.indexOf('{features.manufacturing ? (', itemField));
    assert.match(product, /\{named\(\s*product,\s*<ItemPicker/);
    assert.match(body, /<section className="bx-mfg-section" aria-label="Finished goods" data-row-key=\{product\.key\}>/, 'the finished goods are a line (Ctrl+E, focusRow)');
  });

  it('a description typed is not a hand edit of the BOM lines: the automatic refill goes on (and keeps the text)', () => {
    assert.match(body, /const setDescription = \(key: string, text: string\) => patchRow\(key, \{ description: text \}, false\);/);
    assert.match(read('lib/journalForm.ts'), /const lines = carryDescriptions\(form\.rows, fresh\);/);
  });

  it('Enter / Shift+Enter move on from it like any field (no typed new lines); Ctrl+Enter is left to useEnterAdvance', () => {
    const keys = field.slice(field.indexOf('onKeyDown={(e) => {'), field.indexOf('onBlur={(e) => {'));
    assert.match(keys, /if \(e\.key !== 'Enter' \|\| e\.altKey \|\| e\.ctrlKey \|\| e\.metaKey \|\| e\.nativeEvent\.isComposing \|\| readOnly\) return;\s*e\.preventDefault\(\);/);
    assert.match(keys, /field\.closest<HTMLElement>\('\[data-enter-scope\]'\)/, "the form's useEnterAdvance scope");
    assert.match(keys, /enterNeighbour\(getEnterTargets\(scope\), field, e\.shiftKey\)/, "useEnterAdvance's order of fields");
    assert.match(keys, /focusElement\(next, true\);\s*next\.scrollIntoView\(\{ block: 'nearest' \}\);/, 'as useEnterAdvance moves');
    assert.match(screen, /const formRef = useEnterAdvance<HTMLDivElement>\(/, 'the screen still moves field by field with useEnterAdvance');
  });

  it('left empty it closes — kept for a dialog or another window; after the press when a click moved the cursor', () => {
    const blur = field.slice(field.indexOf('onBlur={(e) => {'));
    const dialog = blur.indexOf(`to.closest('[role="dialog"], [role="alertdialog"]')) return;`);
    const windowRule = blur.indexOf('if (!document.hasFocus()) return;');
    const pressed = blur.indexOf("if ((to instanceof Element ? to : document.documentElement).matches(':active')) {");
    assert.ok(dialog > 0 && windowRule > dialog && pressed > windowRule, 'dialog, window, then the press');
    assert.match(
      blur.slice(pressed),
      /^[^\n]*\n\s*const field = e\.currentTarget;\s*afterPointerRelease\(document, \(\) => \{\s*if \(document\.activeElement !== field\) onLeave\(rowKey, field\.value\);\s*\}\);\s*return;\s*\}\s*onLeave\(rowKey, e\.currentTarget\.value\);/,
      'deferred and skipped when the cursor is back; otherwise at once',
    );
    assert.match(body, /const onDescriptionFocus = useCallback\(\(rowKey: string\) => setDescOpen\(openedWith\(descOpenRef\.current, rowKey\)\), \[setDescOpen\]\);/, 'moving in keeps it open while edited');
    assert.match(body, /const onDescriptionLeave = useCallback\(\(rowKey: string, text: string\) => setDescOpen\(openedAfterLeaving\(descOpenRef\.current, rowKey, text\)\), \[setDescOpen\]\);/);
  });

  it('the opened lines are screen state (state + ref), and the next voucher starts with none and no last line', () => {
    assert.match(body, /const \[descOpen, setDescOpenState\] = useState<ReadonlySet<string>>\(NO_OPENED\);/);
    assert.match(body, /const descOpenRef = useRef\(descOpen\);/);
    const submit = body.slice(body.indexOf('const submit = async () => {'), body.indexOf('const remove = async () => {'));
    assert.match(submit, /setDescOpen\(NO_OPENED\);\s*lastLineRef\.current = null;[\s\S]*setFormRaw\(fresh\);/);
  });

  it('Ctrl+E is one action — "Line description", under More (not primary, no hotkey map), hidden for a view-only role', () => {
    assert.equal(screen.match(/key: 'Ctrl\+E'/g)?.length, 1);
    assert.match(body, /\{ key: 'Ctrl\+E', label: 'Line description', icon: 'text', onClick: describeLine, hidden: readOnly, group: 'details' \},/);
    assert.doesNotMatch(screen, /'Ctrl\+E'\s*:/, 'no hotkey map entry');
    assert.equal(screen.match(/primary: true/g)?.length, 1, 'one primary action (Ctrl+A)');
    assert.match(screen, /hint="[^"]*· Ctrl\+E Description ·[^"]*"/);
  });

  it('Ctrl+E describes the line the cursor is on — or was last on (More ▾, the shortcut bar); elsewhere a note', () => {
    const describe = body.slice(body.indexOf('const describeLine = () => {'), body.indexOf('const setDescription = ('));
    assert.match(describe, /const key = focusedRowKey\(\) \?\? lastLineRef\.current;\s*const act = describeAction\(form, descOpenRef\.current, key\);/);
    assert.match(describe, /document\.getElementById\(descriptionId\(key\)\)\?\.focus\(\);\s*focusLater\(descriptionId\(key\)\);/, 'on screen: in at once, and again next frame');
    assert.match(describe, /openDescription\(key\);/);
    assert.match(describe, /toast\.info\('Move to an item line first', \{ message: 'Ctrl\+E adds a description under the item the cursor is on\.' \}\);/);
    // The last line: the form's focus events (bubbling); a picker list in a portal leaves it as it was.
    assert.match(body, /<div ref=\{formRef\} onFocus=\{onFormFocus\}>/);
    const onFocus = body.slice(body.indexOf('const onFormFocus = ('), body.indexOf('const describeLine = () => {'));
    assert.match(onFocus, /if \(!\(t instanceof Element\) \|\| !e\.currentTarget\.contains\(t\)\) return;\s*lastLineRef\.current = rowKeyOf\(t\);/);
    const open = body.slice(body.indexOf('const openDescription = useCallback('), body.indexOf('const onDescriptionFocus'));
    assert.match(open, /setDescOpen\(openedWith\(descOpenRef\.current, rowKey\)\);\s*focusLater\(descriptionId\(rowKey\)\);/);
  });

  it('row tools: "Description" on a line with an item whose description is hidden; the item tables only (not additional costs)', () => {
    const tool = body.slice(body.indexOf('const descriptionTool = ('), body.indexOf('const itemCell = ('));
    assert.match(tool, /readOnly \|\| r\.itemId === null \|\| lineDescriptionShown\(descOpen, r\) \? null : \(/);
    assert.match(tool, /<IconButton icon="text" size="sm" variant="ghost" tabIndex=\{-1\} aria-label=\{`Description of \$\{r\.itemName\}`\} tooltip="Description \(Ctrl\+E\)" onClick=\{\(\) => openDescription\(r\.key\)\} \/>/);
    assert.equal(body.match(/tool: descriptionTool\(r\),/g)?.length, 3, 'by-products / scrap, components, material');
    assert.equal(body.match(/<LinesTable\b[^>]*?\btools\b/g)?.length, 3);
    const costs = body.slice(body.indexOf('caption="Additional costs'), body.indexOf('{est && (sections.products'));
    assert.doesNotMatch(costs, /\btools\b/);
    // The finished goods: "Description" beside "Item" (a link, as voucher entry's "Bank details").
    assert.match(body, /<Button size="sm" variant="link" tabIndex=\{-1\} shortcut="Ctrl\+E" onClick=\{\(\) => openDescription\(product\.key\)\}>\s*Description\s*<\/Button>/);
    assert.match(body, /readOnly \|\| product\.itemId === null \|\| lineDescriptionShown\(descOpen, product\) \? undefined : \(/);
  });

  it('LinesTable: a tools column after the columns (header, cell, widths), spans counted; focusRow skips mouse-only tools', () => {
    const table = components.slice(components.indexOf('export function LinesTable('));
    assert.match(table, /const span = columns\.length \+ \(tools \? 1 : 0\);/);
    assert.match(table, /\{tools \? <col style=\{\{ width: 36 \}\} \/> : null\}/);
    assert.match(table, /<span className="bx-sr-only">Line tools<\/span>/);
    assert.match(table, /\{tools \? <td className="bx-mfg-lines__tool">\{r\.tool \?\? null\}<\/td> : null\}/);
    assert.equal(table.match(/<td colSpan=\{span\}>/g)?.length, 2, 'error row and footer');
    assert.match(table, /<td colSpan=\{span \+ 1\} className="bx-muted">/, 'the empty row');
    assert.doesNotMatch(table, /colSpan=\{columns\.length/);
    assert.match(components, /querySelector<HTMLElement>\('input, select, textarea, button:not\(\[tabindex="-1"\]\)'\)/, "the finished goods' Description link comes before its picker");
    assert.match(components, /export function rowKeyOf\(el: Element \| null\): string \| null \{\s*const row = el \? el\.closest\('\[data-row-key\]'\) : null;/);
  });

  it("the look is voucher entry's quiet field (the same declarations), with mfg's own class in mfg's own stylesheet", () => {
    assert.deepEqual(declarations(css, '.bx-textarea.bx-mfg-desc'), declarations(vouchersCss, '.bx-textarea.bx-vch-desc'));
    assert.deepEqual(declarations(css, '.bx-textarea.bx-mfg-desc:not(:hover, :focus, .is-invalid)'), declarations(vouchersCss, '.bx-textarea.bx-vch-desc:not(:hover, :focus, .is-invalid)'));
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(rules, /\.bx-vch-/, 'mfg.css styles no voucher-entry class');
    assert.doesNotMatch(vouchersCss, /bx-mfg-/);
    assert.deepEqual(declarations(css, '.bx-mfg-name'), ['display: flex', 'flex-direction: column', 'gap: var(--space-0-5)', 'min-width: 0']);
    assert.deepEqual(declarations(css, '.bx-mfg-lines tr.bx-mfg-row:not(:hover, :focus-within) .bx-mfg-lines__tool button'), ['opacity: 0'], 'row tools show on hover / focus');
  });
});
