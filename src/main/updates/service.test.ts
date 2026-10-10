import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { UpdatePolicy, UpdateStatus } from '../../shared/bridge.ts';
import { resolveUpdatePolicy } from './policy.ts';
import { createUpdateService, describeUpdateError, FIRST_CHECK_DELAY_MS, INSTALL_GRACE_MS, menuCheckMessage, MESSAGES, RECHECK_INTERVAL_MS } from './service.ts';
import type { StoredUpdatePrefs, UpdateOffer, UpdaterPort, UpdaterSettings, UpdateServiceDeps } from './service.ts';

interface FakeUpdater extends UpdaterPort {
  settings: UpdaterSettings | null;
  checks: number;
  downloads: number;
  installs: boolean[];
  nextCheck: () => Promise<{ available: boolean; offer: UpdateOffer } | null>;
  nextDownload: (progress: (p: { percent: number; bytesPerSecond: number }) => void) => Promise<void>;
}

function fakeUpdater(): FakeUpdater {
  const f: FakeUpdater = {
    settings: null,
    checks: 0,
    downloads: 0,
    installs: [],
    nextCheck: async () => ({ available: false, offer: { version: '2.0.0', releaseDate: '2026-10-01T00:00:00.000Z', releaseNotes: '', sizeBytes: 0 } }),
    nextDownload: async () => undefined,
    configure(settings) {
      f.settings = settings;
    },
    check() {
      f.checks++;
      return f.nextCheck();
    },
    download(progress) {
      f.downloads++;
      return f.nextDownload(progress);
    },
    quitAndInstall(runAfter) {
      f.installs.push(runAfter);
    },
  };
  return f;
}

const OFFER: UpdateOffer = {
  version: '2.1.0',
  releaseDate: '2026-10-08T10:00:00.000Z',
  releaseNotes: '<h2>New</h2><p>Faster &amp; <script>alert(1)</script>calmer</p>',
  sizeBytes: 98_765_432,
};

interface Harness {
  deps: UpdateServiceDeps;
  updater: FakeUpdater;
  events: UpdateStatus[];
  order: string[];
  allow: ((url: string) => boolean) | null;
  editHeaders: ((headers: Record<string, string>) => Record<string, string>) | null;
  redirects: Array<[string, string]>;
  permissionsDenied: boolean;
  loads: number;
  sessions: number;
  timers: Map<number, { fn: () => void; ms: number }>;
  stored: StoredUpdatePrefs | undefined;
  quits: Array<{ skipPrompt: boolean }>;
  logs: string[];
  dirty: boolean;
  confirmAnswer: boolean;
  confirms: number;
  now: Date;
  fireTimer(): number;
}

function harness(options: { policy?: Partial<Parameters<typeof resolveUpdatePolicy>[0]>; stored?: StoredUpdatePrefs; current?: string } = {}): Harness {
  let seq = 0;
  const h: Harness = {
    deps: undefined as unknown as UpdateServiceDeps,
    updater: fakeUpdater(),
    events: [],
    order: [],
    allow: null,
    editHeaders: null,
    redirects: [],
    permissionsDenied: false,
    loads: 0,
    sessions: 0,
    timers: new Map(),
    stored: options.stored,
    quits: [],
    logs: [],
    dirty: false,
    confirmAnswer: true,
    confirms: 0,
    now: new Date('2026-10-10T12:00:00.000Z'),
    fireTimer() {
      const [id, t] = [...h.timers.entries()][0];
      h.timers.delete(id);
      t.fn();
      return t.ms;
    },
  };
  h.deps = {
    currentVersion: options.current ?? '2.0.0',
    policyFor: (userPref): UpdatePolicy => resolveUpdatePolicy({ env: {}, policyFile: undefined, packaged: true, ...options.policy, userPref }),
    prefs: {
      get: () => h.stored,
      set: (next) => {
        h.stored = next;
      },
    },
    loadUpdater: () => {
      h.loads++;
      h.order.push('load');
      return h.updater;
    },
    session: () => {
      h.sessions++;
      h.order.push('session');
      return {
        onBeforeRequest: (allow) => {
          h.allow = allow;
        },
        onBeforeSendHeaders: (edit) => {
          h.editHeaders = edit;
        },
        onBeforeRedirect: (listener) => {
          listener('https://github.com/JayPanchani1054/billing/releases/download/v2.1.0/latest.yml', 'https://release-assets.githubusercontent.com/x');
          h.redirects.push(['seen', 'seen']);
        },
        denyPermissions: () => {
          h.permissionsDenied = true;
        },
      };
    },
    emit: (s) => {
      h.events.push(s);
    },
    log: (_level, message) => {
      h.logs.push(message);
    },
    now: () => h.now,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      h.timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => {
      h.timers.delete(id as number);
    },
    hasUnsavedWork: () => h.dirty,
    confirmDiscard: async () => {
      h.confirms++;
      return h.confirmAnswer;
    },
    requestQuit: (o) => {
      h.quits.push(o);
    },
  };
  return h;
}

