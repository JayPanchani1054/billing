// Settings of an installation made before the product rename are carried over once (legacyUserData.ts).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as coreAnchors from '../core/app/auditAnchors.ts';
import { BACKUP_FOLDERS_FILE } from '../core/app/backupFolders.ts';
import { APP_NAME } from '../shared/constants.ts';
import {
  ANCHOR_KEY_FILE,
  ANCHORS_FILE,
  BROWSER_STATE_FILE,
  legacyProfileName,
  migrateLegacyUserData,
  MIGRATED_FILES,
  SETTINGS_FILES,
  type LegacyMigrationOptions,
} from './legacyUserData.ts';

let root: string;
let opts: LegacyMigrationOptions;
let legacyDir: string;

const write = (file: string, content: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const readJson = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pevqori-legacy-'));
  const appData = path.join(root, 'AppData');
  const documents = path.join(root, 'Documents');
  opts = {
    appDataDir: appData,
    userDataDir: path.join(appData, APP_NAME),
    documentsDir: documents,
    defaultDataDir: path.join(documents, APP_NAME),
    dev: false,
    platform: 'win32',
  };
  legacyDir = path.join(appData, legacyProfileName(false));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('legacy userData migration', () => {
  it('the legacy folder names differ from the current ones', () => {
    assert.notEqual(legacyProfileName(false), APP_NAME);
    assert.equal(legacyProfileName(true), `${legacyProfileName(false)} Dev`);
  });

  it('does nothing on a fresh machine', () => {
    const r = migrateLegacyUserData(opts);
    assert.equal(r.status, 'no_legacy');
    assert.equal(fs.existsSync(opts.userDataDir), false);
  });

  it('copies every settings file once and keeps the chosen data folder; the old folder stays', () => {
    for (const f of MIGRATED_FILES) write(path.join(legacyDir, f), JSON.stringify({ file: f }));
    write(path.join(legacyDir, 'config.json'), JSON.stringify({ dataDir: path.join(root, 'D', 'Books'), firstRunComplete: true }));
    write(path.join(legacyDir, ANCHOR_KEY_FILE), JSON.stringify({ v: 1, sealed: true, key: 'c2VhbGVk' }));
    write(path.join(legacyDir, BROWSER_STATE_FILE), '{"os_crypt":{"encrypted_key":"x"}}');
    write(path.join(legacyDir, 'Cache', 'junk'), 'x');
    const r = migrateLegacyUserData(opts);
    assert.equal(r.status, 'migrated');
    assert.deepEqual([...r.copied].sort(), [...MIGRATED_FILES, BROWSER_STATE_FILE].sort());
    assert.deepEqual(r.skipped, []);
    assert.equal(r.dataDir, null, 'an explicitly chosen data folder is kept as it is');
    assert.deepEqual(readJson(path.join(opts.userDataDir, 'config.json')), { dataDir: path.join(root, 'D', 'Books'), firstRunComplete: true });
    assert.deepEqual(readJson(path.join(opts.userDataDir, ANCHOR_KEY_FILE)), { v: 1, sealed: true, key: 'c2VhbGVk' });
    assert.deepEqual(readJson(path.join(opts.userDataDir, ANCHORS_FILE)), { file: ANCHORS_FILE });
    assert.deepEqual(readJson(path.join(opts.userDataDir, BROWSER_STATE_FILE)), { os_crypt: { encrypted_key: 'x' } }, 'the sealing key travels with the sealed key');
    assert.equal(fs.existsSync(path.join(opts.userDataDir, 'Cache')), false, 'only settings files are copied');
    for (const f of MIGRATED_FILES) assert.ok(fs.existsSync(path.join(legacyDir, f)), `the old folder is left in place (${f})`);
    // Runs once: the next launch finds the new folder set up and changes nothing.
    fs.writeFileSync(path.join(legacyDir, 'config.json'), JSON.stringify({ dataDir: path.join(root, 'Other') }));
    assert.equal(migrateLegacyUserData(opts).status, 'already_set_up');
    assert.deepEqual(readJson(path.join(opts.userDataDir, 'config.json')).dataDir, path.join(root, 'D', 'Books'));
  });

  it('a key stored without OS sealing carries over with its anchors on any platform', () => {
    write(path.join(legacyDir, 'config.json'), '{}');
    write(path.join(legacyDir, ANCHOR_KEY_FILE), JSON.stringify({ v: 1, sealed: false, key: 'ab'.repeat(32) }));
    write(path.join(legacyDir, ANCHORS_FILE), '{"v":1,"anchors":{}}');
    const r = migrateLegacyUserData({ ...opts, platform: 'linux' });
    assert.deepEqual([...r.copied].sort(), ['config.json', ANCHOR_KEY_FILE, ANCHORS_FILE].sort());
    assert.equal(fs.existsSync(path.join(opts.userDataDir, BROWSER_STATE_FILE)), false);
  });

  it('a sealed key that cannot be unsealed in the new folder stays behind together with its anchors', () => {
    const seed = (): void => {
      write(path.join(legacyDir, 'config.json'), '{}');
      write(path.join(legacyDir, ANCHOR_KEY_FILE), JSON.stringify({ v: 1, sealed: true, key: 'c2VhbGVk' }));
      write(path.join(legacyDir, ANCHORS_FILE), '{"v":1,"anchors":{}}');
      write(path.join(legacyDir, BROWSER_STATE_FILE), '{"old":true}');
    };
    // Another OS: the seal is tied to the old product name.
    seed();
    let r = migrateLegacyUserData({ ...opts, platform: 'darwin' });
    assert.deepEqual(r.copied, ['config.json']);
    assert.deepEqual(r.skipped.map((s) => s.file).sort(), [ANCHOR_KEY_FILE, ANCHORS_FILE].sort());
    assert.equal(fs.existsSync(path.join(opts.userDataDir, ANCHORS_FILE)), false, 'no anchors without the key that signed them');

    // Windows, but the new folder already has its own sealing key: never overwritten.
    fs.rmSync(opts.userDataDir, { recursive: true, force: true });
    write(path.join(opts.userDataDir, BROWSER_STATE_FILE), '{"new":true}');
    r = migrateLegacyUserData(opts);
    assert.equal(r.status, 'migrated');
    assert.deepEqual(r.copied, ['config.json']);
    assert.equal(fs.readFileSync(path.join(opts.userDataDir, BROWSER_STATE_FILE), 'utf8'), '{"new":true}');
    assert.equal(fs.existsSync(path.join(opts.userDataDir, ANCHOR_KEY_FILE)), false);

    // Windows, the old folder has no sealing key.
    fs.rmSync(opts.userDataDir, { recursive: true, force: true });
    fs.rmSync(path.join(legacyDir, BROWSER_STATE_FILE));
    r = migrateLegacyUserData(opts);
    assert.deepEqual(r.copied, ['config.json']);
    assert.equal(r.skipped.length, 2);
  });

  it('anchors without their key are never copied', () => {
    write(path.join(legacyDir, 'window-state.json'), '{}');
    write(path.join(legacyDir, ANCHORS_FILE), '{"v":1,"anchors":{}}');
    const r = migrateLegacyUserData(opts);
    assert.deepEqual(r.copied, ['window-state.json']);
    assert.deepEqual(r.skipped.map((s) => s.file), [ANCHORS_FILE]);
  });

  it('settings files are the app config, backup-folder approvals, shell preferences and window state', () => {
    assert.deepEqual([...SETTINGS_FILES].sort(), ['backup-folders.json', 'config.json', 'shell-preferences.json', 'window-state.json']);
    assert.ok(SETTINGS_FILES.includes(BACKUP_FOLDERS_FILE));
    assert.equal(ANCHOR_KEY_FILE, coreAnchors.ANCHOR_KEY_FILE);
    assert.equal(ANCHORS_FILE, coreAnchors.ANCHORS_FILE);
  });

  it('never overwrites a new userData folder that already has settings', () => {
    write(path.join(legacyDir, 'config.json'), JSON.stringify({ dataDir: path.join(root, 'Old') }));
    write(path.join(legacyDir, 'audit-anchors.json'), '{"v":1,"anchors":{}}');
    write(path.join(opts.userDataDir, 'window-state.json'), '{"new":true}');
    const r = migrateLegacyUserData(opts);
    assert.equal(r.status, 'already_set_up');
    assert.equal(fs.existsSync(path.join(opts.userDataDir, 'config.json')), false);
    assert.equal(fs.readFileSync(path.join(opts.userDataDir, 'window-state.json'), 'utf8'), '{"new":true}');
  });

  it('companies in the old default data folder stay there: the new config points at it', () => {
    write(path.join(legacyDir, 'config.json'), JSON.stringify({ dataDir: null, firstRunComplete: true, lastCompanyId: 'c1' }));
    const oldDefault = path.join(opts.documentsDir, legacyProfileName(false));
    write(path.join(oldDefault, 'companies', 'c1', 'company.db'), 'db');
    const r = migrateLegacyUserData(opts);
    assert.equal(r.status, 'migrated');
    assert.equal(r.dataDir, oldDefault);
    assert.deepEqual(readJson(path.join(opts.userDataDir, 'config.json')), { dataDir: oldDefault, firstRunComplete: true, lastCompanyId: 'c1' });
    assert.ok(fs.existsSync(path.join(oldDefault, 'companies', 'c1', 'company.db')), 'company data is never moved');
  });

  it('keeps the new default data folder when it already exists', () => {
    write(path.join(legacyDir, 'config.json'), JSON.stringify({ firstRunComplete: true }));
    fs.mkdirSync(path.join(opts.documentsDir, legacyProfileName(false)), { recursive: true });
    fs.mkdirSync(opts.defaultDataDir, { recursive: true });
    const r = migrateLegacyUserData(opts);
    assert.equal(r.dataDir, null);
    assert.deepEqual(readJson(path.join(opts.userDataDir, 'config.json')), { firstRunComplete: true });
  });

  it('unpackaged runs use the "Dev" profiles on both sides', () => {
    const dev = { ...opts, dev: true, userDataDir: path.join(opts.appDataDir, `${APP_NAME} Dev`) };
    write(path.join(opts.appDataDir, legacyProfileName(true), 'config.json'), '{}');
    write(path.join(legacyDir, 'config.json'), '{"packaged":true}');
    assert.equal(migrateLegacyUserData(dev).status, 'migrated');
    assert.deepEqual(readJson(path.join(dev.userDataDir, 'config.json')), {});
  });
});
