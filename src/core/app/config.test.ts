import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AppConfigStore, DEFAULT_APP_CONFIG } from './config.ts';
import { createLogger, redact } from './logger.ts';

let dir: string;
const logs: Array<{ level: string; message: string; meta?: unknown }> = [];
const log = (level: string, message: string, meta?: unknown) => {
  logs.push({ level, message, meta });
};
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bahi-config-'));
  logs.length = 0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('AppConfigStore', () => {
  it('starts with defaults and the default data folder', () => {
    const s = new AppConfigStore(dir, path.join(dir, 'Data'), log);
    assert.deepEqual(s.get(), DEFAULT_APP_CONFIG);
    assert.equal(s.dataDir, path.join(dir, 'Data'));
    assert.equal(fs.existsSync(s.file), false, 'nothing written until changed');
  });

  it('persists updates atomically and reloads them', () => {
    const s = new AppConfigStore(dir, path.join(dir, 'Data'), log);
    s.update({ dataDir: path.join(dir, 'Elsewhere'), theme: 'dark', firstRunComplete: true });
    s.noteOpened('a-1');
    s.noteOpened('b-2');
    s.noteOpened('a-1');
    const again = new AppConfigStore(dir, path.join(dir, 'Data'), log);
    assert.deepEqual(again.get(), {
      dataDir: path.join(dir, 'Elsewhere'),
      firstRunComplete: true,
      theme: 'dark',
      recentCompanyIds: ['a-1', 'b-2'],
      lastCompanyId: 'a-1',
    });
    assert.equal(again.dataDir, path.join(dir, 'Elsewhere'));
    again.forget('a-1');
    assert.deepEqual(again.get().recentCompanyIds, ['b-2']);
    assert.equal(again.get().lastCompanyId, null);
    assert.deepEqual(fs.readdirSync(dir), ['config.json'], 'no temp files left behind');
  });

  it('backs up a corrupt file and starts fresh', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), '{"dataDir": "/x", oops');
    const s = new AppConfigStore(dir, path.join(dir, 'Data'), log);
    assert.deepEqual(s.get(), DEFAULT_APP_CONFIG);
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^config\.json\.corrupt-/);
    assert.equal(logs[0]?.level, 'warn');
  });

  it('does not discard a config that is only temporarily unreadable (regression)', () => {
    // A directory in place of the file makes reads fail with EISDIR — stands in for a sharing violation.
    const file = path.join(dir, 'config.json');
    fs.mkdirSync(file);
    const s = new AppConfigStore(dir, path.join(dir, 'Data'), log);
    assert.deepEqual(s.get(), DEFAULT_APP_CONFIG);
    assert.ok(fs.statSync(file).isDirectory(), 'not renamed away as "corrupt"');
    assert.doesNotThrow(() => s.update({ theme: 'dark' }));
    assert.equal(s.get().theme, 'dark', 'kept in memory');
    assert.ok(fs.statSync(file).isDirectory(), 'not overwritten');
    // Once readable again, the next change is applied on top of the stored values.
    fs.rmdirSync(file);
    fs.writeFileSync(file, JSON.stringify({ dataDir: path.join(dir, 'Chosen'), firstRunComplete: true }));
    s.update({ theme: 'light' });
    const again = new AppConfigStore(dir, path.join(dir, 'Data'), log);
    assert.equal(again.dataDir, path.join(dir, 'Chosen'), 'chosen data folder survived');
    assert.equal(again.get().theme, 'light');
  });

  it('ignores invalid field values', () => {
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ dataDir: 'relative/path', theme: 'neon', recentCompanyIds: ['a', 1, 'a', 'b'], firstRunComplete: 'yes' }),
    );
    const s = new AppConfigStore(dir, path.join(dir, 'Data'), log);
    assert.deepEqual(s.get(), { ...DEFAULT_APP_CONFIG, recentCompanyIds: ['a', 'b'] });
  });
});

describe('logger', () => {
  it('writes JSON lines with secrets redacted', () => {
    const logger = createLogger({ dir, now: () => new Date('2026-04-15T00:00:00Z') });
    logger.log('info', 'Login', { username: 'meera', password: 'hunter2', nested: { apiToken: 't', ok: 1 } });
    logger.log('debug', 'hidden at info level');
    const lines = fs.readFileSync(path.join(dir, 'bahi.log'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.deepEqual(entry, {
      ts: '2026-04-15T00:00:00.000Z',
      level: 'info',
      msg: 'Login',
      meta: { username: 'meera', password: '[redacted]', nested: { apiToken: '[redacted]', ok: 1 } },
    });
  });

  it('rotates by size and keeps 3 old files', () => {
    const logger = createLogger({ dir, maxBytes: 200, keep: 3 });
    for (let i = 0; i < 40; i++) logger.log('info', `line ${i} ${'x'.repeat(40)}`);
    const files = fs.readdirSync(dir).sort();
    assert.deepEqual(files, ['bahi.log', 'bahi.log.1', 'bahi.log.2', 'bahi.log.3']);
    for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size <= 200);
    assert.match(fs.readFileSync(path.join(dir, 'bahi.log'), 'utf8'), /line 39/);
  });

  it('serialises errors and never throws', () => {
    const e = new Error('boom', { cause: { secret: 's' } });
    const r = redact({ error: e }) as { error: { message: string; stack: string; cause: unknown } };
    assert.equal(r.error.message, 'boom');
    assert.match(r.error.stack, /boom/);
    assert.deepEqual(r.error.cause, { secret: '[redacted]' });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const logger = createLogger({ dir: path.join(dir, 'logs') });
    assert.doesNotThrow(() => logger.log('error', 'cyclic', cyclic));
  });
});
