import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createPrefsStore, parseUpdatePrefs } from './prefs.ts';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pevqori-prefs-'));
}

describe('shell preferences — update choice (2.0)', () => {
  it('validates the stored update choice', () => {
    assert.deepEqual(parseUpdatePrefs({ mode: 'weekly', lastCheck: '2026-10-01T10:00:00.000Z' }), { mode: 'weekly', lastCheck: '2026-10-01T10:00:00.000Z' });
    assert.deepEqual(parseUpdatePrefs({ mode: 'manual', lastCheck: 'yesterday' }), { mode: 'manual', lastCheck: null });
    for (const junk of [null, 'weekly', [], { mode: 'off' }, { mode: 'WEEKLY' }, {}]) assert.equal(parseUpdatePrefs(junk), undefined);
  });

  it('saves and reloads the update choice next to the zoom, and keeps the zoom when only updates change', () => {
    const dir = tmp();
    try {
      const a = createPrefsStore(dir);
      assert.equal(a.get().updates, undefined);
      a.update({ zoom: 1.2 });
      a.update({ updates: { mode: 'weekly', lastCheck: null } });
      a.update({ updates: { mode: 'weekly', lastCheck: '2026-10-10T12:00:00.000Z' } });
      const b = createPrefsStore(dir);
      assert.deepEqual(b.get(), { zoom: 1.2, updates: { mode: 'weekly', lastCheck: '2026-10-10T12:00:00.000Z' } });
      b.update({ zoom: 1 });
      assert.deepEqual(createPrefsStore(dir).get(), { zoom: 1, updates: { mode: 'weekly', lastCheck: '2026-10-10T12:00:00.000Z' } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a tampered file falls back to the defaults (manual updates)', () => {
    const dir = tmp();
    try {
      fs.writeFileSync(path.join(dir, 'shell-preferences.json'), JSON.stringify({ zoom: 9, updates: { mode: 'always' } }));
      assert.deepEqual(createPrefsStore(dir).get(), { zoom: 1.5 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
