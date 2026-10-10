/**
 * Go To catalogue snapshot — what the palette offers right now, as plain JSON, for the every-screen
 * end-to-end sweep (e2e/screens.spec.ts). Pure (tested in gotoCatalog.test.ts).
 *
 * The open palette (GotoPalette.tsx) answers a `pevqori:goto-catalog` CustomEvent dispatched on `window`
 * by writing the snapshot into the event's `detail.catalog`. Nothing is added to `window`, no state
 * changes and nothing crosses the IPC bridge: the answer is exactly the palette's own static list
 * (menu items, Go To screens, voucher types, shell commands — already filtered by the user's
 * permissions, the company's F11 features and its GST registration) plus the ids of every
 * registered screen, so a spec can enumerate the screens instead of keeping a list that drifts.
 */
import type { GotoItem } from './goto.ts';

/** Name of the request event (window.dispatchEvent(new CustomEvent(GOTO_CATALOG_EVENT, { detail }))). */
export const GOTO_CATALOG_EVENT = 'pevqori:goto-catalog';

export interface GotoCatalogEntry {
  /** The palette item id (also the option's `data-goto-id`). */
  id: string;
  label: string;
  group: string;
  description: string | null;
  /** Screen the item opens ('' for a command). */
  screen: string;
  params: Record<string, unknown> | null;
  /** Shell / voucher command ('date', 'voucher:sales', 'voucher-type:12', …) or null. */
  command: string | null;
}

export interface RegisteredScreenEntry {
  id: string;
  title: string;
  presentation: 'full' | 'dialog';
}

export interface GotoCatalogSnapshot {
  items: GotoCatalogEntry[];
  screens: RegisteredScreenEntry[];
}

/** Plain-JSON copy of the palette's items and the registered screens (params deep-copied). */
export function gotoCatalogSnapshot(
  items: readonly GotoItem[],
  screens: Iterable<{ id: string; title: string; presentation?: 'full' | 'dialog' }>,
): GotoCatalogSnapshot {
  return {
    items: items.map((i) => ({
      id: i.id,
      label: i.label,
      group: i.group,
      description: i.description ?? null,
      screen: i.screen,
      params: i.params ? (JSON.parse(JSON.stringify(i.params)) as Record<string, unknown>) : null,
      command: i.command ?? null,
    })),
    screens: [...screens].map((s) => ({ id: s.id, title: s.title, presentation: s.presentation ?? 'full' })),
  };
}

/**
 * Answer a catalogue request: when `event` is a GOTO_CATALOG_EVENT CustomEvent whose `detail` is a
 * plain object, set `detail.catalog` to the snapshot (built lazily). Returns whether it answered.
 */
export function answerGotoCatalogRequest(event: Event, build: () => GotoCatalogSnapshot): boolean {
  if (event.type !== GOTO_CATALOG_EVENT || !('detail' in event)) return false;
  const detail = (event as CustomEvent<unknown>).detail;
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return false;
  (detail as { catalog?: GotoCatalogSnapshot }).catalog = build();
  return true;
}
