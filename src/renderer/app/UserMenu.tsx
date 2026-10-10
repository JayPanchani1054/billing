/**
 * The top bar's user menu (avatar ▾): who is signed in, theme, density, Home view, the shortcut bar,
 * Appearance…, Keyboard shortcuts (F1), About, and for secured companies Change password / Lock /
 * Log out. Moved out of Workspace.tsx in 2.1 (WP-0b) so the user menu has one owner.
 */
import { useMemo, useState } from 'react';
import { DropdownMenu, Icon, Modal } from '../ui/index.ts';
import type { MenuEntry } from '../ui/index.ts';
import { AppearancePanel } from './AppearancePanel.tsx';
import { useNav } from './nav.tsx';
import { setPreferences, setUiPrefs, usePreferences, useUiPrefs } from './preferences.ts';
import { useShell } from './shell.tsx';
import { useAppState, useCompany } from './state.tsx';
import { WELL_KNOWN_SCREENS } from './wellKnown.ts';

export function UserMenu() {
  const app = useAppState();
  const company = useCompany();
  const shell = useShell();
  const nav = useNav();
  const prefs = usePreferences();
  const ui = useUiPrefs();
  const session = app.session;
  const [appearanceOpen, setAppearanceOpen] = useState(false);

  const userItems: MenuEntry[] = useMemo(() => {
    const secured = session && !session.implicit;
    const items: MenuEntry[] = [];
    if (secured) items.push({ type: 'label', key: 'who', label: `${session.displayName || session.username} · ${session.role}` });
    items.push({ type: 'label', key: 'theme-label', label: 'Theme' });
    items.push({ key: 'theme-system', label: 'Match Windows', icon: 'grid', checked: prefs.theme === 'system', onSelect: () => setPreferences({ theme: 'system' }) });
    items.push({ key: 'theme-light', label: 'Light', icon: 'sun', checked: prefs.theme === 'light', onSelect: () => setPreferences({ theme: 'light' }) });
    items.push({ key: 'theme-dark', label: 'Dark', icon: 'moon', checked: prefs.theme === 'dark', onSelect: () => setPreferences({ theme: 'dark' }) });
    items.push({ type: 'label', key: 'density-label', label: 'Density' });
    items.push({ key: 'density-comfortable', label: 'Comfortable', icon: 'list', checked: prefs.density === 'comfortable', onSelect: () => setPreferences({ density: 'comfortable' }) });
    items.push({ key: 'density-compact', label: 'Compact', icon: 'columns', checked: prefs.density === 'compact', onSelect: () => setPreferences({ density: 'compact' }) });
    items.push({ type: 'label', key: 'home-label', label: 'Home view (Ctrl+1 / Ctrl+2 on Home)' });
    items.push({ key: 'home-essentials', label: 'Essentials', icon: 'home', checked: ui.homeView === 'essentials', onSelect: () => setUiPrefs({ homeView: 'essentials' }) });
    items.push({ key: 'home-all', label: 'All menus', icon: 'menu', checked: ui.homeView === 'all', onSelect: () => setUiPrefs({ homeView: 'all' }) });
    items.push({ type: 'separator', key: 's1' });
    items.push({ key: 'shortcut-bar', label: 'Show shortcut bar', icon: 'panel-right', checked: ui.shortcutBar, onSelect: () => setUiPrefs({ shortcutBar: !ui.shortcutBar }) });
    items.push({ key: 'appearance', label: 'Appearance…', icon: 'sliders', onSelect: () => setAppearanceOpen(true) });
    items.push({ type: 'separator', key: 's2' });
    items.push({ key: 'shortcuts', label: 'Keyboard shortcuts', icon: 'keyboard', shortcut: 'F1', onSelect: () => shell.openShortcuts() });
    if (nav.isRegistered(WELL_KNOWN_SCREENS.companyAbout)) items.push({ key: 'about', label: 'About Pevqori', icon: 'info', onSelect: () => nav.push(WELL_KNOWN_SCREENS.companyAbout) });
    if (secured) {
      items.push({ type: 'separator', key: 's3' });
      items.push({ key: 'password', label: 'Change password', icon: 'key', onSelect: () => nav.push('company.changePassword') });
      items.push({ key: 'lock', label: 'Lock', icon: 'lock', onSelect: () => void shell.lock() });
      items.push({ key: 'logout', label: 'Log out', icon: 'logout', onSelect: () => void shell.logout() });
    }
    return items;
  }, [session, prefs, ui, nav, shell]);

  const initials = (session && !session.implicit ? session.displayName || session.username : company.name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <>
      <DropdownMenu
        items={userItems}
        aria-label="User menu"
        placement="bottom-end"
        renderTrigger={(p) => (
          <button type="button" className="bx-topbar__user" {...p} aria-label="User menu">
            <span className="bx-avatar" aria-hidden="true">
              {initials || <Icon name="user" size="sm" />}
            </span>
            <Icon name="chevron-down" size="xs" />
          </button>
        )}
      />
      {appearanceOpen ? (
        <Modal open onClose={() => setAppearanceOpen(false)} title="Appearance" description="How Pevqori looks on this computer, for you." size="sm">
          <AppearancePanel />
        </Modal>
      ) : null}
    </>
  );
}
