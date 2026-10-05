import { useId, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, Ref } from 'react';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { useControllableState } from './hooks/useControllableState.ts';
import { useRovingFocus } from './hooks/useRovingFocus.ts';
import { cx } from './lib/cx.ts';

export interface TabItem {
  id: string;
  label: ReactNode;
  icon?: IconName;
  /** Count/status shown after the label (e.g. a Badge or number). */
  badge?: ReactNode;
  disabled?: boolean;
  /** Panel content. Omit to render panels yourself with <TabPanel>. */
  content?: ReactNode;
}

export interface TabsProps {
  items: readonly TabItem[];
  value?: string;
  defaultValue?: string;
  onChange?: (id: string) => void;
  /** Accessible name of the tab list. */
  'aria-label': string;
  /** 'line' (underline, default) or 'pill' (segmented look for compact toolbars). */
  variant?: 'line' | 'pill';
  /** 'auto' selects on arrow focus (default); 'manual' requires Enter/Space. */
  activation?: 'auto' | 'manual';
  /** Keep inactive panels mounted (preserves form state). Default false. */
  keepMounted?: boolean;
  /** Content at the end of the tab row (actions). */
  end?: ReactNode;
  className?: string;
  panelClassName?: string;
  ref?: Ref<HTMLDivElement>;
}

/**
 * Tabs with roving tabindex (←/→, Home/End) and Ctrl+Tab / Ctrl+Shift+Tab to cycle from anywhere
 * inside the tab set (including the panel).
 */
export function Tabs({
  items,
  value,
  defaultValue,
  onChange,
  variant = 'line',
  activation = 'auto',
  keepMounted = false,
  end,
  className,
  panelClassName,
  ref,
  ...aria
}: TabsProps) {
  const enabled = items.filter((t) => !t.disabled);
  const [selected, setSelected] = useControllableState<string>({ value, defaultValue: defaultValue ?? enabled[0]?.id ?? '', onChange });
  const listRef = useRef<HTMLDivElement | null>(null);
  const baseId = useId();
  const tabId = (id: string) => `${baseId}-tab-${id}`;
  const panelId = (id: string) => `${baseId}-panel-${id}`;
  const roving = useRovingFocus(listRef, {
    orientation: 'horizontal',
    loop: true,
    manageTabIndex: false,
    onNavigate: (el) => {
      if (activation !== 'auto') return;
      const id = el.getAttribute('data-tab-id');
      if (id) setSelected(id);
    },
  });

  const cycle = (dir: 1 | -1) => {
    if (enabled.length === 0) return;
    const i = enabled.findIndex((t) => t.id === selected);
    const next = enabled[(i + dir + enabled.length) % enabled.length];
    setSelected(next.id);
    // Focus follows only when focus was on the tab list; otherwise stay in the panel.
    if (listRef.current?.contains(document.activeElement)) {
      listRef.current.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(next.id)}"]`)?.focus();
    }
  };

  const onRootKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab' && e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      cycle(e.shiftKey ? -1 : 1);
    }
  };

  const hasPanels = items.some((t) => t.content !== undefined);
  return (
    <div ref={ref} className={cx('bx-tabs', `bx-tabs--${variant}`, className)} onKeyDown={onRootKeyDown}>
      <div className="bx-tabs__bar">
        <div ref={listRef} role="tablist" aria-label={aria['aria-label']} className="bx-tabs__list" onKeyDown={roving.onKeyDown}>
          {items.map((t) => {
            const isSel = t.id === selected;
            return (
              <button
                key={t.id}
                id={tabId(t.id)}
                type="button"
                role="tab"
                aria-selected={isSel}
                aria-controls={hasPanels ? panelId(t.id) : undefined}
                tabIndex={isSel ? 0 : -1}
                disabled={t.disabled}
                data-roving-item=""
                data-tab-id={t.id}
                className={cx('bx-tab', isSel && 'is-selected')}
                onClick={() => setSelected(t.id)}
              >
                {t.icon ? <Icon name={t.icon} size="sm" /> : null}
                <span className="bx-tab__label">{t.label}</span>
                {t.badge !== undefined && t.badge !== null ? <span className="bx-tab__badge">{t.badge}</span> : null}
              </button>
            );
          })}
        </div>
        {end ? <div className="bx-tabs__end">{end}</div> : null}
      </div>
      {hasPanels
        ? items.map((t) => {
            const isSel = t.id === selected;
            if (!isSel && !keepMounted) return null;
            return (
              <div
                key={t.id}
                id={panelId(t.id)}
                role="tabpanel"
                aria-labelledby={tabId(t.id)}
                hidden={!isSel}
                tabIndex={0}
                className={cx('bx-tabs__panel', panelClassName)}
              >
                {t.content}
              </div>
            );
          })
        : null}
    </div>
  );
}