async function readyService(h: Harness) {
  h.updater.nextCheck = async () => ({ available: true, offer: OFFER });
  const s = createUpdateService(h.deps);
  await s.check();
  await s.download();
  assert.equal(s.status().state, 'ready');
  return s;
}

describe('update service — network silence', () => {
  it('policy off (test run): unavailable, nothing loaded, no session, no timers, no network on check/download', async () => {
    const h = harness({ policy: { env: { PEVQORI_E2E: '1' } } });
    const s = createUpdateService(h.deps);
    assert.deepEqual(s.status(), {
      state: 'unavailable',
      reason: 'Updates are turned off for this test run.',
      policy: { mode: 'off', locked: true, source: 'env', reason: 'Updates are turned off for this test run.' },
      current: '2.0.0',
    });
    s.start();
    assert.equal(h.timers.size, 0);
    assert.equal((await s.check()).state, 'unavailable');
    assert.equal((await s.download()).state, 'unavailable');
    await assert.rejects(s.install('now'), /no downloaded update/);
    assert.throws(() => s.setMode('weekly'), (e: { code?: string }) => e.code === 'FORBIDDEN');
    s.beforeExit();
    assert.equal(h.loads, 0);
    assert.equal(h.sessions, 0);
    assert.equal(s.loaded, false);
    assert.equal(h.stored, undefined, 'nothing written');
  });

  it('unpackaged: unavailable with "only in the installed app"', () => {
    const h = harness({ policy: { packaged: false } });
    const s = createUpdateService(h.deps);
    const st = s.status();
    assert.equal(st.state, 'unavailable');
    assert.equal(st.state === 'unavailable' && st.reason, 'Updates are available only in the installed app.');
  });

  it('manual (default): idle; start() schedules nothing; the updater is loaded only by the user\'s check', async () => {
    const h = harness();
    const s = createUpdateService(h.deps);
    assert.deepEqual(s.status(), { state: 'idle', current: '2.0.0', lastCheck: null, policy: { mode: 'manual', locked: false, source: 'user', reason: null } });
    s.start();
    assert.equal(h.timers.size, 0);
    assert.equal(h.loads, 0);
    await s.check();
    assert.equal(h.loads, 1);
    assert.equal(h.updater.checks, 1);
  });

  it('hardens the updater session before loading the library, and configures it safely', async () => {
    const h = harness();
    const s = createUpdateService(h.deps);
    await s.check();
    assert.deepEqual(h.order, ['session', 'load']);
    assert.equal(h.permissionsDenied, true);
    assert.deepEqual(h.updater.settings, { autoDownload: false, autoInstallOnAppQuit: false, allowDowngrade: false, allowPrerelease: false, disableWebInstaller: true });
    assert.ok(h.allow);
    assert.equal(h.allow('https://github.com/JayPanchani1054/billing/releases.atom'), true);
    assert.equal(h.allow('https://github.com.evil.example/JayPanchani1054/billing/releases.atom'), false);
    assert.equal(h.allow('http://objects.githubusercontent.com/x'), false);
    assert.ok(h.logs.some((l) => l.includes('blocked a request')));
    assert.ok(h.logs.some((l) => l.includes('redirect')));
    // Loaded once, whatever happens next.
    await s.check();
    assert.equal(h.loads, 1);
    assert.equal(h.sessions, 1);
  });

  it('strips the library\'s per-install identifier header from every updater request (nothing identifying is sent)', async () => {
    const h = harness();
    const s = createUpdateService(h.deps);
    assert.equal(h.sessions, 0, 'nothing before the first check');
    await s.check();
    const edit = h.editHeaders as ((headers: Record<string, string>) => Record<string, string>) | null;
    assert.ok(edit, 'the header filter is installed with the session hardening, before the library loads');
    // electron-updater sends a random UUID persisted in <userData>/.updaterId with every feed / latest.yml request.
    const sent = { 'User-Agent': 'electron-builder', Accept: 'application/xml', 'x-user-staging-id': '1f0c2a4e-1111-5222-8333-944445555666' };
    assert.deepEqual(edit(sent), { 'User-Agent': 'electron-builder', Accept: 'application/xml' });
    assert.deepEqual(edit({ 'X-User-Staging-Id': 'abc', 'Cache-Control': 'no-cache' }), { 'Cache-Control': 'no-cache' });
    assert.equal(sent['x-user-staging-id'], '1f0c2a4e-1111-5222-8333-944445555666', 'the input object is not mutated');
  });

  it('weekly: first check 2 minutes after start, then every 24 h only when due', async () => {
    const h = harness({ stored: { mode: 'weekly', lastCheck: null } });
    const s = createUpdateService(h.deps);
    assert.equal(h.loads, 0, 'nothing on the start-up path');
    s.start();
    assert.equal(h.loads, 0);
    assert.equal(h.timers.size, 1);
    assert.equal(h.fireTimer(), FIRST_CHECK_DELAY_MS);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.updater.checks, 1);
    assert.equal(h.stored?.lastCheck, h.now.toISOString());
    // Next tick: 24 h later, but the last check is fresh → no network.
    assert.equal(h.fireTimer(), RECHECK_INTERVAL_MS);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.updater.checks, 1);
    // A week later it is due again.
    h.now = new Date(h.now.getTime() + 7 * 24 * 3600 * 1000);
    h.fireTimer();
    await new Promise((r) => setImmediate(r));
    assert.equal(h.updater.checks, 2);
    s.stop();
    assert.equal(h.timers.size, 0);
  });

  it('weekly but checked 2 days ago: the 2-minute tick does not touch the network', async () => {
    const h = harness({ stored: { mode: 'weekly', lastCheck: '2026-10-08T12:00:00.000Z' } });
    const s = createUpdateService(h.deps);
    s.start();
    h.fireTimer();
    await new Promise((r) => setImmediate(r));
    assert.equal(h.loads, 0);
  });
});

