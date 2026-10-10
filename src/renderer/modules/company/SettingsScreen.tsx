/**
 * 'company.settings' {category?} — Settings (2.0): every setting of the app in one place. Topics on
 * the left, the topic's settings on the right; each row opens the existing screen (nav.push) — the hub
 * never embeds a form. Rows are data in lib/settingsIndex.ts (shown only when their screen is
 * registered and the viewer may open it; a topic with nothing left is hidden). Appearance is inline
 * (app/AppearancePanel.tsx), Data & backup also shows the data folder.
 *
 * Keys: the search box has focus on open (type to find a setting; ↓ moves into the list, Enter opens
 * the first match). Topics: ↑/↓ choose, → or Enter moves to its settings. Settings: ↑/↓ move, Enter
 * opens, ← back to the topics. Typing a letter in either list continues in the search box. Ctrl+F
 * search · Esc back.
 */
import { useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { native, Screen, useAppState, useCompany, useCompanyConfig, useNav, useSession } from '../../app/index.ts';
import type { ScreenProps } from '../../app/index.ts';
import { AppearancePanel } from '../../app/AppearancePanel.tsx';
import { Button, Card, EmptyState, Icon, Kbd, Stack, TextInput, useRovingFocus } from '../../ui/index.ts';
import { searchSettings, searchTopics, SETTINGS_INDEX, settingStatus, visibleSettings } from './lib/settingsIndex.ts';
import type { SettingsCategory, SettingsCategoryId, SettingsFacts, SettingsRow } from './lib/settingsIndex.ts';

export interface SettingsParams {
  /** Open on this topic (e.g. 'data'). */
  category?: SettingsCategoryId;
}

export function SettingsScreen({ params }: ScreenProps<SettingsParams>) {
  const nav = useNav();
  const company = useCompany();
  const session = useSession();
  const config = useCompanyConfig();
  const dataDir = useAppState().state?.dataDir ?? '';
  const secured = session !== null && !session.implicit;
  const categories = useMemo(
    () => visibleSettings(SETTINGS_INDEX, { canOpen: (id) => nav.isRegistered(id) && nav.canOpen(id), gstEnabled: company.gstEnabled, secured, gstRegistration: company.gstRegistration ?? null }),
    [nav, company.gstEnabled, company.gstRegistration, company.features, secured],
  );
  const [picked, setPicked] = useState<SettingsCategoryId | undefined>(params?.category);
  const current = categories.find((c) => c.id === picked) ?? categories[0];
  const [query, setQuery] = useState('');
  const matches = useMemo(() => searchSettings(categories, query), [categories, query]);
  // Topics whose content is on the hub itself (Appearance, the data folder): "dark", "theme" find them.
  const topicMatches = useMemo(() => searchTopics(categories, query), [categories, query]);
  const searching = query.trim() !== '';
  const facts: SettingsFacts = { companyName: company.name, gstin: company.gstin, features: company.features, config };

  const searchRef = useRef<HTMLInputElement | null>(null);
  const catsRef = useRef<HTMLUListElement | null>(null);
  const rowsRef = useRef<HTMLUListElement | null>(null);
  const cats = useRovingFocus(catsRef, {
    orientation: 'vertical',
    onNavigate: (el) => {
      const id = el.dataset.category as SettingsCategoryId | undefined;
      if (id) setPicked(id);
    },
  });
  const rows = useRovingFocus(rowsRef, { orientation: 'vertical' });

  const open = (row: SettingsRow) => nav.push(row.screen, row.params ?? {});
  /** A topic found by the search: show it (the search is cleared). */
  const showTopic = (c: SettingsCategory) => {
    setPicked(c.id);
    setQuery('');
  };
  const focusRows = () => rows.focusItem(0);
  const focusCats = () => {
    const items = cats.getItems();
    const i = items.findIndex((el) => el.getAttribute('aria-current') === 'true');
    cats.focusItem(Math.max(0, i));
  };

  const onSearchKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (searching) focusRows();
      else focusCats();
    } else if (e.key === 'Enter' && searching && matches[0]) {
      e.preventDefault();
      open(matches[0].row);
    } else if (e.key === 'Enter' && searching && topicMatches[0]) {
      e.preventDefault();
      showTopic(topicMatches[0]);
    }
  };
  // "Type to search" holds in the lists too: a printable key continues in the search box.
  const typeToSearch = (e: ReactKeyboardEvent<HTMLElement>): boolean => {
    if (e.key.length !== 1 || e.key === ' ' || e.ctrlKey || e.altKey || e.metaKey) return false;
    e.preventDefault();
    setQuery((q) => q + e.key);
    searchRef.current?.focus();
    return true;
  };
  const onCatsKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (typeToSearch(e)) return;
    if (e.key === 'ArrowRight' || e.key === 'Enter') {
      e.preventDefault();
      focusRows();
      return;
    }
    cats.onKeyDown(e);
  };
  const onRowsKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (typeToSearch(e)) return;
    if (e.key === 'ArrowLeft' && !searching) {
      e.preventDefault();
      focusCats();
      return;
    }
    if (e.key === 'ArrowUp' && rows.getItems()[0] === document.activeElement) {
      e.preventDefault();
      searchRef.current?.focus();
      return;
    }
    rows.onKeyDown(e);
  };

  const shownRows: Array<{ row: SettingsRow; category: SettingsCategory }> = searching ? matches : current ? current.rows.map((row) => ({ row, category: current })) : [];

  return (
    <Screen
      title="Settings"
      subtitle="Every setting in one place. Pick a topic, then open the setting you want to change."
      icon="settings"
      actions={[{ key: 'Ctrl+F', label: 'Search', icon: 'search', onClick: () => searchRef.current?.focus(), group: 'view' }]}
      hint="Type to search · ↑↓ Move · → Settings of a topic · Enter Open · Ctrl+F Search · Esc Back"
    >
      <div className="bx-settings">
        <Stack gap={3}>
          <TextInput
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder="Search settings — e.g. logo, prefix, backup"
            leadingIcon="search"
            aria-label="Search settings"
            data-autofocus=""
            autoFocus
          />
          <nav aria-label="Settings topics">
            <ul ref={catsRef} className="bx-settings__list" onKeyDown={onCatsKey} onFocus={cats.onFocus}>
              {categories.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className="bx-settings__item"
                    data-roving-item=""
                    data-category={c.id}
                    // The chosen topic is the list's Tab stop (useRovingFocus), also when opened on a topic.
                    data-roving-active={c.id === current?.id ? '' : undefined}
                    aria-current={!searching && c.id === current?.id ? 'true' : undefined}
                    onClick={() => {
                      setPicked(c.id);
                      setQuery('');
                    }}
                  >
                    <Icon name={c.icon} size="sm" />
                    {c.title}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        </Stack>

        <Card headingLevel={2} padding="sm" title={searching ? `Results for “${query.trim()}”` : (current?.title ?? 'Settings')} subtitle={searching ? undefined : current?.description}>
          {searching && matches.length === 0 && topicMatches.length === 0 ? (
            <EmptyState
              icon="search"
              title={`No results for “${query.trim()}”`}
              body="Try another word — e.g. GSTIN, logo, prefix, password or backup. Go To (Ctrl+G) searches every screen."
              action={
                <Button
                  onClick={() => {
                    setQuery('');
                    searchRef.current?.focus();
                  }}
                >
                  Clear search
                </Button>
              }
            />
          ) : shownRows.length > 0 || (searching && topicMatches.length > 0) ? (
            <ul ref={rowsRef} className="bx-settings__list" aria-label={searching ? 'Matching settings' : `${current?.title ?? ''} settings`} onKeyDown={onRowsKey} onFocus={rows.onFocus}>
              {searching
                ? topicMatches.map((c) => (
                    <li key={`topic:${c.id}`}>
                      <button type="button" className="bx-settings__item bx-settings__row" data-roving-item="" data-topic={c.id} onClick={() => showTopic(c)}>
                        <span className="bx-settings__text">
                          <span className="bx-settings__title">{c.title}</span>
                          <span className="bx-settings__note">{c.description}</span>
                        </span>
                        <Icon name="chevron-right" size="sm" />
                      </button>
                    </li>
                  ))
                : null}
              {shownRows.map(({ row, category }) => {
                const status = settingStatus(row.id, facts);
                return (
                  <li key={`${category.id}:${row.id}`}>
                    <button type="button" className="bx-settings__item bx-settings__row" data-roving-item="" data-setting={row.id} onClick={() => open(row)}>
                      <span className="bx-settings__text">
                        <span className="bx-settings__title">{row.title}</span>
                        <span className="bx-settings__note">{searching ? `${category.title} · ${row.description}` : row.description}</span>
                        {status ? <span className="bx-settings__note">{status}</span> : null}
                      </span>
                      {row.shortcut ? <Kbd keys={row.shortcut} size="sm" tone="subtle" /> : null}
                      <Icon name="chevron-right" size="sm" />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {!searching && current?.inline === 'appearance' ? <AppearancePanel /> : null}
          {!searching && current?.inline === 'dataFolder' && dataDir ? (
            <div className="bx-folder-row">
              <span className="bx-folder-row__label">Data folder</span>
              <code className="bx-folder-row__path bx-truncate" title={dataDir}>
                {dataDir}
              </code>
              <Button size="sm" variant="ghost" icon="external" onClick={() => void native('shell.showItem', { path: dataDir }).catch(() => undefined)}>
                Show in folder
              </Button>
            </div>
          ) : null}
        </Card>
      </div>
    </Screen>
  );
}
