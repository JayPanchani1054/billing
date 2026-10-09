import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { masterHistoryParams } from './history.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('inventory master edit history (Alt+H)', () => {
  it('opens the record history of a saved master', () => {
    assert.deepEqual(masterHistoryParams('stock_group', { id: 7, guid: 'g-7' }, 'Grains'), { entityType: 'stock_group', entityId: 7, entityGuid: 'g-7', label: 'Grains' });
    assert.deepEqual(masterHistoryParams('unit', { id: 3, guid: 'u-3' }, 'KGS')?.entityType, 'unit');
  });

  it('is not offered while the master is being created', () => {
    assert.equal(masterHistoryParams('godown', null, ''), null);
    assert.equal(masterHistoryParams('godown', { id: 0, guid: '' }, ''), null);
  });

  it('uses the entity types the core audits the masters under', () => {
    const core = ['masters.ts', 'units.ts'].map((f) => fs.readFileSync(path.resolve(here, '../../../../core/modules/inventory', f), 'utf8')).join('\n');
    for (const t of ['stock_group', 'stock_category', 'godown', 'unit']) assert.match(core, new RegExp(`entityType: '${t}'`), t);
  });

  it('every inventory master form offers Alt+H Edit history', () => {
    const forms: Array<[string, string]> = [
      ['Groups.tsx', 'stock_group'],
      ['Categories.tsx', 'stock_category'],
      ['Godowns.tsx', 'godown'],
      ['Units.tsx', 'unit'],
    ];
    for (const [file, type] of forms) {
      const src = fs.readFileSync(path.resolve(here, '..', file), 'utf8');
      assert.match(src, new RegExp(`useMasterHistory\\('${type}'`), `${file} opens the ${type} history`);
      assert.match(src, /<HistoryKey onOpen=\{history\} \/>/, `${file} binds Alt+H`);
      assert.match(src, /<HistoryButton onOpen=\{history\} \/>/, `${file} shows the Edit history button`);
    }
    assert.match(fs.readFileSync(path.resolve(here, '..', 'ItemForm.tsx'), 'utf8'), /key: 'Alt\+H',\s*label: 'Edit history'/);
  });
});