describe('update service — state machine', () => {
  it('check → available (plain-text notes, size) and emits checking first', async () => {
    const h = harness();
    h.updater.nextCheck = async () => ({ available: true, offer: OFFER });
    const s = createUpdateService(h.deps);
    const st = await s.check();
    assert.deepEqual(
      h.events.map((e) => e.state),
      ['checking', 'available'],
    );
    assert.equal(st.state, 'available');
    if (st.state !== 'available') return;
    assert.equal(st.version, '2.1.0');
    assert.equal(st.notes, 'New\n\nFaster & calmer');
    assert.equal(st.sizeBytes, 98_765_432);
    assert.equal(st.releaseDate, OFFER.releaseDate);
  });

  it('check → up-to-date (also when the feed offers an older or equal version: no downgrade)', async () => {
    for (const offer of [{ ...OFFER, version: '2.0.0' }, { ...OFFER, version: '1.9.0' }, { ...OFFER, version: 'junk' }]) {
      const h = harness();
      h.updater.nextCheck = async () => ({ available: true, offer });
      const s = createUpdateService(h.deps);
      const st = await s.check();
      assert.equal(st.state, 'up-to-date', offer.version);
    }
  });

  it('a check while one runs reuses it (one network check)', async () => {
    const h = harness();
    let release!: () => void;
    h.updater.nextCheck = () =>
      new Promise((resolve) => {
        release = () => resolve({ available: false, offer: OFFER });
      });
    const s = createUpdateService(h.deps);
    const a = s.check();
    const b = s.check();
    release();
    assert.equal(await a, await b);
    assert.equal(h.updater.checks, 1);
  });

  it('download: progress events (throttled), then ready', async () => {
    const h = harness();
    h.updater.nextCheck = async () => ({ available: true, offer: OFFER });
    h.updater.nextDownload = async (progress) => {
      for (const percent of [0.2, 0.4, 10.1, 10.9, 55, 100]) progress({ percent, bytesPerSecond: 1_000_000 });
    };
    const s = createUpdateService(h.deps);
    await s.check();
    h.events.length = 0;
    const st = await s.download();
    assert.deepEqual(
      h.events.map((e) => (e.state === 'downloading' ? `d${Math.floor(e.percent)}` : e.state)),
      ['d0', 'd10', 'd55', 'd100', 'ready'],
    );
    assert.deepEqual(st, { state: 'ready', current: '2.0.0', version: '2.1.0', notes: 'New\n\nFaster & calmer', installOnQuit: false, policy: s.status().policy });
  });

  it('download before an offer is refused', async () => {
    const h = harness();
    const s = createUpdateService(h.deps);
    await assert.rejects(s.download(), /Check for updates first/);
    assert.equal(h.loads, 0);
  });

  it('a checksum or signature failure says the download was not verified; retry is possible', async () => {
    const h = harness();
    h.updater.nextCheck = async () => ({ available: true, offer: OFFER });
    h.updater.nextDownload = async () => {
      throw Object.assign(new Error('sha512 checksum mismatch, expected abc, got def'), { code: 'ERR_CHECKSUM_MISMATCH' });
    };
    const s = createUpdateService(h.deps);
    await s.check();
    const st = await s.download();
    assert.deepEqual(st, { state: 'error', current: '2.0.0', message: MESSAGES.notVerified, retryable: true, policy: s.status().policy });
    await assert.rejects(s.install('now'), /no downloaded update/);
    h.updater.nextDownload = async () => undefined;
    assert.equal((await s.download()).state, 'ready');
  });

  it('a check error is mapped and a new check is allowed', async () => {
    const h = harness();
    h.updater.nextCheck = async () => {
      throw new Error('net::ERR_INTERNET_DISCONNECTED');
    };
    const s = createUpdateService(h.deps);
    const st = await s.check();
    assert.equal(st.state === 'error' && st.message, MESSAGES.unreachable);
    assert.equal(h.stored, undefined, 'a failed check is not recorded as the last check');
    h.updater.nextCheck = async () => null;
    assert.equal((await s.check()).state, 'error');
    h.updater.nextCheck = async () => ({ available: false, offer: OFFER });
    assert.equal((await s.check()).state, 'up-to-date');
  });
});

