import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, DEFAULT_FEATURES } from '../../../../shared/settings.ts';
import type { CompanyConfig } from '../../../../shared/settings.ts';
import { searchSettings, SETTINGS_INDEX, settingStatus, visibleSettings } from './settingsIndex.ts';
import type { SettingsFacts, SettingsViewer } from './settingsIndex.ts';

const modulesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Screen ids registered by the module index files (static `id: '…'` entries of `screens`). */
function registeredScreens(): Set<string> {
  const ids = new Set<string>();
  for (const m of readdirSync(modulesDir, { withFileTypes: true })) {
    if (!m.isDirectory()) continue;
    let src: string;
    try {
      src = readFileSync(path.join(modulesDir, m.name, 'index.ts'), 'utf8');
    } catch {
      continue;
    }
    for (const x of src.matchAll(/\bid:\s*'([a-z]+\.[A-Za-z.]+)'/g)) ids.add(x[1]);
  }
  return ids;
}

/**
 * Screens of 2.0 packages that land separately ('accounts.numbering' — the Invoice Numbering screen,
 * WP-07). Until registered the hub hides the row (nav.isRegistered); the integration step empties this.
 */
const PENDING_SCREENS: ReadonlySet<string> = new Set(['accounts.numbering']);

const everything: SettingsViewer = { canOpen: () => true, gstEnabled: true, secured: true };

