import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Permission } from '../../../../shared/constants.ts';
import type { PermissionCatalog, PermissionCatalogGroup } from '../../../../shared/types/security.ts';
import {
  catalogIndex,
  dependantsOf,
  grantableFor,
  groupState,
  permissionChanges,
  prerequisitesOf,
  roleNameProblem,
  toggleGroup,
  toggleNote,
  togglePermission,
} from './permissionTree.ts';

const item = (permission: Permission, group: string, label: string) => ({ permission, label, fullLabel: `${group} › ${label}`, description: `${label}.` });
const VOUCHERS: PermissionCatalogGroup = {
  key: 'vouchers',
  label: 'Vouchers',
  items: [
    item('vouchers.view', 'Vouchers', 'View vouchers'),
    item('vouchers.create', 'Vouchers', 'Create vouchers'),
    item('vouchers.alter', 'Vouchers', 'Alter vouchers'),
    item('vouchers.delete', 'Vouchers', 'Delete vouchers'),
    item('vouchers.backdate', 'Vouchers', 'Back-date vouchers'),
  ],
};
const CATALOG: PermissionCatalog = { groups: [VOUCHERS] };
const set = (...p: Permission[]) => new Set<Permission>(p);

describe('permission tree', () => {
  it('knows prerequisites transitively and dependants', () => {
    assert.deepEqual(prerequisitesOf('vouchers.backdate'), ['vouchers.view', 'vouchers.create']);
    // 2.0: vouchers.renumber needs vouchers.alter (so it depends on vouchers.view too).
    assert.deepEqual(dependantsOf('vouchers.view'), ['vouchers.create', 'vouchers.alter', 'vouchers.delete', 'vouchers.backdate', 'vouchers.renumber']);
    assert.deepEqual(prerequisitesOf('vouchers.renumber'), ['vouchers.view', 'vouchers.alter']);
    assert.deepEqual(dependantsOf('vouchers.alter'), ['vouchers.renumber']);
    assert.deepEqual(prerequisitesOf('audit.view'), []);
  });

  it('turning a permission on adds what it needs; turning it off removes what depends on it', () => {
    const on = togglePermission(set(), 'vouchers.backdate', true);
    assert.deepEqual([...on.next].sort(), ['vouchers.backdate', 'vouchers.create', 'vouchers.view']);
    assert.deepEqual(on.alsoOn, ['vouchers.view', 'vouchers.create']);
    const off = togglePermission(on.next, 'vouchers.view', false);
    assert.deepEqual([...off.next], []);
    assert.deepEqual(off.alsoOff, ['vouchers.create', 'vouchers.backdate']);
    const idx = catalogIndex(CATALOG);
    assert.equal(toggleNote(idx, on), 'Also turned on (needed): Vouchers › View vouchers, Vouchers › Create vouchers.');
    assert.equal(toggleNote(idx, { alsoOn: [], alsoOff: [] }), null);
  });

  it('cannot add permissions the editor does not hold (removing is always allowed)', () => {
    const grantable = grantableFor(false, ['vouchers.view', 'vouchers.create']);
    assert.deepEqual([...togglePermission(set(), 'vouchers.delete', true, grantable).next], []);
    // A prerequisite the editor lacks is not added either.
    const g2 = grantableFor(false, ['vouchers.create']);
    assert.deepEqual([...togglePermission(set(), 'vouchers.create', true, g2).next], ['vouchers.create']);
    assert.deepEqual([...togglePermission(set('vouchers.delete'), 'vouchers.delete', false, grantable).next], []);
    assert.equal(grantableFor(true, [])('data.restore'), true);
  });

  it('group checkbox is tri-state and toggles every grantable item', () => {
    assert.equal(groupState(VOUCHERS, set()), 'none');
    assert.equal(groupState(VOUCHERS, set('vouchers.view')), 'some');
    const all = toggleGroup(set('vouchers.view'), VOUCHERS);
    assert.equal(groupState(VOUCHERS, all.next), 'all');
    assert.deepEqual(all.alsoOn, [], 'prerequisites inside the group are not reported as extras');
    const none = toggleGroup(all.next, VOUCHERS);
    assert.equal(groupState(VOUCHERS, none.next), 'none');
    const limited = toggleGroup(set(), VOUCHERS, grantableFor(false, ['vouchers.view', 'vouchers.create']));
    assert.deepEqual([...limited.next].sort(), ['vouchers.create', 'vouchers.view']);
  });

  it('reports added and removed permissions against the saved role', () => {
    assert.deepEqual(permissionChanges(['vouchers.view', 'vouchers.alter'], set('vouchers.view', 'vouchers.create')), {
      added: ['vouchers.create'],
      removed: ['vouchers.alter'],
    });
  });

  it('validates role names like the server', () => {
    assert.equal(roleNameProblem('  ', []), 'Enter a name for the role');
    assert.equal(roleNameProblem('x'.repeat(61), []), 'Use at most 60 characters');
    assert.equal(roleNameProblem('owner', ['Owner', 'Accountant']), 'A role with this name already exists');
    assert.equal(roleNameProblem('Cashier', ['Owner']), null);
  });
});
