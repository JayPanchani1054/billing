import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { BOOT_MARK, FIRST_SCREEN_MARK, markBoot, markFirstScreen, markOnce, markPhase, markShellReady, readStartupMarks, SHELL_READY_MARK, STARTUP_MEASURE } from './perfMarks.ts';
import type { AppPhase } from './appPhase.ts';
import type { MarkTarget } from './perfMarks.ts';

/** A Performance stand-in with a controllable clock. */
function fakePerf(): MarkTarget & { now: number; entries: { name: string; type: string; startTime: number; duration: number }[] } {
  const entries: { name: string; type: string; startTime: number; duration: number }[] = [];
  const self = {
    now: 0,
    entries,
    mark(name: string) {
      entries.push({ name, type: 'mark', startTime: self.now, duration: 0 });
    },
    measure(name: string, start: string, end: string) {
      const s = entries.find((e) => e.name === start && e.type === 'mark');
      const e = entries.find((x) => x.name === end && x.type === 'mark');
      if (!s || !e) throw new Error('missing mark');
      entries.push({ name, type: 'measure', startTime: s.startTime, duration: e.startTime - s.startTime });
    },
    getEntriesByName(name: string, type?: string) {
      return entries.filter((e) => e.name === name && (type === undefined || e.type === type));
    },
  };
  return self;
}

describe('perf marks', () => {
  test('names are the ones e2e/perf.spec.ts and docs/ARCHITECTURE.md §9a read', () => {
    assert.equal(BOOT_MARK, 'pevqori:boot');
    assert.equal(FIRST_SCREEN_MARK, 'pevqori:first-screen');
    assert.equal(SHELL_READY_MARK, 'pevqori:shell-ready');
    assert.equal(STARTUP_MEASURE, 'pevqori:startup');
  });

  test('boot → shell-ready: each mark set once, the startup measure between them', () => {
    const perf = fakePerf();
    perf.now = 120;
    assert.equal(markBoot(perf), true);
    perf.now = 450;
    assert.equal(markShellReady(perf), true);
    assert.deepEqual(readStartupMarks(perf), { boot: 120, firstScreen: null, shellReady: 450, bootToShellReady: 330 });
    const measures = perf.getEntriesByName(STARTUP_MEASURE, 'measure');
    assert.equal(measures.length, 1);
    assert.equal(measures[0].duration, 330);
  });

  test('idempotent: a second boot, StrictMode double effect or a remount (company switch) never moves a mark', () => {
    const perf = fakePerf();
    perf.now = 10;
    markBoot(perf);
    perf.now = 200;
    markShellReady(perf);
    perf.now = 900;
    assert.equal(markBoot(perf), false);
    assert.equal(markShellReady(perf), false);
    assert.equal(markShellReady(perf), false);
    assert.equal(perf.getEntriesByName(BOOT_MARK, 'mark').length, 1);
    assert.equal(perf.getEntriesByName(SHELL_READY_MARK, 'mark').length, 1);
    assert.equal(perf.getEntriesByName(STARTUP_MEASURE, 'measure').length, 1);
    assert.deepEqual(readStartupMarks(perf), { boot: 10, firstScreen: null, shellReady: 200, bootToShellReady: 190 });
  });

  test('shell-ready without boot: the mark is set, no measure, no throw', () => {
    const perf = fakePerf();
    perf.now = 75;
    assert.equal(markShellReady(perf), true);
    assert.equal(perf.getEntriesByName(STARTUP_MEASURE, 'measure').length, 0);
    assert.deepEqual(readStartupMarks(perf), { boot: null, firstScreen: null, shellReady: 75, bootToShellReady: null });
  });

  test('never throws: no performance object, or one that throws', () => {
    assert.equal(markBoot(null), false);
    assert.equal(markShellReady(null), false);
    assert.deepEqual(readStartupMarks(null), { boot: null, firstScreen: null, shellReady: null, bootToShellReady: null });
    assert.deepEqual(markPhase('workspace', null), []);
    assert.equal(markFirstScreen(null), false);
    const broken: MarkTarget = {
      mark: () => {
        throw new Error('blocked');
      },
      measure: () => {
        throw new Error('blocked');
      },
      getEntriesByName: () => [],
    };
    assert.equal(markOnce('x', broken), false);
    assert.equal(markShellReady(broken), false);
  });

  test('App.tsx phases: the splash marks nothing; the company list is the first screen; the workspace is shell-ready', () => {
    const perf = fakePerf();
    perf.now = 50;
    markBoot(perf);
    perf.now = 60;
    assert.deepEqual(markPhase('loading', perf), [], 'the splash is not a screen the user can act on');
    perf.now = 300;
    assert.deepEqual(markPhase('select-company', perf), [FIRST_SCREEN_MARK]);
    perf.now = 2_000; // the user looks at the list, then presses Enter
    assert.deepEqual(markPhase('loading', perf), []);
    perf.now = 2_400;
    assert.deepEqual(markPhase('workspace', perf), [SHELL_READY_MARK], 'the first screen is not moved by the workspace');
    perf.now = 9_000;
    for (const phase of ['locked', 'workspace', 'select-company', 'workspace'] as const satisfies readonly AppPhase[]) assert.deepEqual(markPhase(phase, perf), []);
    assert.deepEqual(readStartupMarks(perf), { boot: 50, firstScreen: 300, shellReady: 2_400, bootToShellReady: 2_350 });
  });

  test('App.tsx phases: a locked workspace is not shell-ready; a first run marks its setup screen as the first screen', () => {
    const perf = fakePerf();
    perf.now = 10;
    assert.deepEqual(markPhase('first-run', perf), [FIRST_SCREEN_MARK]);
    perf.now = 20;
    assert.deepEqual(markPhase('locked', perf), []);
    assert.equal(perf.getEntriesByName(SHELL_READY_MARK, 'mark').length, 0);
    perf.now = 30;
    assert.deepEqual(markPhase('workspace', perf), [SHELL_READY_MARK]);
    assert.deepEqual(readStartupMarks(perf), { boot: null, firstScreen: 10, shellReady: 30, bootToShellReady: null });
  });

  describe('with the real global performance (Node: the same User Timing API as Chromium)', () => {
    afterEach(() => {
      performance.clearMarks(BOOT_MARK);
      performance.clearMarks(FIRST_SCREEN_MARK);
      performance.clearMarks(SHELL_READY_MARK);
      performance.clearMeasures(STARTUP_MEASURE);
    });

    test('marks and measure are set once on the default target', () => {
      assert.equal(markBoot(), true);
      assert.equal(markBoot(), false);
      assert.equal(markShellReady(), true);
      assert.equal(markShellReady(), false);
      const m = readStartupMarks();
      assert.ok(m.boot !== null && m.shellReady !== null && m.bootToShellReady !== null);
      assert.ok(m.bootToShellReady >= 0);
      assert.equal(performance.getEntriesByName(STARTUP_MEASURE, 'measure').length, 1);
    });
  });
});