describe('Settings hub index', () => {
  test('topics and their screens follow the 2.0 build spec (§3.5), in order', () => {
    assert.deepEqual(
      SETTINGS_INDEX.map((c) => c.title),
      ['Business', 'Invoices & printing', 'GST & TDS', 'Banking & cheques', 'Users & security', 'Data & backup', 'Modules', 'Appearance', 'About & updates'],
    );
    const screens = (id: string) => SETTINGS_INDEX.find((c) => c.id === id)?.rows.map((r) => r.screen);
    assert.deepEqual(screens('business'), ['company.profile', 'company.features', 'company.config']);
    assert.deepEqual(screens('invoices'), ['print.settings', 'accounts.numbering', 'accounts.voucherTypes']);
    assert.deepEqual(screens('gst'), ['company.config', 'tds.setup']);
    assert.deepEqual(SETTINGS_INDEX.find((c) => c.id === 'gst')?.rows[0].params, { tab: 'gst' });
    assert.deepEqual(screens('banking'), ['cheques.bank', 'cheques.books', 'cheques.payees']);
    assert.deepEqual(screens('security'), ['security.users', 'security.settings', 'company.periodLock', 'company.changePassword']);
    assert.deepEqual(screens('data'), ['data.backup', 'company.config', 'data.restore', 'data.import', 'data.xmlImport', 'data.export', 'data.xmlExport']);
    assert.deepEqual(screens('modules'), ['pos.settings', 'forex.settings']);
    assert.deepEqual(screens('appearance'), []);
    assert.equal(SETTINGS_INDEX.find((c) => c.id === 'appearance')?.inline, 'appearance');
    assert.equal(SETTINGS_INDEX.find((c) => c.id === 'data')?.inline, 'dataFolder');
    assert.deepEqual(screens('about'), ['company.about']);
  });

  test("every row's screen id is registered by a module (pending 2.0 screens aside)", () => {
    const registered = registeredScreens();
    assert.ok(registered.size > 150, `only ${registered.size} screens scanned`);
    assert.ok(registered.has('company.settings'), 'the hub itself is registered');
    const missing = SETTINGS_INDEX.flatMap((c) => c.rows)
      .map((r) => r.screen)
      .filter((s) => !registered.has(s) && !PENDING_SCREENS.has(s));
    assert.deepEqual(missing, []);
  });

  test('row ids are unique; rows never point at the hub itself', () => {
    const rows = SETTINGS_INDEX.flatMap((c) => c.rows);
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
    assert.ok(rows.every((r) => r.screen !== 'company.settings'));
  });

  test('the hub has its menu item (Company section, first) and is in Go To', () => {
    const src = readFileSync(path.join(modulesDir, 'company', 'index.ts'), 'utf8');
    assert.match(src, /\{ section: 'company', label: 'Settings', screen: 'company\.settings', order: 5, keywords: \['preferences', 'options', 'setup'\], description: 'Every setting in one place' \}/);
    assert.match(src, /\{ id: 'company\.settings', title: 'Settings', component: SettingsScreen, goto: true/);
  });
});

describe('Settings hub screen wiring (SettingsScreen.tsx)', () => {
  const src = readFileSync(path.join(modulesDir, 'company', 'SettingsScreen.tsx'), 'utf8');

  test('rows are gated by nav.isRegistered && nav.canOpen, and search only sees the visible topics', () => {
    assert.match(src, /visibleSettings\(SETTINGS_INDEX, \{ canOpen: \(id\) => nav\.isRegistered\(id\) && nav\.canOpen\(id\), gstEnabled: company\.gstEnabled, secured \}\)/);
    assert.match(src, /searchSettings\(categories, query\)/);
    assert.ok(!/searchSettings\(SETTINGS_INDEX/.test(src), 'searching the whole index would list hidden settings');
  });

  test('each row opens its screen with nav.push (the hub embeds no settings form, D8)', () => {
    assert.match(src, /const open = \(row: SettingsRow\) => nav\.push\(row\.screen, row\.params \?\? \{\}\)/);
    for (const embedded of ['ConfigScreen', 'FeaturesScreen', 'CompanyProfileScreen', 'PrintSettingsScreen']) assert.ok(!src.includes(embedded), `${embedded} embedded`);
  });

  test('keyboard: search box focused on open, Ctrl+F returns to it, the chosen topic is the Tab stop, typing in a list searches', () => {
    assert.match(src, /data-autofocus=""/);
    assert.match(src, /key: 'Ctrl\+F', label: 'Search', icon: 'search', onClick: \(\) => searchRef\.current\?\.focus\(\)/);
    assert.match(src, /data-roving-active=\{c\.id === current\?\.id \? '' : undefined\}/);
    assert.match(src, /const onCatsKey = [^]*?if \(typeToSearch\(e\)\) return;/);
    assert.match(src, /const onRowsKey = [^]*?if \(typeToSearch\(e\)\) return;/);
  });
});

describe('visibleSettings', () => {
  test('everything allowed: every topic', () => {
    assert.equal(visibleSettings(SETTINGS_INDEX, everything).length, SETTINGS_INDEX.length);
  });

  test('a row shows only when its screen may be opened; a topic with nothing left is hidden (F11 off ⇒ no trace)', () => {
    const off = new Set(['pos.settings', 'forex.settings', 'cheques.bank', 'cheques.books', 'tds.setup']);
    const cats = visibleSettings(SETTINGS_INDEX, { ...everything, canOpen: (id) => !off.has(id) });
    assert.ok(!cats.some((c) => c.id === 'modules'), 'POS and multi-currency off: no Modules topic');
    assert.deepEqual(cats.find((c) => c.id === 'banking')?.rows.map((r) => r.id), ['payees']);
    assert.deepEqual(cats.find((c) => c.id === 'gst')?.rows.map((r) => r.id), ['gstConfig']);
    assert.ok(cats.flatMap((c) => c.rows).every((r) => !off.has(r.screen)));
  });

  test('GST settings only with GST on; Change password only for a signed-in user of a protected company', () => {
    const plain = visibleSettings(SETTINGS_INDEX, { ...everything, gstEnabled: false, secured: false, canOpen: (id) => id !== 'tds.setup' });
    assert.ok(!plain.some((c) => c.id === 'gst'), 'no GST, no TDS: no GST & TDS topic');
    assert.ok(!plain.flatMap((c) => c.rows).some((r) => r.id === 'password'));
    assert.ok(visibleSettings(SETTINGS_INDEX, everything).flatMap((c) => c.rows).some((r) => r.id === 'password'));
  });

  test('a viewer who may open nothing still has Appearance (per-user, no screen)', () => {
    assert.deepEqual(
      visibleSettings(SETTINGS_INDEX, { canOpen: () => false, gstEnabled: true, secured: true }).map((c) => c.id),
      ['appearance'],
    );
  });

  test('the Invoice Numbering screen not registered yet: its row is hidden, the topic stays', () => {
    const cats = visibleSettings(SETTINGS_INDEX, { ...everything, canOpen: (id) => id !== 'accounts.numbering' });
    assert.deepEqual(cats.find((c) => c.id === 'invoices')?.rows.map((r) => r.id), ['printing', 'voucherTypes']);
  });
});

describe('searchSettings (Ctrl+F)', () => {
  const cats = visibleSettings(SETTINGS_INDEX, everything);
  const ids = (q: string) => searchSettings(cats, q).map((m) => m.row.id);

  test('matches titles, descriptions, keywords, keys and topic names; every word must match', () => {
    assert.deepEqual(ids('logo'), ['profile', 'printing']);
    assert.deepEqual(ids('invoice number'), ['numbering', 'voucherTypes'], 'the simple screen first, the expert one after');
    assert.deepEqual(ids('PREFIX'), ['numbering', 'voucherTypes']);
    assert.deepEqual(ids('f11'), ['features']);
    assert.ok(ids('backup').includes('backup') && ids('backup').includes('backupSettings'));
    assert.deepEqual(ids('gstin'), ['profile']);
    assert.ok(ids('banking').length >= 3, 'the topic name matches its rows');
  });

  test('blank query: nothing (the selected topic shows instead); no match: empty', () => {
    assert.deepEqual(ids('   '), []);
    assert.deepEqual(ids('zzzz'), []);
  });

  test('only what the viewer sees is searched', () => {
    const limited = visibleSettings(SETTINGS_INDEX, { ...everything, canOpen: (id) => id !== 'print.settings' });
    assert.deepEqual(searchSettings(limited, 'logo').map((m) => m.row.id), ['profile']);
  });
});

describe('settingStatus', () => {
  const config: CompanyConfig = structuredClone(DEFAULT_CONFIG);
  const facts: SettingsFacts = { companyName: 'Sharma Traders', gstin: '27AAPFU0939F1ZV', features: { ...DEFAULT_FEATURES }, config };

  test('one line from data already loaded', () => {
    assert.equal(settingStatus('profile', facts), 'Sharma Traders · GSTIN 27AAPFU0939F1ZV');
    assert.equal(settingStatus('profile', { ...facts, gstin: null }), 'Sharma Traders');
    assert.match(settingStatus('features', facts) ?? '', /^\d+ features? on$/);
    assert.equal(settingStatus('printing', facts), 'Modern template');
    assert.equal(settingStatus('securitySettings', facts), 'Password protection off');
    assert.equal(settingStatus('securitySettings', { ...facts, features: { ...facts.features, security: true } }), 'Password protection on');
    assert.equal(settingStatus('periodLock', facts), 'Not locked');
    assert.equal(settingStatus('periodLock', { ...facts, config: { ...config, lockedUpTo: '2026-03-31' } }), 'Locked up to 31-Mar-2026');
    assert.equal(settingStatus('backupSettings', facts), 'No backup folder chosen');
    assert.equal(settingStatus('backupSettings', { ...facts, config: { ...config, backup: { auto: true, keepLast: 10, folder: 'D:\\Backups' } } }), 'Automatic · keeps the last 10');
    assert.equal(settingStatus('backupSettings', { ...facts, config: { ...config, backup: { auto: false, keepLast: 10, folder: 'D:\\Backups' } } }), 'Automatic backups off');
  });

  test('features count ignores password protection; nothing said while the configuration loads or for other rows', () => {
    const none = Object.fromEntries(Object.keys(DEFAULT_FEATURES).map((k) => [k, false])) as unknown as SettingsFacts['features'];
    assert.equal(settingStatus('features', { ...facts, features: { ...none, security: true } }), '0 features on');
    assert.equal(settingStatus('features', { ...facts, features: { ...none, inventory: true } }), '1 feature on');
    const loading = { ...facts, config: undefined };
    assert.equal(settingStatus('printing', loading), null);
    assert.equal(settingStatus('periodLock', loading), null);
    assert.equal(settingStatus('backupSettings', loading), null);
    assert.equal(settingStatus('users', facts), null);
  });
});
