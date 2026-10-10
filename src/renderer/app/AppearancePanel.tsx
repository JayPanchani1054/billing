/**
 * Appearance settings in one panel: theme, density, the shortcut bar and the Home view. Used by the
 * user menu's "Appearance…" dialog (Workspace) and by the Settings hub (company.settings). Every
 * choice applies at once and is remembered per user profile (preferences.ts, lib/uiPrefs.ts).
 */
import { SegmentedControl, Switch } from '../ui/index.ts';
import type { Density, ThemePreference } from '../ui/index.ts';
import { setPreferences, setUiPrefs, usePreferences, useUiPrefs } from './preferences.ts';
import type { HomeView } from './preferences.ts';

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

export function AppearancePanel() {
  const prefs = usePreferences();
  const ui = useUiPrefs();
  return (
    <div className="bx-appearance">
      <div className="bx-appearance__row">
        <span className="bx-appearance__label">Theme</span>
        <SegmentedControl aria-label="Theme" options={THEMES} value={prefs.theme} onChange={(theme) => setPreferences({ theme })} size="sm" />
      </div>
      <div className="bx-appearance__row">
        <span className="bx-appearance__label">Density</span>
        <SegmentedControl aria-label="Density" options={DENSITIES} value={prefs.density} onChange={(density) => setPreferences({ density })} size="sm" />
      </div>
      <div className="bx-appearance__row">
        <span className="bx-appearance__label">
          Home view
          <span className="bx-appearance__hint">Essentials lists the everyday tasks; All menus lists every menu with its letter keys (Ctrl+1 / Ctrl+2 on Home).</span>
        </span>
        <SegmentedControl aria-label="Home view" options={HOME_VIEWS} value={ui.homeView} onChange={(homeView) => setUiPrefs({ homeView })} size="sm" />
      </div>
      <div className="bx-appearance__row">
        <span className="bx-appearance__label">
          Shortcut bar
          <span className="bx-appearance__hint">A column at the right of every screen listing all its actions with their keys.</span>
        </span>
        <Switch checked={ui.shortcutBar} onChange={(shortcutBar) => setUiPrefs({ shortcutBar })} label="Show shortcut bar" />
      </div>
    </div>
  );
}