describe('update service — install', () => {
  it('install on quit: armed; the before-exit hook starts the installer once, without relaunch', async () => {
    const h = harness();
    const s = await readyService(h);
    const st = await s.install('on-quit');
    assert.equal(st.state === 'ready' && st.installOnQuit, true);
    assert.deepEqual(h.quits, [], 'nothing quits now');
    s.beforeExit();
    s.beforeExit();
    assert.deepEqual(h.updater.installs, [false]);
  });

  it('the before-exit hook keeps the process alive briefly after starting the installer (a failed spawn is retried elevated)', async () => {
    const h = harness();
    const s = await readyService(h);
    await s.install('on-quit');
    h.timers.clear();
    let settled = false;
    const done = s.beforeExit().then(() => {
      settled = true;
    });
    assert.deepEqual(h.updater.installs, [false]);
    await Promise.resolve();
    assert.equal(settled, false, 'still waiting for the grace period');
    assert.deepEqual([...h.timers.values()].map((t) => t.ms), [INSTALL_GRACE_MS]);
    h.fireTimer();
    await done;
    assert.equal(settled, true);
    // Nothing armed: the hook resolves at once and sets no timer.
    await s.beforeExit();
    assert.equal(h.timers.size, 0);
  });

  it('restart now without unsaved work: normal quit (the close prompt still guards), then install + relaunch once', async () => {
    const h = harness();
    const s = await readyService(h);
    await s.install('now');
    assert.equal(h.confirms, 0);
    assert.deepEqual(h.quits, [{ skipPrompt: false }]);
    assert.deepEqual(h.updater.installs, []);
    s.beforeExit();
    s.beforeExit();
    assert.deepEqual(h.updater.installs, [true]);
  });

  it('restart now with unsaved work: asks; "Keep working" cancels and disarms everything', async () => {
    const h = harness();
    const s = await readyService(h);
    await s.install('on-quit');
    h.dirty = true;
    h.confirmAnswer = false;
    const st = await s.install('now');
    assert.equal(h.confirms, 1);
    assert.deepEqual(h.quits, []);
    assert.equal(st.state === 'ready' && st.installOnQuit, false);
    s.beforeExit();
    assert.deepEqual(h.updater.installs, [], 'a later normal quit installs nothing');
  });

  it('restart now with unsaved work: "Discard" quits without a second prompt and installs', async () => {
    const h = harness();
    const s = await readyService(h);
    h.dirty = true;
    await s.install('now');
    assert.deepEqual(h.quits, [{ skipPrompt: true }]);
    s.beforeExit();
    assert.deepEqual(h.updater.installs, [true]);
  });

  it('a quit that a window cancelled disarms the restart', async () => {
    const h = harness();
    const s = await readyService(h);
    await s.install('now');
    s.quitCancelled();
    assert.equal(s.status().state === 'ready' && (s.status() as { installOnQuit: boolean }).installOnQuit, false);
    s.beforeExit();
    assert.deepEqual(h.updater.installs, []);
  });

  it('nothing is installed when nothing was downloaded', async () => {
    const h = harness();
    const s = createUpdateService(h.deps);
    await assert.rejects(s.install('on-quit'), (e: { code?: string }) => e.code === 'BUSINESS_RULE');
    s.beforeExit();
    assert.equal(h.loads, 0);
  });
});

