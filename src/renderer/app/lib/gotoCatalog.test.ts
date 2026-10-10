import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { GotoItem } from './goto.ts';
import { answerGotoCatalogRequest, GOTO_CATALOG_EVENT, gotoCatalogSnapshot } from './gotoCatalog.ts';

const items: GotoItem[] = [
  { id: 'menu:reports:reports.register:Sales Register', label: 'Sales Register', group: 'Reports', description: 'Month-wise sales vouchers', screen: 'reports.register', params: { baseType: 'sales' } },
  { id: 'screen:company.about', label: 'About Bahi ERP', group: 'Screens', screen: 'company.about' },
  { id: 'cmd:date', label: 'Change working date', group: 'Commands', screen: '', command: 'date', hotkey: 'F2', keywords: ['date'] },
];
const screens = [
  { id: 'reports.register', title: 'Register' },
  { id: 'company.periodLock', title: 'Lock Books', presentation: 'dialog' as const },
];

describe('gotoCatalogSnapshot', () => {
  test('copies the palette items and the registered screens as plain JSON', () => {
    const snap = gotoCatalogSnapshot(items, screens);
    assert.deepEqual(snap.items, [
      { id: 'menu:reports:reports.register:Sales Register', label: 'Sales Register', group: 'Reports', description: 'Month-wise sales vouchers', screen: 'reports.register', params: { baseType: 'sales' }, command: null },
      { id: 'screen:company.about', label: 'About Bahi ERP', group: 'Screens', description: null, screen: 'company.about', params: null, command: null },
      { id: 'cmd:date', label: 'Change working date', group: 'Commands', description: null, screen: '', params: null, command: 'date' },
    ]);
    assert.deepEqual(snap.screens, [
      { id: 'reports.register', title: 'Register', presentation: 'full' },
      { id: 'company.periodLock', title: 'Lock Books', presentation: 'dialog' },
    ]);
    // Survives structured cloning / JSON (page.evaluate returns it to the spec).
    assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
  });

  test('params are copied, not shared with the palette', () => {
    const snap = gotoCatalogSnapshot(items, []);
    (snap.items[0].params as Record<string, unknown>).baseType = 'purchase';
    assert.equal(items[0].params?.baseType, 'sales');
  });
});

describe('answerGotoCatalogRequest', () => {
  const build = () => gotoCatalogSnapshot(items, screens);

  test('fills detail.catalog of a request event', () => {
    const detail: { catalog?: unknown } = {};
    const ev = new CustomEvent(GOTO_CATALOG_EVENT, { detail });
    assert.equal(answerGotoCatalogRequest(ev, build), true);
    assert.equal((detail.catalog as { items: unknown[] }).items.length, 3);
  });

  test('ignores other events and requests without an object detail', () => {
    let built = 0;
    const counting = () => {
      built++;
      return build();
    };
    assert.equal(answerGotoCatalogRequest(new CustomEvent('something-else', { detail: {} }), counting), false);
    assert.equal(answerGotoCatalogRequest(new CustomEvent(GOTO_CATALOG_EVENT, { detail: null }), counting), false);
    assert.equal(answerGotoCatalogRequest(new CustomEvent(GOTO_CATALOG_EVENT, { detail: [] }), counting), false);
    assert.equal(answerGotoCatalogRequest(new CustomEvent(GOTO_CATALOG_EVENT, { detail: 'x' }), counting), false);
    assert.equal(answerGotoCatalogRequest(new Event(GOTO_CATALOG_EVENT), counting), false);
    assert.equal(built, 0, 'nothing is computed for a request it does not answer');
  });
});
