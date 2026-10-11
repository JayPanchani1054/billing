/**
 * The top bar's user menu (avatar ▾): who is signed in, Appearance…, the shortcut bar, Keyboard
 * shortcuts (F1), About, and for secured companies Change password / Lock / Log out — at most 9 rows
 * (2.1, SPEC-21 §1.12). Theme, density and the Home view live in Appearance… (one place each). Moved
 * out of Workspace.tsx in 2.1 (WP-0b) so the user menu has one owner.
 */
import { useMemo, useState } from 'react';
import { DropdownMenu, Icon, Modal } from '../ui/index.ts';
import type { MenuEntry } from '../ui/index.ts';
import { AppearancePanel } from './AppearancePanel.tsx';
import { useNav } from './nav.tsx';
import { buildUserMenu } from './lib/userMenu.ts';
import { setUiPrefs, useUiPrefs } from './preferences.ts';
import { useShell } from './shell.tsx';
import { useAppState, useCompany } from './state.tsx';
import { WELL_KNOWN_SCREENS } from './wellKnown.ts';

export function UserMenu() {
  const app = useAppState();
  const company = useCompany();
  const shell = useShell();
  const nav = useNav();
  const ui = useUiPrefs();
  const session = app.session;
  const [appearanceOpen, setAppearanceOpen] = useState(false);

  const userItems: MenuEntry[] = useMemo(
    () =>
      buildUserMenu(
        { session: session ?? null, shortcutBar: ui.shortcutBar, canAbout: nav.isRegistered(WELL_KNOWN_SCREENS.companyAbout) },
        {
          appearance: () => setAppearanceOpen(true),
          shortcutBar: () => setUiPrefs({ shortcutBar: !ui.shortcutBar }),
          shortcuts: () => shell.openShortcuts(),
          about: () => nav.push(WELL_KNOWN_SCREENS.companyAbout),
          password: () => nav.push('company.changePassword'),
          lock: () => void shell.lock(),
          logout: () => void shell.logout(),
        },
      ),
    [session, ui.shortcutBar, nav, shell],
  );

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
        <Modal open onClose={() => setAppearanceOpen(false)} title="Appearance" size="sm">
          <AppearancePanel />
        </Modal>
      ) : null}
    </>
  );
}
