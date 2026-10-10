/**
 * Lazy feature screens (SPEC WP-03, docs/ARCHITECTURE.md §9a).
 *
 * 1. The load-once helpers behind `lazyScreen()` (lib/lazyLoader.ts): one import per screen however
 *    often it renders or is prefetched, a failed load remembered until "Try again", idle prefetch one
 *    chunk per slot.
 * 2. The wiring, read from source (module index files and lazyScreen.tsx import React, so node cannot
 *    load them): which modules are lazy, what must stay eager, every lazy file really leaves the start-up
 *    bundle (no eager static import of it), and the Essentials screens are prefetched.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESSENTIALS } from './lib/essentials.ts';
import { browserIdleScheduler, createLazyLoader, PREFETCH_IDLE_TIMEOUT_MS, retryFailedLoads, runWhenIdle } from './lib/lazyLoader.ts';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.resolve(appDir, '..');
const modulesDir = path.join(rendererDir, 'modules');
const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');

/** Let pending promise callbacks run. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ───────────────────────────── 1. Helpers ─────────────────────────────

describe('createLazyLoader', () => {
  test('loads once: every load() (render, prefetch, re-open) shares one import', async () => {
    let calls = 0;
    const d = deferred<string>();
    const loader = createLazyLoader(() => {
      calls++;
      return d.promise;
    });
    assert.equal(loader.peek().status, 'idle');
    assert.equal(calls, 0, 'nothing is fetched before the first load');
    const p1 = loader.load();
    const p2 = loader.load();
    assert.equal(p1, p2, 'the same promise (React `use` must see a cached promise)');
    assert.equal(loader.peek().status, 'loading');
    d.resolve('Screen');
    assert.equal(await p1, 'Screen');
    await flush();
    const now = loader.peek();
    assert.equal(now.status, 'loaded');
    assert.equal(now.status === 'loaded' ? now.value : null, 'Screen', 'loaded: rendered synchronously, no fallback flash');
    assert.equal(loader.load(), p1);
    assert.equal(calls, 1);
    assert.equal(loader.reset(), false, 'a loaded screen is never reset');
  });

  test('a failed load is remembered (no retry loop on re-render) until "Try again" re-arms it', async () => {
    let calls = 0;
    let fail = true;
    const loader = createLazyLoader(async () => {
      calls++;
      if (fail) throw new Error('chunk missing');
      return 'Screen';
    });
    const p1 = loader.load();
    await assert.rejects(p1, /chunk missing/);
    await flush();
    assert.equal(loader.peek().status, 'failed');
    assert.equal(loader.load(), p1, 'rendering again re-throws the same error');
    assert.equal(calls, 1);

    fail = false;
    assert.ok(retryFailedLoads() >= 1, 'the error boundary\'s "Try again" resets failed loads');
    assert.equal(loader.peek().status, 'idle');
    assert.equal(await loader.load(), 'Screen');
    assert.equal(calls, 2);
    assert.equal(retryFailedLoads(), 0, 'nothing left to retry');
  });

  test('a loader that throws synchronously fails like a rejected import', async () => {
    const loader = createLazyLoader<string>(() => {
      throw new Error('boom');
    });
    await assert.rejects(loader.load(), /boom/);
    await flush();
    assert.equal(loader.peek().status, 'failed');
    assert.equal(loader.reset(), true);
  });

  test('a failed prefetch nobody awaits is not an unhandled rejection', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const loader = createLazyLoader(() => Promise.reject(new Error('offline')));
      void loader.load();
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(seen, []);
      loader.reset();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('runWhenIdle (idle prefetch)', () => {
  function manualScheduler() {
    const slots: Array<{ run: () => void; cancelled: boolean }> = [];
    return {
      slots,
      schedule: (run: () => void) => {
        const slot = { run, cancelled: false };
        slots.push(slot);
        return () => {
          slot.cancelled = true;
        };
      },
      async runNext(): Promise<boolean> {
        const slot = slots.find((s) => !s.cancelled && s.run !== noop);
        if (!slot) return false;
        const run = slot.run;
        slot.run = noop;
        run();
        await flush();
        return true;
      },
    };
  }
  const noop = (): void => undefined;

  test('one task per idle slot, in order; a failing task does not stop the rest', async () => {
    const s = manualScheduler();
    const ran: string[] = [];
    runWhenIdle(
      [
        async () => ran.push('a'),
        async () => {
          ran.push('b');
          throw new Error('chunk failed');
        },
        () => {
          ran.push('c');
          throw new Error('sync failure');
        },
        async () => ran.push('d'),
      ],
      s.schedule,
    );
    assert.deepEqual(ran, [], 'nothing runs before the first idle slot');
    assert.equal(s.slots.length, 1, 'only the next task is scheduled');
    while (await s.runNext());
    assert.deepEqual(ran, ['a', 'b', 'c', 'd']);
    assert.equal(s.slots.length, 4);
  });

  test('cancel (workspace unmounted) stops the tasks not started yet', async () => {
    const s = manualScheduler();
    const ran: string[] = [];
    const cancel = runWhenIdle([async () => ran.push('a'), async () => ran.push('b')], s.schedule);
    await s.runNext();
    cancel();
    while (await s.runNext());
    assert.deepEqual(ran, ['a']);
  });

  test('no tasks: nothing is scheduled', () => {
    const s = manualScheduler();
    runWhenIdle([], s.schedule);
    assert.equal(s.slots.length, 0);
  });

  test('browserIdleScheduler uses requestIdleCallback with a timeout, else setTimeout', async () => {
    const calls: Array<{ timeout?: number }> = [];
    const cancelled: number[] = [];
    const fakeWindow = {
      requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => {
        calls.push(opts ?? {});
        cb();
        return 7;
      },
      cancelIdleCallback: (id: number) => cancelled.push(id),
    } as unknown as typeof globalThis;
    let ran = 0;
    const cancel = browserIdleScheduler(fakeWindow)(() => ran++);
    assert.equal(ran, 1);
    assert.deepEqual(calls, [{ timeout: PREFETCH_IDLE_TIMEOUT_MS }]);
    cancel();
    assert.deepEqual(cancelled, [7]);

    let ranFallback = 0;
    browserIdleScheduler({} as typeof globalThis)(() => ranFallback++);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(ranFallback, 1, 'no requestIdleCallback (node, old engines): a short timeout');
  });
});

// ───────────────────────────── 2. Wiring (source) ─────────────────────────────

/** WP-03's lazy modules (SPEC §13 WP-03): only their index files may use lazyScreen. */
const LAZY_MODULES = ['attachments', 'banking', 'cheques', 'data', 'documents', 'forex', 'gst', 'gstrecon', 'inventory', 'mfg', 'outstanding', 'pos', 'reports', 'security', 'stock', 'tds'];
/** Modules whose screens stay eager (start-up and the invoice flow). */
const EAGER_MODULES = ['accounts', 'company', 'dashboard', 'print', 'vouchers'];