describe('update service — mode', () => {
  it('turning weekly on persists the choice and schedules the first check (no immediate network)', () => {
    const h = harness();
    const s = createUpdateService(h.deps);
    const st = s.setMode('weekly');
    assert.equal(st.policy.mode, 'weekly');
    assert.deepEqual(h.stored, { mode: 'weekly', lastCheck: null });
    assert.equal(h.timers.size, 1);
    assert.equal(h.loads, 0);
    s.setMode('manual');
    assert.equal(h.timers.size, 0);
    assert.equal(s.status().policy.mode, 'manual');
    assert.throws(() => s.setMode('off' as 'manual'), /Invalid update mode/);
  });

  it('locked by the administrator or the environment: refused with the reason', () => {
    for (const policy of [{ policyFile: { updates: { mode: 'manual' } } }, { env: { PEVQORI_UPDATES: 'weekly' } }]) {
      const h = harness({ policy });
      const s = createUpdateService(h.deps);
      assert.throws(() => s.setMode('weekly'), (e: { code?: string; message?: string }) => e.code === 'FORBIDDEN' && /Managed by/.test(e.message ?? ''));
      assert.equal(h.stored, undefined);
    }
  });

  it('an administrator weekly policy schedules checks even though the user never chose it', () => {
    const h = harness({ policy: { policyFile: { updates: { mode: 'weekly' } } } });
    createUpdateService(h.deps).start();
    assert.equal(h.timers.size, 1);
  });
});

describe('describeUpdateError / menuCheckMessage', () => {
  it('maps verification, network, blocked, disk and unknown failures', () => {
    assert.equal(describeUpdateError(Object.assign(new Error('x'), { code: 'ERR_UPDATER_INVALID_SIGNATURE' })).message, MESSAGES.notVerified);
    assert.equal(describeUpdateError(new Error('New version 2.1.0 is not signed by the application owner: X')).message, MESSAGES.notVerified);
    assert.equal(describeUpdateError(new Error('net::ERR_BLOCKED_BY_CLIENT')).message, MESSAGES.blocked);
    assert.equal(describeUpdateError(new Error('net::ERR_BLOCKED_BY_CLIENT')).retryable, false);
    assert.equal(describeUpdateError(Object.assign(new Error('404'), { statusCode: 404 })).message, MESSAGES.unreachable);
    assert.equal(describeUpdateError(Object.assign(new Error('x'), { code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' })).message, MESSAGES.unreachable);
    assert.equal(describeUpdateError(Object.assign(new Error('write failed'), { code: 'ENOSPC' })).message, MESSAGES.diskFull);
    assert.equal(describeUpdateError('weird').message, MESSAGES.generic);
    assert.equal(describeUpdateError(null).message, MESSAGES.generic);
  });

  it('summarises a status for the Help menu box', () => {
    const policy: UpdatePolicy = { mode: 'manual', locked: false, source: 'user', reason: null };
    assert.equal(menuCheckMessage({ state: 'up-to-date', current: '2.0.0', checkedAt: 'x', policy }).message, 'Pevqori 2.0.0 is up to date.');
    assert.match(menuCheckMessage({ state: 'available', current: '2.0.0', version: '2.1.0', releaseDate: '', notes: '', sizeBytes: 0, policy }).message, /2\.1\.0 is available/);
    assert.equal(menuCheckMessage({ state: 'unavailable', reason: 'R', current: '2.0.0', policy }).detail, 'R');
  });
});
