/**
 * (2.0) Every part a template says it supports (TEMPLATE_PARTS → its SUPPORTED_PARTS) is really honoured by
 * that template, and every `data-part` it prints is a catalogue id. The templates are React (.tsx), so their
 * source is scanned: the template file plus the shared building blocks it uses (templates/parts.tsx, the
 * helpers of lib/layout.ts, the forex / POS print blocks), followed transitively.
 *
 *   click target — `data-part="<id>"` (or the id as a string literal handed to `data-part={…}`)
 *   honoured     — gate: `isPartShown(doc, '<id>')` · column: `cols.<field>` (and itemColumns ANDs the
 *                  part) · total: `totalRows(` · DTO / option-owned: the field the layout clears or the
 *                  option decides · page: the screens pass `pageNumbers` to the printed HTML
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isPrintPartId, printPart, type PrintPartId } from '../../../../shared/printLayout.ts';
import { TEMPLATE_FILES, TEMPLATE_PARTS, type TemplateKind } from './layoutParts.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const printDir = path.resolve(here, '..');
const read = (rel: string): string => fs.readFileSync(path.resolve(printDir, rel), 'utf8');
/** Source without comments (a part named in a comment proves nothing). */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

/** Top-level functions of a file → their source (up to the next top-level function / const). */
function functions(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^(?:export )?(?:function|const) (\w+)/gm;
  const starts = [...src.matchAll(re)].map((m) => ({ name: m[1], at: m.index ?? 0 }));
  starts.forEach((s, i) => out.set(s.name, src.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : src.length)));
  return out;
}

const PARTS_FNS = functions(code(read('templates/parts.tsx')));
const LAYOUT_FNS = functions(code(read('lib/layout.ts')));
const BLOCKS: Record<string, string> = {
  ForexPrintBlock: code(fs.readFileSync(path.resolve(printDir, '../forex/PrintBlock.tsx'), 'utf8')),
  PosPrintBlock: code(fs.readFileSync(path.resolve(printDir, '../pos/PrintBlock.tsx'), 'utf8')),
};

const uses = (src: string, name: string): boolean => new RegExp(`(<${name}\\b|\\b${name}\\()`).test(src);

/** The template's source plus everything it draws through, transitively. */
function sourcesOf(kind: TemplateKind): string {
  const seen = new Set<string>();
  const texts = [code(read(`templates/${TEMPLATE_FILES[kind]}`))];
  for (let i = 0; i < texts.length; i++) {
    const src = texts[i];
    for (const [name, body] of [...PARTS_FNS, ...LAYOUT_FNS, ...Object.entries(BLOCKS)]) {
      if (seen.has(name) || !uses(src, name)) continue;
      seen.add(name);
      texts.push(body);
    }
  }
  return texts.join('\n');
}

const COLUMN_FIELDS: Partial<Record<PrintPartId, string[]>> = {
  'col.sno': ['cols.sno'],
  'col.hsn': ['cols.hsn'],
  'col.batch': ['cols.batch'],
  'col.qty': ['cols.qty', "isPartShown(doc, 'col.qty')"],
  'col.unit': ['cols.unit'],
  'col.rate': ['cols.rate'],
  'col.discount': ['cols.discount'],
  'col.taxable': ['cols.taxable'],
  'col.gstRate': ['cols.gstRate'],
  'col.cgst': ['cols.lineHeads.cgst'],
  'col.sgst': ['cols.lineHeads.sgst'],
  'col.igst': ['cols.lineHeads.igst'],
  'col.cess': ['cols.lineHeads.cess'],
  'col.amount': ['cols.amount'],
};

/** The DTO field applyPrintLayout clears, or the option-owned evidence, per part. */
const FIELD_EVIDENCE: Partial<Record<PrintPartId, string[]>> = {
  logo: ['.logo'],
  'company.gstin': ['.gstin'],
  'company.pan': ['.pan'],
  'company.cin': ['.cin'],
  'company.contact': ['.phone'],
  endorsement: ['doc.endorsement'],
  statutoryNotes: ['doc.notes'],
  refs: ['doc.referenceNo', 'doc.references'],
  placeOfSupply: ['doc.placeOfSupply'],
  ewayBill: ['doc.ewayBill'],
  originalInvoice: ['doc.originalInvoice'],
  'party.gstin': ['.gstin', 'partyIds('],
  'party.contact': ['partyIds('],
  consignee: ['doc.consignee'],
  forex: ['forexInvoiceBlock(', 'doc.forex'],
  pos: ['doc.pos'],
  einvoice: ['doc.einvoice'],
  narration: ['doc.narration'],
  declaration: ['doc.declaration'],
  terms: ['doc.terms'],
  // Option-owned (D22): core decides from the option; the template reads the result.
  'col.mrp': ['cols.mrp', 'showMrp('],
  lineTax: ['cols.lineTax'],
  hsnSummary: ['options.showHsnSummary'],
  bank: ['BankBlock', 'doc.bank'],
  upiQr: ['qrs.upi'],
};

