/**
 * Gateway (home screen 'app.gateway'): every module's menu in sections on the left — arrow keys,
 * Enter, or the highlighted letter opens an item (Tally style) — and the dashboard (or a welcome
 * panel with quick actions and a getting-started checklist) on the right.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Card, Checkbox, Icon, Kbd, ProgressBar, Tooltip, toAriaKeyShortcut, useHotkeys, useRovingFocus } from '../ui/index.ts';
import type { IconName } from '../ui/index.ts';
import { buildGateway, splitAccelerator } from './lib/menu.ts';
import type { BuiltMenuItem } from './lib/menu.ts';
import { ScreenErrorBoundary, useModules, useNav, useScreenTitle, useStatusHint } from './nav.tsx';
import { useShell } from './shell.tsx';
import { useAppState } from './state.tsx';
import { formatDate } from '../../shared/dates.ts';
import { useWorkingDate } from './working.tsx';
import { WELL_KNOWN_SCREENS } from './wellKnown.ts';

export { WELL_KNOWN_SCREENS };


export function GatewayScreen() {
  const nav = useNav();
  const app = useAppState();
  const modules = useModules();
  useScreenTitle('Gateway');
  useStatusHint('↑↓ Move · Enter Open · Highlighted letter opens · Ctrl+G Go To');

  const sections = useMemo(
    () => buildGateway(modules, { can: app.can, gstEnabled: app.company?.gstEnabled ?? false, features: app.company?.features ?? null }),
    [modules, app.can, app.company],
  );
  const items = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  const open = (item: BuiltMenuItem) => nav.push(item.screen, item.params ?? {});

  const map: Record<string, () => void> = {};
  for (const it of items) if (it.accelerator) map[it.accelerator] = () => open(it);
  useHotkeys(map, [items]);

  const listRef = useRef<HTMLDivElement | null>(null);
  const roving = useRovingFocus(listRef, { orientation: 'vertical', loop: true });

  const dashboard = nav.isRegistered(WELL_KNOWN_SCREENS.dashboard) && nav.canOpen(WELL_KNOWN_SCREENS.dashboard) ? nav.screenDef(WELL_KNOWN_SCREENS.dashboard) : undefined;
  const Dashboard = dashboard?.component;

  return (
    <div className="bx-gateway">
      <nav className="bx-gateway__menu" aria-label="Gateway menu">
        <h1 className="bx-gateway__title">Gateway</h1>
        {sections.length === 0 ? (
          <p className="bx-gateway__empty">No menus are available for your user. Ask the company owner for access.</p>
        ) : (
          <div ref={listRef} className="bx-gateway__list" onKeyDown={roving.onKeyDown} onFocus={roving.onFocus}>
            {sections.map((section) => (
              <section key={section.id} className="bx-gateway__section" aria-labelledby={`gw-${section.id}`}>
                <h2 id={`gw-${section.id}`} className="bx-gateway__section-title">
                  {section.label}
                </h2>
                <ul className="bx-gateway__items">
                  {section.items.map((item) => (
                    <li key={item.id}>
                      <GatewayItem item={item} first={item.id === items[0]?.id} onOpen={() => open(item)} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </nav>
      <div className="bx-gateway__panel">
        {Dashboard ? (
          <ScreenErrorBoundary title="Dashboard">
            <Dashboard params={{ embedded: true }} />
          </ScreenErrorBoundary>
        ) : (
          <WelcomePanel />
        )}
      </div>
    </div>
  );
}

function ariaKeys(hotkey: string | undefined): string | undefined {
  if (!hotkey) return undefined;
  try {
    return toAriaKeyShortcut(hotkey);
  } catch {
    return undefined;
  }
}

function GatewayItem({ item, first, onOpen }: { item: BuiltMenuItem; first: boolean; onOpen: () => void }) {
  const [before, key, after] = splitAccelerator(item.label, item.accelIndex);
  const button = (
    <button
      type="button"
      className="bx-gateway__item"
      data-roving-item=""
      data-autofocus={first ? '' : undefined}
      data-text-value={item.label}
      onClick={onOpen}
      aria-keyshortcuts={[item.accelerator?.toUpperCase(), ariaKeys(item.hotkey)].filter(Boolean).join(' ') || undefined}
    >
      <span className="bx-gateway__label">
        {before}
        {key ? <span className="bx-gateway__accel">{key}</span> : null}
        {after}
      </span>
      {item.hotkey ? <Kbd keys={item.hotkey} size="sm" tone="subtle" className="bx-gateway__hotkey" /> : null}
    </button>
  );
  return item.description ? (
    <Tooltip content={item.description} placement="right">
      {button}
    </Tooltip>
  ) : (
    button
  );
}

// ───────────────────────────── Welcome panel ─────────────────────────────

interface ChecklistStep {
  id: string;
  label: string;
  body: string;
  icon: IconName;
  run: () => void;
  hidden?: boolean;
}

interface ChecklistState {
  dismissed: boolean;
  done: string[];
}

function checklistKey(companyId: string): string {
  return `bahi.gw.${companyId}`;
}

function loadChecklist(companyId: string): ChecklistState {
  try {
    const raw = window.localStorage.getItem(checklistKey(companyId));
    const p = raw ? (JSON.parse(raw) as Partial<ChecklistState>) : {};
    return { dismissed: p.dismissed === true, done: Array.isArray(p.done) ? p.done.filter((x): x is string => typeof x === 'string') : [] };
  } catch {
    return { dismissed: false, done: [] };
  }
}

function saveChecklist(companyId: string, s: ChecklistState): void {
  try {
    window.localStorage.setItem(checklistKey(companyId), JSON.stringify(s));
  } catch {
    // not remembered
  }
}

function greeting(now: Date): string {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function WelcomePanel() {
  const nav = useNav();
  const shell = useShell();
  const app = useAppState();
  const workingDate = useWorkingDate();
  const company = app.company;
  const companyId = company?.id ?? '';
  const [check, setCheck] = useState<ChecklistState>(() => loadChecklist(companyId));
  useEffect(() => saveChecklist(companyId, check), [companyId, check]);

  const markDone = (id: string) => setCheck((c) => (c.done.includes(id) ? c : { ...c, done: [...c.done, id] }));
  const toggle = (id: string, on: boolean) => setCheck((c) => ({ ...c, done: on ? [...new Set([...c.done, id])] : c.done.filter((x) => x !== id) }));

  const quick: Array<{ id: string; label: string; icon: IconName; hotkey?: string; run: () => void; hidden?: boolean }> = [
    { id: 'ledger', label: 'Create Ledger', icon: 'ledger', run: () => nav.push(WELL_KNOWN_SCREENS.ledgerForm), hidden: !app.can('masters.create') },
    { id: 'item', label: 'Create Stock Item', icon: 'box', run: () => nav.push(WELL_KNOWN_SCREENS.itemForm), hidden: !app.can('masters.create') || !company?.features.inventory },
    { id: 'sales', label: 'Sales Invoice', icon: 'invoice', hotkey: 'F8', run: () => shell.openVoucher('sales'), hidden: !app.can('vouchers.create') },
    { id: 'daybook', label: 'Day Book', icon: 'book', run: () => nav.push(WELL_KNOWN_SCREENS.dayBook), hidden: !app.can('vouchers.view') },
    { id: 'bs', label: 'Balance Sheet', icon: 'scale', run: () => nav.push(WELL_KNOWN_SCREENS.balanceSheet), hidden: !app.can('reports.financial') },
  ];

  const steps: ChecklistStep[] = [
    { id: 'profile', label: 'Check your company details', body: 'Address, GSTIN and logo appear on every invoice.', icon: 'building', run: () => nav.push(WELL_KNOWN_SCREENS.companyProfile), hidden: !app.can('company.view') },
    { id: 'features', label: 'Choose the features you need', body: 'Turn on stock, orders, cost centres and more (F11).', icon: 'sliders', run: () => nav.push(WELL_KNOWN_SCREENS.companyFeatures) },
    { id: 'ledgers', label: 'Add customers, suppliers and your bank', body: 'Create ledgers with opening balances.', icon: 'users', run: () => nav.push(WELL_KNOWN_SCREENS.ledgerForm), hidden: !app.can('masters.create') },
    { id: 'items', label: 'Add your stock items', body: 'With HSN code, GST rate and opening stock.', icon: 'box', run: () => nav.push(WELL_KNOWN_SCREENS.itemForm), hidden: !app.can('masters.create') || !company?.features.inventory },
    { id: 'sale', label: 'Record your first sale', body: 'Press F8 from anywhere to make a sales invoice.', icon: 'invoice', run: () => shell.openVoucher('sales'), hidden: !app.can('vouchers.create') },
    { id: 'backup', label: 'Set up backups', body: 'Choose a backup folder — ideally on another drive (F12).', icon: 'database', run: () => nav.push(WELL_KNOWN_SCREENS.companyConfig) },
  ];
  const visibleSteps = steps.filter((s) => !s.hidden);
  const doneCount = visibleSteps.filter((s) => check.done.includes(s.id)).length;
  const name = app.session && !app.session.implicit ? app.session.displayName || app.session.username : '';

  return (
    <div className="bx-welcome">
      <header className="bx-welcome__header">
        <p className="bx-welcome__eyebrow">{formatDate(workingDate.date)}</p>
        <h2 className="bx-welcome__title">
          {greeting(new Date())}
          {name ? `, ${name}` : ''}
        </h2>
        <p className="bx-welcome__subtitle">
          You are working in <strong>{company?.name}</strong>. Press <Kbd keys="Ctrl+G" size="sm" /> to find anything.
        </p>
      </header>

      <section aria-labelledby="welcome-quick" className="bx-welcome__quick">
        <h3 id="welcome-quick" className="bx-welcome__section-title">
          Quick actions
        </h3>
        <div className="bx-welcome__quick-grid">
          {quick
            .filter((q) => !q.hidden)
            .map((q) => (
              <button key={q.id} type="button" className="bx-quick" onClick={q.run}>
                <Icon name={q.icon} size="lg" className="bx-quick__icon" />
                <span className="bx-quick__label">{q.label}</span>
                {q.hotkey ? <Kbd keys={q.hotkey} size="sm" tone="subtle" /> : null}
              </button>
            ))}
        </div>
      </section>

      {!check.dismissed && visibleSteps.length > 0 ? (
        <Card
          className="bx-welcome__checklist"
          title="Getting started"
          subtitle={`${doneCount} of ${visibleSteps.length} done`}
          headingLevel={3}
          actions={
            <Button variant="ghost" size="sm" onClick={() => setCheck((c) => ({ ...c, dismissed: true }))}>
              Hide
            </Button>
          }
        >
          <ProgressBar value={doneCount} max={visibleSteps.length} label="Getting started progress" />
          <ol className="bx-checklist">
            {visibleSteps.map((s) => {
              const done = check.done.includes(s.id);
              return (
                <li key={s.id} className={done ? 'bx-checklist__item is-done' : 'bx-checklist__item'}>
                  <Checkbox checked={done} onChange={(on) => toggle(s.id, on)} aria-label={`Mark “${s.label}” as done`} />
                  <button
                    type="button"
                    className="bx-checklist__link"
                    onClick={() => {
                      markDone(s.id);
                      s.run();
                    }}
                  >
                    <Icon name={s.icon} size="sm" className="bx-checklist__icon" />
                    <span className="bx-checklist__text">
                      <span className="bx-checklist__label">{s.label}</span>
                      <span className="bx-checklist__body">{s.body}</span>
                    </span>
                    {done ? (
                      <Badge tone="success" size="sm" icon="check">
                        Done
                      </Badge>
                    ) : (
                      <Icon name="chevron-right" size="sm" className="bx-checklist__chevron" />
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
        </Card>
      ) : null}
    </div>
  );
}
