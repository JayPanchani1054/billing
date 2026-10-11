/**
 * Appearance settings in one panel: theme, density, the Home view, the shortcut bar and (2.1) the two
 * graph switches. Used by the user menu's "Appearance…" dialog (Workspace) and by the Settings hub
 * (company.settings). Every choice applies at once and is remembered on this computer, per Windows user
 * (preferences.ts, lib/uiPrefs.ts). Row explanations are tooltips and `aria-describedby`, not text lines.
 */
import { useId } from 'react';
import type { ReactNode } from 'react';
import { SegmentedControl, Switch } from '../ui/index.ts';
import type { Density, ThemePreference } from '../ui/index.ts';
import { setPreferences, setUiPrefs, usePreferences, useUiPrefs } from './preferences.ts';
import type { HomeView } from './preferences.ts';
import { GRAPHS_KEY } from './lib/graphsToggle.ts';

const THEMES: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'Match Windows' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const DENSITIES: ReadonlyArray<{ value: Density; label: string }> = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact', label: 'Compact' },
];

const HOME_VIEWS: ReadonlyArray<{ value: HomeView; label: string }> = [
  { value: 'essentials', label: 'Essentials' },
  { value: 'all', label: 'All menus' },
];

/**
 * One row: a label and its control(s). A row with an explanation is a named group whose description is
 * that explanation (read when focus enters any of its controls — the Home view radios included) and its
 * tooltip; the explanation is never a visible text line (2.1).
 */
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const id = useId();
  const group = hint ? { role: 'group', 'aria-labelledby': `${id}-l`, 'aria-describedby': `${id}-d`, title: hint } : {};
  return (
    <div className="bx-appearance__row" {...group}>
      <span id={`${id}-l`} className="bx-appearance__label">
        {label}
      </span>
      {hint ? (
        <span id={`${id}-d`} className="bx-sr-only">
          {hint}
        </span>
      ) : null}
      <span className="bx-appearance__controls">{children}</span>
    </div>
  );
}

export function AppearancePanel() {
  const prefs = usePreferences();
  const ui = useUiPrefs();
  return (
    <div className="bx-appearance">
      <Row label="Theme">
        <SegmentedControl aria-label="Theme" options={THEMES} value={prefs.theme} onChange={(theme) => setPreferences({ theme })} size="sm" />
      </Row>
      <Row label="Density">
        <SegmentedControl aria-label="Density" options={DENSITIES} value={prefs.density} onChange={(density) => setPreferences({ density })} size="sm" />
      </Row>
      <Row label="Home view" hint="Essentials lists the everyday tasks; All menus lists every menu with its letter keys (Ctrl+1 / Ctrl+2 on Home).">
        <SegmentedControl aria-label="Home view" options={HOME_VIEWS} value={ui.homeView} onChange={(homeView) => setUiPrefs({ homeView })} size="sm" />
      </Row>
      <Row label="Shortcut bar" hint="A column at the right of every screen listing all its actions with their keys.">
        <Switch checked={ui.shortcutBar} onChange={(shortcutBar) => setUiPrefs({ shortcutBar })} label="Show shortcut bar" />
      </Row>
      <Row label="Graphs" hint={`${GRAPHS_KEY} on a report does the same. Folded, a graph keeps its one-line answer.`}>
        <Switch checked={ui.graphs} onChange={(graphs) => setUiPrefs({ graphs })} label="Show graphs on reports and Home" />
        <Switch checked={ui.detailGraphs} onChange={(detailGraphs) => setUiPrefs({ detailGraphs })} label="Show graphs on detail reports" />
      </Row>
    </div>
  );
}