const KINDS = Object.keys(TEMPLATE_FILES) as TemplateKind[];

describe('print layout parts: every supported part is honoured by its template', () => {
  for (const kind of KINDS) {
    test(`${kind} (${TEMPLATE_FILES[kind]})`, () => {
      const file = read(`templates/${TEMPLATE_FILES[kind]}`);
      assert.match(file, new RegExp(`export const SUPPORTED_PARTS = TEMPLATE_PARTS\\.${kind};`), 'the template exports its list');
      const src = sourcesOf(kind);
      const problems: string[] = [];
      for (const id of TEMPLATE_PARTS[kind]) {
        const def = printPart(id);
        if (!def) {
          problems.push(`${id}: not in the catalogue`);
          continue;
        }
        if (def.kind !== 'page' && !src.includes(`data-part="${id}"`) && !src.includes(`'${id}'`)) problems.push(`${id}: no data-part (click-to-select)`);
        if (def.locked) continue;
        const ok =
          def.kind === 'gate'
            ? src.includes(`isPartShown(doc, '${id}')`)
            : def.kind === 'column'
              ? (COLUMN_FIELDS[id] ?? []).some((f) => src.includes(f))
              : def.kind === 'total'
                ? src.includes('totalRows(') || src.includes(`isPartShown(doc, '${id}')`)
                : def.kind === 'page'
                  ? true
                  : (FIELD_EVIDENCE[id] ?? []).some((f) => src.includes(f));
        if (!ok) problems.push(`${id} (${def.kind}): not honoured`);
      }
      assert.deepEqual(problems, []);
    });
  }

  test('itemColumns ANDs every column part; totalRows filters every totals part', () => {
    const cols = LAYOUT_FNS.get('itemColumns') ?? '';
    for (const id of Object.keys(COLUMN_FIELDS)) assert.match(cols, new RegExp(`shown\\('${id.replace('.', '\\.')}'\\)`), id);
    const totals = LAYOUT_FNS.get('totalRows') ?? '';
    for (const id of ['totals.taxable', 'totals.taxHeads', 'totals.charges', 'totals.roundOff', 'totals.grand']) assert.ok(totals.includes(`'${id}'`), id);
    assert.match(totals, /filter\(\(r\) => isPartShown\(doc, r\.part\)\)/);
  });

  test('page numbers: every screen that prints passes the layout to the printed HTML', () => {
    for (const f of ['PrintVoucherScreen.tsx', 'PrintBatchScreen.tsx', 'PrintSettingsScreen.tsx']) assert.match(code(read(f)), /pageNumbers/, f);
    assert.match(code(read('usePrinting.ts')), /pageNumbers: false/);
  });

  test('every data-part printed is a catalogue id', () => {
    const files = [
      ...fs.readdirSync(path.resolve(printDir, 'templates')).map((f) => `templates/${f}`),
      '../forex/PrintBlock.tsx',
      '../pos/PrintBlock.tsx',
    ];
    const bad: string[] = [];
    let seen = 0;
    for (const f of files) {
      for (const m of code(read(f)).matchAll(/data-part="([^"]*)"/g)) {
        seen++;
        if (!isPrintPartId(m[1])) bad.push(`${f}: ${m[1]}`);
      }
    }
    assert.ok(seen > 100, `only ${seen} data-part attributes found`);
    assert.deepEqual(bad, []);
  });

  test('one choke point: every printed document goes through layoutDoc in PrintDocuments', () => {
    const root = code(read('templates/PrintDocuments.tsx'));
    assert.match(root, /items\.map\(\(it\) => \(\{ \.\.\.it, doc: layoutDoc\(it\.doc, layers\) \}\)\)/, 'each item is laid out');
    assert.match(root, /laidOut\.flatMap\(/, 'only laid-out documents are drawn');
    assert.doesNotMatch(root, /items\.flatMap\(/, 'never the raw items');
    // The preview pane is the only drawer, and hands the layers on; templates are drawn nowhere else.
    assert.match(code(read('components.tsx')), /<PrintDocuments [^>]*layers=\{layers\}/);
    for (const f of ['PrintVoucherScreen.tsx', 'PrintBatchScreen.tsx', 'PrintSettingsScreen.tsx', 'ShareDialog.tsx', 'usePrinting.ts']) {
      assert.doesNotMatch(code(read(f)), /<(DocumentView|ModernInvoice|ClassicInvoice|CompactDoc|InventoryDoc|VoucherDoc|PrintDocuments)\b/, f);
    }
    // Batch printing (and print after saving: the preview with no per-print change) use the saved layers only.
    assert.doesNotMatch(code(read('PrintBatchScreen.tsx')), /<PreviewPane [^>]*layers=/);
  });

  test('the editing outline class never enters the printed element', () => {
    const tpl = fs.readdirSync(path.resolve(printDir, 'templates')).map((f) => read(`templates/${f}`)).join('\n');
    assert.doesNotMatch(tpl, /bp-editing/);
    assert.match(code(read('components.tsx')), /'bp-preview bp-editing'/, 'only on the preview container');
  });
});