const LAZY_DECL = /^const (\w+) = lazyScreen\(\(\) => import\('(\.\/[\w/]+\.tsx)'\)\.then\(\(m\) => m\.(\w+)\)\);$/gm;

interface LazyDecl {
  module: string;
  name: string;
  file: string;
}

function moduleDirs(): string[] {
  return fs
    .readdirSync(modulesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(modulesDir, d.name, 'index.ts')))
    .map((d) => d.name)
    .sort();
}

const indexSource = (m: string): string => read(path.join(modulesDir, m, 'index.ts'));

function lazyDecls(): LazyDecl[] {
  const out: LazyDecl[] = [];
  for (const m of moduleDirs()) {
    for (const hit of indexSource(m).matchAll(LAZY_DECL)) {
      assert.equal(hit[1], hit[3], `${m}/index.ts: const ${hit[1]} loads m.${hit[3]} — keep the names equal`);
      out.push({ module: m, name: hit[1], file: path.join(modulesDir, m, hit[2]) });
    }
  }
  return out;
}

/** Screen definitions of a module index: id → { component, dialog }. */
function screensOf(m: string): Array<{ id: string; component: string; dialog: boolean }> {
  const out: Array<{ id: string; component: string; dialog: boolean }> = [];
  for (const hit of indexSource(m).matchAll(/\{\s*id:\s*'([^']+)'\s*,\s*title:\s*'[^']*'([^}]*)\}/g)) {
    const component = /\bcomponent:\s*(\w+)/.exec(hit[2])?.[1];
    if (component) out.push({ id: hit[1], component, dialog: /presentation:\s*'dialog'/.test(hit[2]) });
  }
  return out;
}

/**
 * Static imports of a source file, resolved to absolute paths. Only `import type` / `export type` are
 * skipped: under `verbatimModuleSyntax` (tsconfig.base.json) `import { type A } from './X.tsx'` is
 * emitted as `import {} from './X.tsx'`, a side-effect import that keeps X in the importer's chunk.
 */
