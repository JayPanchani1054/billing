/**
 * Multiple aliases for ledgers and stock items (dataplus, migration 220): storage (first alias in the
 * master's column, the rest in ledger_aliases / stock_item_aliases), uniqueness across names and
 * aliases within the entity kind, search in lists / pickers / Go To, import and export, Tally import.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FieldIssue } from '../../../shared/api.ts';
import type { LedgerDetail, LedgerListRow } from '../../../shared/types/accounts.ts';
import type { ItemPickerRow, StockItemSaveResult } from '../../../shared/types/inventory.ts';
import { AppError } from '../../lib/errors.ts';
import { idByNameOrAlias, normalizeAliases, splitAliasCell, joinAliasCell } from '../../lib/masterAliases.ts';
import { createTestCompany, type TestCompany } from '../../testing/fixtures.ts';
import { exportMasters } from '../data/exportData.ts';
import { commitImport } from '../data/importer.ts';
import { importXml } from '../data/xmlImport.ts';
import { utf16le } from '../data/xmlFixture.ts';
import { inventoryRoutes } from '../inventory/routes.ts';
import { deleteLedger, getLedger, ledgerPicker, listLedgers, saveLedger } from './ledgers.ts';
import { accountsRoutes } from './routes.ts';
import { saveGroup } from './groups.ts';
import { MESSAGE_CLOSE, MESSAGE_TAG, REQUEST_TAG } from '../data/xmlFormat.ts';

let t: TestCompany;
beforeEach(() => {
  t = createTestCompany({ today: '2026-10-05' });
});
afterEach(() => t.close());

function issues(fn: () => unknown): FieldIssue[] {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof AppError && e.code === 'VALIDATION', String(e));
    return e.details as FieldIssue[];
  }
  assert.fail('expected a validation error');
}

const debtor = (name: string, aliases?: string[]): LedgerDetail =>
  saveLedger(t.ctx, { name, groupId: t.ids.groups.SUNDRY_DEBTORS, ...(aliases ? { aliases } : {}) });

describe('alias list normalisation', () => {
  it('trims, drops blanks, duplicates (case-insensitive) and the name itself, keeping the order', () => {
    assert.deepEqual(normalizeAliases('Acme', [' ACME-01 ', '', 'acme', 'acme-01', 'Acme Pune', null, '  Acme   Pune ']), ['ACME-01', 'Acme Pune']);
  });
  it('splits and joins spreadsheet cells', () => {
    assert.deepEqual(splitAliasCell('A1; B2 ;;C3 '), ['A1', 'B2', 'C3']);
    assert.equal(joinAliasCell(['A1', 'B2']), 'A1; B2');
    assert.equal(joinAliasCell([]), null);
  });
});

describe('ledger aliases', () => {
  it('stores the first alias in the column and the rest in ledger_aliases; get returns all in order', () => {
    const l = debtor('Acme Traders', ['ACME', 'अॅक्मे ट्रेडर्स', 'C-0042']);
    assert.equal(l.alias, 'ACME');
    assert.deepEqual(l.aliases, ['ACME', 'अॅक्मे ट्रेडर्स', 'C-0042']);
    assert.equal(t.db.value('SELECT alias FROM ledgers WHERE id = :id', { id: l.id }), 'ACME');
    assert.deepEqual(
      t.db.all<{ alias: string }>('SELECT alias FROM ledger_aliases WHERE ledger_id = :id ORDER BY position', { id: l.id }).map((r) => r.alias),
      ['अॅक्मे ट्रेडर्स', 'C-0042'],
    );
  });

  it('alter without `aliases` keeps them; `alias` alone changes only the first; `aliases: []` clears all', () => {
    const l = debtor('Acme Traders', ['ACME', 'C-0042']);
    const a = saveLedger(t.ctx, { id: l.id, creditLimit: 100_000_00 });
    assert.deepEqual(a.aliases, ['ACME', 'C-0042']);
    const b = saveLedger(t.ctx, { id: l.id, alias: 'ACME PUNE' });
    assert.deepEqual(b.aliases, ['ACME PUNE', 'C-0042']);
    const c = saveLedger(t.ctx, { id: l.id, aliases: [] });
    assert.deepEqual(c.aliases, []);
    assert.equal(c.alias, null);
    assert.equal(t.db.value('SELECT COUNT(*) FROM ledger_aliases'), 0);
  });

  it('a rename onto one of its own aliases drops that alias', () => {
    const l = debtor('Acme Traders', ['ACME', 'C-0042']);
    const r = saveLedger(t.ctx, { id: l.id, name: 'C-0042' });
    assert.deepEqual(r.aliases, ['ACME']);
  });

  it('names and aliases are unique across ledgers, including additional aliases', () => {
    debtor('Acme Traders', ['ACME', 'C-0042']);
    // An additional alias of another ledger as a name, first alias or additional alias.
    let found = issues(() => debtor('C-0042'));
    assert.ok(found.some((i) => i.path === 'name' && /alias of the ledger 'Acme Traders'/.test(i.message)), JSON.stringify(found));
    found = issues(() => debtor('Beta Stores', ['c-0042']));
    assert.ok(found.some((i) => i.path === 'alias' && /already used by the ledger 'Acme Traders'/.test(i.message)), JSON.stringify(found));
    found = issues(() => debtor('Beta Stores', ['BETA', 'acme traders']));
    assert.ok(found.some((i) => i.path === 'aliases[1]' && /name of another ledger/.test(i.message)), JSON.stringify(found));
    // Nothing was written by the refused saves.
    assert.equal(t.db.value(`SELECT COUNT(*) FROM ledgers WHERE name IN ('C-0042', 'Beta Stores')`), 0);
  });

  it('ledgers and groups share a name space: additional aliases are checked both ways', () => {
    const found = issues(() => debtor('Acme Traders', ['ACME', 'Sundry Debtors']));
    assert.ok(found.some((i) => i.path === 'aliases[1]' && /group 'Sundry Debtors'/.test(i.message)), JSON.stringify(found));
    debtor('Acme Traders', ['ACME', 'Key Accounts']);
    const g = issues(() => saveGroup(t.ctx, { name: 'Key Accounts', parentId: t.ids.groups.SUNDRY_DEBTORS }));
    assert.ok(g.some((i) => i.path === 'name' && /ledger 'Acme Traders'/.test(i.message)), JSON.stringify(g));
  });

  it('at most 20 aliases', () => {
    const many = Array.from({ length: 21 }, (_, i) => `A${i}`);
    const found = issues(() => debtor('Acme Traders', many));
    assert.ok(found.some((i) => i.path === 'aliases'));
  });

  it('the list, picker and Go To search find a ledger by any alias; rows carry the additional aliases', () => {
    const l = debtor('Acme Traders', ['ACME', 'C-0042']);
    const list = listLedgers(t.db, { search: 'c-004' }, '2026-10-05');
    assert.deepEqual(list.rows.map((r: LedgerListRow) => r.name), ['Acme Traders']);
    assert.deepEqual(list.rows[0].otherAliases, ['C-0042']);
    const pick = ledgerPicker(t.db, {}, '2026-10-05').find((r) => r.id === l.id);
    assert.equal(pick?.alias, 'ACME');
    assert.deepEqual(pick?.otherAliases, ['C-0042']);
    // Rows without additional aliases carry no key (wire size unchanged).
    assert.equal(Object.hasOwn(ledgerPicker(t.db, {}, '2026-10-05').find((r) => r.id === t.ids.ledgers.CASH) ?? {}, 'otherAliases'), false);
    assert.equal(idByNameOrAlias(t.db, 'ledger', 'c-0042'), l.id);
  });

  it('alias changes are in the edit log; aliases go with a deleted ledger', () => {
    const l = debtor('Acme Traders', ['ACME', 'C-0042']);
    saveLedger(t.ctx, { id: l.id, aliases: ['ACME'] });
    const last = t.db.get<{ before_json: string; after_json: string }>(
      `SELECT before_json, after_json FROM audit_log WHERE entity_type = 'ledger' AND entity_id = :id ORDER BY id DESC LIMIT 1`,
      { id: l.id },
    );
    assert.ok(last);
    assert.deepEqual((JSON.parse(last.before_json) as { otherAliases?: string[] }).otherAliases, ['C-0042']);
    assert.equal((JSON.parse(last.after_json) as { otherAliases?: string[] }).otherAliases, undefined);
    saveLedger(t.ctx, { id: l.id, aliases: ['ACME', 'C-0042'] });
    deleteLedger(t.ctx, l.id);
    assert.equal(t.db.value('SELECT COUNT(*) FROM ledger_aliases'), 0);
  });

  it('accounts.ledger.save takes the list through the dispatcher', async () => {
    const res = await t.call(accountsRoutes, 'accounts.ledger.save', { name: 'Acme Traders', groupId: t.ids.groups.SUNDRY_DEBTORS, aliases: ['ACME', 'C-0042'] });
    assert.ok(res.ok, JSON.stringify(res));
    assert.deepEqual((res.data as LedgerDetail).aliases, ['ACME', 'C-0042']);
    assert.deepEqual(getLedger(t.db, (res.data as LedgerDetail).id, '2026-10-05').aliases, ['ACME', 'C-0042']);
  });
});

describe('stock item aliases', () => {
  const item = async (input: Record<string, unknown>): Promise<StockItemSaveResult> => {
    const res = await t.call(inventoryRoutes, 'inventory.item.save', { unitId: t.ids.units.Nos, ...input });
    if (!res.ok) throw new AppError(res.error.code, res.error.message, res.error.details);
    return res.data as StockItemSaveResult;
  };

  it('stores, returns and searches every alias; unique across items', async () => {
    const a = await item({ name: 'Mixer Grinder 750W', aliases: ['MG750', 'SKU-0001', 'मिक्सर'] });
    assert.deepEqual(a.item.aliases, ['MG750', 'SKU-0001', 'मिक्सर']);
    assert.equal(a.item.alias, 'MG750');
    const res = await t.call(inventoryRoutes, 'inventory.item.picker', { search: 'sku-00', limit: 5 });
    assert.ok(res.ok);
    const rows = res.data as ItemPickerRow[];
    assert.deepEqual(rows.map((r) => r.name), ['Mixer Grinder 750W']);
    assert.deepEqual(rows[0].otherAliases, ['SKU-0001', 'मिक्सर']);
    const list = await t.call(inventoryRoutes, 'inventory.item.list', { search: 'मिक्सर' });
    assert.ok(list.ok);
    assert.equal((list.data as { total: number }).total, 1);

    await assert.rejects(item({ name: 'SKU-0001' }), (e: unknown) => e instanceof AppError && e.code === 'VALIDATION' && /alias of the stock item/.test(e.message + JSON.stringify(e.details)));
    await assert.rejects(item({ name: 'Juicer', aliases: ['JU1', 'mg750'] }), (e: unknown) => e instanceof AppError && e.code === 'VALIDATION');
    // Ledger aliases and item aliases are separate kinds: the same code may be both.
    debtor('Acme Traders', ['ACME', 'SKU-0001']);
    assert.equal(idByNameOrAlias(t.db, 'stock_item', 'sku-0001'), a.item.id);
  });

  it('alter keeps the additional aliases unless the list is given', async () => {
    const a = await item({ name: 'Kettle', aliases: ['KT1', 'KT-OLD'] });
    const b = await item({ id: a.item.id, sellingPrice: 1200_00, alias: 'KT2' });
    assert.deepEqual(b.item.aliases, ['KT2', 'KT-OLD']);
    const c = await item({ id: a.item.id, aliases: ['KT-OLD'] });
    assert.deepEqual(c.item.aliases, ['KT-OLD']);
  });
});

describe('aliases in import / export and Tally import', () => {
  it('masters export writes every alias into the Alias cell and the import reads them back', async () => {
    debtor('Acme Traders', ['ACME', 'C-0042']);
    const book = exportMasters(t.ctx, { kinds: ['ledgers'], format: 'xlsx' });
    const target = createTestCompany({ today: '2026-10-05', name: 'Copy Co' });
    try {
      const r = await commitImport(target.ctx, { kind: 'ledgers', fileName: 'Masters.xlsx', bytes: book.bytes, options: { skipInvalid: false, updateExisting: false, sheet: 'Ledgers' } });
      assert.equal(r.failed, 0, JSON.stringify(r.rows));
      const id = idByNameOrAlias(target.db, 'ledger', 'Acme Traders');
      assert.ok(id);
      assert.deepEqual(getLedger(target.db, id, '2026-10-05').aliases, ['ACME', 'C-0042']);
      // A voucher import may name the party by any alias.
      assert.equal(idByNameOrAlias(target.db, 'ledger', 'c-0042'), id);
    } finally {
      target.close();
    }
  });

  it('a Tally ledger / stock item keeps all its NAME.LIST aliases', async () => {
    const xml = `<ENVELOPE><HEADER><${REQUEST_TAG}>Import Data</${REQUEST_TAG}></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC><REQUESTDATA>
<${MESSAGE_TAG}><UNIT NAME="Nos"><NAME>Nos</NAME><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT></UNIT>${MESSAGE_CLOSE}
<${MESSAGE_TAG}><LEDGER NAME="Acme Traders"><PARENT>Sundry Debtors</PARENT><LANGUAGENAME.LIST><NAME.LIST TYPE="String"><NAME>Acme Traders</NAME><NAME>ACME</NAME><NAME>C-0042</NAME><NAME>Acme Old</NAME></NAME.LIST></LANGUAGENAME.LIST></LEDGER>${MESSAGE_CLOSE}
<${MESSAGE_TAG}><STOCKITEM NAME="Kettle"><BASEUNITS>Nos</BASEUNITS><LANGUAGENAME.LIST><NAME.LIST TYPE="String"><NAME>Kettle</NAME><NAME>KT1</NAME><NAME>KT-OLD</NAME></NAME.LIST></LANGUAGENAME.LIST></STOCKITEM>${MESSAGE_CLOSE}
</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
    const res = await importXml(t.ctx, { fileName: 'm.xml', bytes: utf16le(xml), options: { masters: true, vouchers: false, onDuplicate: 'skip' } });
    assert.ok(res.issues.every((i) => i.severity !== 'error'), JSON.stringify(res.issues));
    const l = idByNameOrAlias(t.db, 'ledger', 'Acme Traders');
    assert.ok(l);
    assert.deepEqual(getLedger(t.db, l, '2026-10-05').aliases, ['ACME', 'C-0042', 'Acme Old']);
    const i = idByNameOrAlias(t.db, 'stock_item', 'kt-old');
    assert.equal(t.db.value('SELECT name FROM stock_items WHERE id = :i', { i }), 'Kettle');
  });
});
