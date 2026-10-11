/**
 * Keyboard shortcuts (F1 / Ctrl+H): a searchable table of every global key, the current screen's
 * actions and the conventions all screens follow. Also used full-page by 'company.shortcuts'.
 *
 * 2.1 (SPEC-21 D32, §1.12): F1 is the one complete card and the only place keys are drawn as boxed
 * keycaps. "This screen — <title>" comes first: the screen's hint line (the 2.0 status-bar text,
 * unchanged) and then each of its actions that has a key; then the global keys and the conventions.
 * Descriptions are not printed under the rows: they show on hover and still match the search. Rows
 * and groups are built by the pure helpers of lib/shortcuts.ts (tested in shortcuts.test.ts).
 */
import { useMemo, useRef, useState } from 'react';
import { Kbd, Modal, TextInput } from '../ui/index.ts';
import { shortcutGroups, shortcutRows } from './lib/shortcuts.ts';
import type { ShortcutRow, ThisScreen } from './lib/shortcuts.ts';
import { useEntryTitle, useNavStack, useTopScreenActions, useTopScreenHint } from './nav.tsx';

export type { ShortcutRow, ThisScreen };

export function useShortcutRows(): ShortcutRow[] {
  const stack = useNavStack();
  const title = useEntryTitle(stack[stack.length - 1]);
  const { items } = useTopScreenActions();
  return useMemo(() => shortcutRows(items, title), [items, title]);
}

/** The screen on top (title + hint line) for the "This screen" group. */
export function useThisScreen(): ThisScreen {
  const stack = useNavStack();
  const title = useEntryTitle(stack[stack.length - 1]);
  const hint = useTopScreenHint();
  return useMemo(() => ({ title, hint: hint || undefined }), [title, hint]);
}

/** "Hold Ctrl" is a gesture, not a combination: the word stays text, the key is boxed. */
function Keys({ keys }: { keys: string }) {
  const hold = /^Hold (.+)$/.exec(keys);
  if (hold) {
    return (
      <>
        Hold <Kbd keys={hold[1]} size="sm" />
      </>
    );
  }
  return <Kbd keys={keys} size="sm" />;
}

export function ShortcutsTable({ rows, query, thisScreen }: { rows: readonly ShortcutRow[]; query: string; thisScreen?: ThisScreen }) {
  const groups = shortcutGroups(rows, query, thisScreen);
  if (groups.length === 0) return <p className="bx-shortcuts__empty">No shortcut matches “{query}”.</p>;
  return (
    <div className="bx-shortcuts">
      {groups.map((group) => (
        <section key={group.label} className="bx-shortcuts__group" aria-label={group.label}>
          <h3 className="bx-shortcuts__heading">{group.label}</h3>
          {group.hint ? <p className="bx-shortcuts__hint">{group.hint}</p> : null}
          {group.rows.length > 0 ? (
            <table className="bx-shortcuts__table">
              <tbody>
                {group.rows.map((r) => (
                  <tr key={r.id} title={r.groupLabel ? undefined : r.description}>
                    <td className="bx-shortcuts__keys">
                      <Keys keys={r.keys} />
                    </td>
                    <td>{r.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
      ))}
    </div>
  );
}

export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const rows = useShortcutRows();
  const thisScreen = useThisScreen();
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <Modal open onClose={onClose} title="Keyboard shortcuts" size="lg" initialFocusRef={inputRef}>
      <div className="bx-shortcuts-overlay">
        <TextInput ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a key" leadingIcon="search" aria-label="Search shortcuts" />
        <ShortcutsTable rows={rows} query={query} thisScreen={thisScreen} />
      </div>
    </Modal>
  );
}