function staticImports(file: string): string[] {
  const text = read(file);
  const out: string[] = [];
  const re = /^\s*(?:import|export)\s+(type\s+)?([^'";]*?)\s*from\s*'([^']+)'|^\s*import\s*'([^']+)'/gm;
  for (const m of text.matchAll(re)) {
    if (m[1]) continue;
    const spec = m[3] ?? m[4];
    if (!spec.startsWith('.')) continue;
    const abs = path.resolve(path.dirname(file), spec);
    if (/\.tsx?$/.test(abs)) out.push(abs);
  }
  return out;
}

/** Every renderer file the entry (main.tsx) reaches through static imports, with how it got there. */
function eagerGraph(): Map<string, string | null> {
  const from = new Map<string, string | null>();
  const start = path.join(rendererDir, 'main.tsx');
  from.set(start, null);
  const queue = [start];
  while (queue.length > 0) {
    const f = queue.shift() as string;
    if (!f.startsWith(rendererDir) || !fs.existsSync(f)) continue; // src/shared is plain code either way
    for (const next of staticImports(f)) {
      if (from.has(next)) continue;
      from.set(next, f);
      queue.push(next);
    }
  }
  return from;
}

function chain(graph: Map<string, string | null>, file: string): string {
  const out: string[] = [];
  for (let f: string | null | undefined = file; f; f = graph.get(f)) out.push(path.relative(rendererDir, f).split(path.sep).join('/'));
  return out.reverse().join(' → ');
}

describe('lazy screen wiring', () => {
  const decls = lazyDecls();

  test('lazyScreen renders a loaded screen synchronously and suspends only on the one cached import', () => {
    const src = read(path.join(appDir, 'lazyScreen.tsx'));
    // Loaded (re-open, prefetched): no `use`, so no fallback flash; otherwise React `use` on loader.load(),
    // which returns the same promise every time (createLazyLoader above).
    assert.match(src, /const Comp = now\.status === 'loaded' \? now\.value : use\(loader\.load\(\)\);/);
    assert.match(src, /const now = loader\.peek\(\);/);
    // preload() never rejects (an idle prefetch nobody awaits must not log an unhandled rejection).
    assert.match(src, /out\.preload = \(\) =>\s*loader\.load\(\)\.then\(\s*\(\) => undefined,\s*\(\) => undefined,\s*\);/);
  });

  test('the scan finds the lazy screens', () => {
    assert.ok(decls.length >= 100, `only ${decls.length} lazy screens found`);
    for (const m of ['banking', 'gst', 'reports', 'stock', 'outstanding', 'tds']) assert.ok(decls.some((d) => d.module === m), m);
  });

  test('only the WP-03 modules load screens lazily; accounts, company, dashboard, print and vouchers stay eager', () => {
    const users = moduleDirs().filter((m) => /\blazyScreen\b/.test(indexSource(m)));
    for (const m of users) assert.ok(LAZY_MODULES.includes(m), `${m}/index.ts uses lazyScreen but is not a lazy module`);
    for (const m of EAGER_MODULES) assert.ok(!/\blazyScreen\b/.test(indexSource(m)), `${m} must stay eager`);
    // Nothing else imports the wrapper: screens are lazy only through their module's registration.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts') && e.name !== 'index.ts' && /lazyScreen\.tsx'/.test(read(p))) offenders.push(path.relative(rendererDir, p));
      }
    };
    walk(modulesDir);
    assert.deepEqual(offenders, []);
  });

  test('every lazy declaration is a registered screen component loaded from a file that exports it', () => {
    for (const d of decls) {
      const where = `${d.module}/index.ts ${d.name}`;
      const index = indexSource(d.module);
      assert.ok(new RegExp(`component:\\s*${d.name}\\b`).test(index), `${where}: not used as a screen component`);
      const uses = (index.match(new RegExp(`\\b${d.name}\\b(?!\\.tsx)`, 'g')) ?? []).length; // not the file name
      const asComponent = (index.match(new RegExp(`component:\\s*${d.name}\\b`, 'g')) ?? []).length;
      assert.equal(uses, asComponent + 2, `${where}: used outside screen registrations (that would need it eagerly)`);
      assert.ok(fs.existsSync(d.file), `${where}: ${d.file} missing`);
      assert.match(read(d.file), new RegExp(`export (?:function|const) ${d.name}\\b`), `${where}: not exported by ${path.basename(d.file)}`);
    }
  });

  test('dialog screens and Create Stock Item stay eager; panels, cards and notices are never lazy', () => {
    const lazyNames = new Map(decls.map((d) => [`${d.module}:${d.name}`, d]));
    for (const m of moduleDirs()) {
      for (const s of screensOf(m)) {
        const lazy = lazyNames.has(`${m}:${s.component}`);
        if (s.dialog) assert.ok(!lazy, `${s.id}: a dialog screen opens over a live screen — keep it eager`);
        if (s.id === 'inventory.item.form') assert.ok(!lazy, 'inventory.item.form stays eager (SPEC WP-03)');
      }
      const index = indexSource(m);
      for (const ext of ['voucherPanels', 'dashboardCards', 'gatewayNotices']) {
        const listed = new RegExp(`${ext}:\\s*\\[([^\\]]*)\\]`).exec(index);
        for (const name of (listed?.[1] ?? '').split(',').map((n) => n.trim()).filter(Boolean)) {
          assert.ok(!lazyNames.has(`${m}:${name}`), `${m}: ${ext} ${name} must stay eager`);
        }
      }
    }
  });

  test('every lazily loaded file really leaves the start-up bundle (no eager code imports it statically)', () => {
    const graph = eagerGraph();
    assert.ok(graph.has(path.join(modulesDir, 'vouchers', 'index.ts')), 'the graph walk reaches the module registry');
    const stuck = [...new Set(decls.map((d) => d.file))].filter((f) => graph.has(f)).map((f) => chain(graph, f));
    assert.deepEqual(stuck, [], 'a file loaded with lazyScreen is also imported statically — the bundler keeps it in the entry');
  });

  test('no stylesheet moves into a lazy chunk (SPEC D15): every CSS file a lazy screen needs is already eager', () => {
    const graph = eagerGraph();
    const cssOf = (file: string): string[] =>
      [...read(file).matchAll(/^\s*import\s*'(\.[^']+\.css)'/gm)].map((m) => path.resolve(path.dirname(file), m[1]));
    const eagerCss = new Set([...graph.keys()].filter((f) => fs.existsSync(f)).flatMap(cssOf));
    assert.ok(eagerCss.size >= 10, 'the eager graph carries the module stylesheets');
    // Everything a lazy file pulls in that is not eager lands in its chunk.
    const seen = new Set<string>();
    const queue = [...new Set(decls.map((d) => d.file))];
    const missing: string[] = [];
    while (queue.length > 0) {
      const f = queue.shift() as string;
      if (seen.has(f) || graph.has(f) || !fs.existsSync(f)) continue;
      seen.add(f);
      for (const css of cssOf(f)) if (!eagerCss.has(css)) missing.push(`${path.relative(rendererDir, f)} → ${path.relative(rendererDir, css)}`);
      queue.push(...staticImports(f));
    }
    assert.ok(seen.size >= decls.length / 2, 'the walk visits the lazy files');
    assert.deepEqual(missing, [], 'import the stylesheet from the module index.ts (eager) as well');
  });
});

