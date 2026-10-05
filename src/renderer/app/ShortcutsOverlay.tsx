/**
 * Keyboard shortcuts (F1 / Ctrl+H): a searchable table of every global key, the current screen's
 * actions and the conventions all screens follow. Also used full-page by 'company.shortcuts'.
 */
import { useMemo, useRef, useState } from 'react';
import { Kbd, Modal, TextInput } from '../ui/index.ts';
import { CONVENTION_SHORTCUTS, filterShortcuts, GLOBAL_SHORTCUTS } from './lib/shortcuts.ts';
import type { ShortcutDef } from './lib/shortcuts.ts';
import { useEntryTitle, useNavStack, useTopScreenActions } from './nav.tsx';

export interface ShortcutRow extends ShortcutDef {
  id: string;
  /** Overrides the group heading (e.g. "This screen — Day Book"). */
  groupLabel?: string;
}
type Row = ShortcutRow;

export function useShortcutRows(): Row[] {
  const stack = useNavStack();
  const top = stack[stack.length - 1];
  const title = useEntryTitle(top);
  const { items } = useTopScreenActions();
  return useMemo(() => {
    const screen: Row[] = items
      .filter((i) => !i.hidden)
      .map((i, n) => ({ id: `screen-${n}`, keys: i.key, label: i.label, group: 'Navigation' as const, global: false, description: `${title} screen` }));
    return [
      ...screen.map((r) => ({ ...r, groupLabel: `This screen — ${title}` })),
      ...GLOBAL_SHORTCUTS.map((s, n) => ({ ...s, id: `g-${n}` })),
      ...CONVENTION_SHORTCUTS.map((s, n) => ({ ...s, id: `c-${n}` })),
    ];
  }, [items, title]);
}

function groupOf(r: Row): string {
  return r.groupLabel ?? r.group;
}

export function ShortcutsTable({ rows, query }: { rows: readonly Row[]; query: string }) {
  const filtered = filterShortcuts(rows, query);
  const groups = new Map<string, Row[]>();
  for (const r of filtered) {
    const g = groupOf(r);
    const list = groups.get(g);
    if (list) list.push(r);
    else groups.set(g, [r]);
  }
  if (filtered.length === 0) return <p className="bx-shortcuts__empty">No shortcut matches “{query}”.</p>;
  return (
    <div className="bx-shortcuts">
      {[...groups].map(([group, list]) => (
        <section key={group} className="bx-shortcuts__group" aria-label={group}>
          <h3 className="bx-shortcuts__heading">{group}</h3>
          <table className="bx-shortcuts__table">
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td className="bx-shortcuts__keys">
                    <Kbd keys={r.keys} size="sm" />
                  </td>
                  <td className="bx-shortcuts__label">
                    {r.label}
                    {r.description ? <span className="bx-shortcuts__desc">{r.description}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const rows = useShortcutRows();
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <Modal open onClose={onClose} title="Keyboard Shortcuts" description="Everything in Bahi ERP works from the keyboard." size="lg" initialFocusRef={inputRef}>
      <div className="bx-shortcuts-overlay">
        <TextInput
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search shortcuts — e.g. sales, period, print"
          leadingIcon="search"
          aria-label="Search shortcuts"
        />
        <ShortcutsTable rows={rows} query={query} />
      </div>
    </Modal>
  );
}
