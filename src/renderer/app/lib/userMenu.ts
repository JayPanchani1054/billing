/**
 * The user menu's rows (avatar ▾ in the top bar) — pure, tested in userMenu.test.ts; rendered by
 * app/UserMenu.tsx.
 *
 * 2.1 (SPEC-21 §1.12): at most 9 rows. Theme, density and the Home view left the menu — each has one
 * place, Appearance… (app/AppearancePanel.tsx). The shortcut bar stays a checkable row (its e2e name
 * "Show shortcut bar" is kept). No icons: menus draw only the ✓ of checkable rows; the one key is F1.
 */
import type { MenuEntry } from '../../ui/index.ts';

export interface UserMenuState {
  /** The signed-in user (null before a company is open). */
  session: { implicit: boolean; displayName: string; username: string; role: string } | null;
  shortcutBar: boolean;
  /** 'company.about' is registered. */
  canAbout: boolean;
}

export interface UserMenuActions {
  appearance: () => void;
  shortcutBar: () => void;
  shortcuts: () => void;
  about: () => void;
  password: () => void;
  lock: () => void;
  logout: () => void;
}

export function buildUserMenu(state: UserMenuState, on: UserMenuActions): MenuEntry[] {
  const { session } = state;
  const secured = session !== null && !session.implicit;
  const items: MenuEntry[] = [];
  if (secured) items.push({ type: 'label', key: 'who', label: `${session.displayName || session.username} · ${session.role}` });
  items.push({ key: 'appearance', label: 'Appearance…', onSelect: on.appearance });
  items.push({ key: 'shortcut-bar', label: 'Show shortcut bar', checked: state.shortcutBar, onSelect: on.shortcutBar });
  items.push({ key: 'shortcuts', label: 'Keyboard shortcuts', shortcut: 'F1', onSelect: on.shortcuts });
  if (state.canAbout) items.push({ key: 'about', label: 'About Pevqori', onSelect: on.about });
  if (secured) {
    items.push({ type: 'separator', key: 's1' });
    items.push({ key: 'password', label: 'Change password', onSelect: on.password });
    items.push({ key: 'lock', label: 'Lock', onSelect: on.lock });
    items.push({ key: 'logout', label: 'Log out', onSelect: on.logout });
  }
  return items;
}
