import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GRAPHS_ARIA_KEY, GRAPHS_KEY, graphsAction, graphsAnnouncement, graphsLabel, graphsPrefKey, graphsScope, graphsShown, graphsTooltip } from './graphsToggle.ts';
import { toAriaKeyShortcut } from '../../ui/lib/hotkeys.ts';

describe('graphsAction (SPEC-21 §4.5)', () => {
  test('key Ctrl+J, labels per state, group view', () => {
    const shown = graphsAction(true, 'report');
    assert.equal(shown.key, 'Ctrl+J');
    assert.equal(shown.label, 'Hide graphs');
    assert.equal(shown.group, 'view');
    const folded = graphsAction(false, 'report');
    assert.equal(folded.key, 'Ctrl+J');
    assert.equal(folded.label, 'Show graphs');
    assert.equal(folded.group, 'view');
  });

  test('the action runs the toggle it was given (and is a no-op without one)', () => {
    let n = 0;
    graphsAction(true, 'detail', () => n++).onClick();
    assert.equal(n, 1);
    assert.doesNotThrow(() => graphsAction(true, 'detail').onClick());
  });

  test('the hint names the scope of the class', () => {
    assert.equal(graphsAction(true, 'report').hint, 'Hide graphs on all reports and Home');
    assert.equal(graphsAction(false, 'detail').hint, 'Show graphs on detail reports');
  });

  test('field order: key, label, onClick first (the key-convention scan reads `key, label, onClick`)', () => {
    assert.deepEqual(Object.keys(graphsAction(true, 'report')).slice(0, 3), ['key', 'label', 'onClick']);
  });
});

describe('scope, tooltip and announcement per class', () => {
  test('scope text', () => {
    assert.equal(graphsScope('report'), 'all reports and Home');
    assert.equal(graphsScope('detail'), 'detail reports');
  });

  test('tooltip: "Label on <scope> · Ctrl+J"', () => {
    assert.equal(graphsTooltip(true, 'report'), 'Hide graphs on all reports and Home · Ctrl+J');
    assert.equal(graphsTooltip(false, 'report'), 'Show graphs on all reports and Home · Ctrl+J');
    assert.equal(graphsTooltip(true, 'detail'), 'Hide graphs on detail reports · Ctrl+J');
    assert.equal(graphsTooltip(false, 'detail'), 'Show graphs on detail reports · Ctrl+J');
  });

  test('live-region text says what happened, and where', () => {
    assert.equal(graphsAnnouncement(false, 'report'), 'Graphs hidden on all reports and Home');
    assert.equal(graphsAnnouncement(true, 'detail'), 'Graphs shown on detail reports');
  });

  test('labels are plural (one press changes every screen of the class)', () => {
    assert.equal(graphsLabel(true), 'Hide graphs');
    assert.equal(graphsLabel(false), 'Show graphs');
  });

  test('aria-keyshortcuts is the same key', () => {
    assert.equal(toAriaKeyShortcut(GRAPHS_KEY), GRAPHS_ARIA_KEY);
  });
});

describe('preference per class', () => {
  test('report → graphs, detail → detailGraphs', () => {
    assert.equal(graphsPrefKey('report'), 'graphs');
    assert.equal(graphsPrefKey('detail'), 'detailGraphs');
    assert.equal(graphsShown({ graphs: true, detailGraphs: false }, 'report'), true);
    assert.equal(graphsShown({ graphs: true, detailGraphs: false }, 'detail'), false);
    assert.equal(graphsShown({ graphs: false, detailGraphs: true }, 'report'), false);
    assert.equal(graphsShown({ graphs: false, detailGraphs: true }, 'detail'), true);
  });
});

test('Ctrl+J is bound in one place: no screen or module writes the key itself (SPEC-21 §3.5)', () => {
  const renderer = fileURLToPath(new URL('../../', import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts')) files.push(p);
    }
  };
  walk(renderer);
  const literal = /['"`]Ctrl\+J['"`]/;
  const found = files.filter((f) => literal.test(readFileSync(f, 'utf8'))).map((f) => relative(renderer, f).split('\\').join('/'));
  // shortcuts.ts is the keyboard reference (F1, USER_GUIDE §15) — it lists the key, it binds nothing.
  assert.deepEqual(
    found.filter((f) => f !== 'app/lib/shortcuts.ts'),
    ['app/lib/graphsToggle.ts'],
  );
});