describe('idle prefetch of the Essentials screens', () => {
  const lazySource = read(path.join(appDir, 'lazyScreen.tsx'));
  const listed = /export const PREFETCH_SCREENS: readonly string\[\] = \[([^\]]*)\]/.exec(lazySource);
  const prefetch = [...(listed?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const decls = lazyDecls();
  const lazyScreenIds = new Set(
    moduleDirs().flatMap((m) =>
      screensOf(m)
        .filter((s) => decls.some((d) => d.module === m && d.name === s.component))
        .map((s) => s.id),
    ),
  );
  const menuScreens = new Map<string, string>();
  for (const m of moduleDirs()) {
    for (const hit of indexSource(m).matchAll(/label:\s*'([^']+)'\s*,\s*screen:\s*'([^']+)'/g)) menuScreens.set(hit[1], hit[2]);
  }

  test('PREFETCH_SCREENS lists lazy screens only, each once', () => {
    assert.ok(prefetch.length >= 5, 'the list is read from lazyScreen.tsx');
    assert.equal(new Set(prefetch).size, prefetch.length, 'no duplicates');
    for (const id of prefetch) assert.ok(lazyScreenIds.has(id), `${id} is not a lazy screen`);
  });

  test('every lazy screen of Home › Essentials is prefetched, in Essentials order', () => {
    const wanted: string[] = [];
    for (const group of ESSENTIALS) {
      for (const ref of group.entries) {
        const id = ref.label !== undefined ? menuScreens.get(ref.label) : undefined; // voucher entry is eager
        if (id && lazyScreenIds.has(id) && !wanted.includes(id)) wanted.push(id);
      }
    }
    assert.ok(wanted.length >= 5, `only ${wanted.length} lazy Essentials screens resolved`);
    assert.deepEqual(prefetch, wanted);
  });

  test('ScreenStack shows the screen skeleton inside the error boundary and prefetches when idle', () => {
    const nav = read(path.join(appDir, 'nav.tsx'));
    assert.match(nav, /<ScreenErrorBoundary title=\{def\.title\}>\s*(?:\{\/\*[^*]*\*\/\}\s*)?<Suspense fallback=\{<LazyScreenLoading load=\{lazyLoad\} onLoaded=\{onLazyLoaded\} \/>\}>\{content\}<\/Suspense>\s*<\/ScreenErrorBoundary>/);
    assert.match(nav, /function LazyScreenLoading\(.*\) \{[\s\S]*?return \(\s*<div data-lazy-screen-loading="">\s*<ScreenSkeleton \/>/, 'the fallback is the screen skeleton');
    assert.match(nav, /whenLazyScreenLoaded\(c, /, 'initial focus waits for the screen\'s code, then picks as for an eager screen');
  });

  test('a loaded chunk is shown at once, not after React\'s 300 ms Suspense retry throttle', () => {
    const nav = read(path.join(appDir, 'nav.tsx'));
    // The fallback waits for the same cached load and then updates its ScreenHost (an ordinary update,
    // committed at once) instead of leaving the reveal to Suspense's throttled retry.
    const fallback = /function LazyScreenLoading\(.*\) \{([\s\S]*?)\n\}/.exec(nav)?.[1] ?? '';
    assert.match(fallback, /useEffect\(\(\) => \{[\s\S]*load\(\)\.then\(\(\) => \{\s*if \(live\) onLoaded\(\);/, 'the fallback reports the arrived chunk to the host');
    assert.match(fallback, /return \(\) => \{\s*live = false;/, 'no update after the screen was closed');
    assert.match(nav, /const onLazyLoaded = useCallback\(\(\) => setLazyLoaded\(\(n\) => n \+ 1\), \[\]\);/);
    assert.match(nav, /const lazyLoad = isLazyScreen\(Comp\) \? Comp\.preload : null;/);
    // The update must reach the boundary's content: the element changes identity with the update.
    assert.match(nav, /const content = useMemo\(\(\) => <Comp key=\{lazyLoaded\} params=\{entry\.params\} \/>, \[Comp, entry\.params, lazyLoaded\]\);/);
  });

  test('while a screen\'s code loads, keys never reach the hidden screen that opened it', () => {
    const nav = read(path.join(appDir, 'nav.tsx'));
    // Focus left on the (now hidden) Home button would let Enter open the screen again.
    assert.match(nav, /if \(opener instanceof HTMLElement && opener !== document\.body && !c\.contains\(opener\) && !isShown\(opener\)\) opener\.blur\(\);/);
    assert.match(nav, /function isShown\(el: Element\): boolean \{\s*return el\.isConnected && el\.getClientRects\(\)\.length > 0;/);
    // After the load, focus the user put on something visible elsewhere *during the load* is kept; a hidden
    // leftover is not a choice, nor is focus still where it was when the screen opened (an eager screen
    // takes that at once — e.g. the topbar search button Go To hands focus back to). The rule itself is
    // keepUserFocusAfterLazyLoad (lib/initialFocus.test.ts).
    assert.match(nav, /return keepUserFocusAfterLazyLoad\(\{ active, atOpen, isBody: active === document\.body, inScreen: active !== null && container\.contains\(active\), shown: active !== null && isShown\(active\) \}\);/);
    assert.match(nav, /const opener = document\.activeElement;/);
    assert.match(nav, /whenLazyScreenLoaded\(c, \(\) => \{\s*if \(!focusIsElsewhere\(c, opener\)\) focusNow\(\);/);
  });

  test('idle prefetch and "Try again" are wired', () => {
    const nav = read(path.join(appDir, 'nav.tsx'));
    assert.match(nav, /runWhenIdle\(tasks, browserIdleScheduler\(\)\)/);
    assert.match(nav, /PREFETCH_SCREENS\.flatMap/);
    assert.match(nav, /retryLazyScreens\(\)/, '"Try again" re-arms a failed chunk load');
    const screen = read(path.join(appDir, 'Screen.tsx'));
    assert.match(screen, /className="bx-screen-skeleton" aria-busy="true"/, 'the fallback is busy for assistive tech and e2e waits');
  });
});
