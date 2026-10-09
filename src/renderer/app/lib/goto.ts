/**
 * Go To palette — pure ranking, recents and the async provider registry (tested in goto.test.ts).
 *
 * Ranking reuses the picker matcher (ui/lib/match.ts: exact > prefix > word-start > infix > initials,
 * alias/keywords) and falls back to an in-order subsequence match ("blsht" → Balance Sheet) so
 * sloppy typing still finds things. Recently opened items get a small boost.
 */
import { matchFields, mergeRanges } from '../../ui/lib/match.ts';
import type { Range } from '../../ui/lib/match.ts';

export interface GotoItem {
  /** Unique across all sources, e.g. 'menu:accounts:…', 'ledger:42'. */
  id: string;
  label: string;
  /** Group heading in the palette ('Screens', 'Ledgers', 'Vouchers', 'Recent'). */
  group: string;
  /** Secondary line (section, group name, voucher date & amount…). */
  description?: string;
  keywords?: readonly string[];
  /** Hotkey chip shown on the right ('F8'). */
  hotkey?: string;
  /** Screen to open ('' for shell commands). */
  screen: string;
  params?: Readonly<Record<string, unknown>>;
  /** Shell command instead of a screen ('date', 'period', 'switch-company', 'shortcuts', …). */
  command?: string;
  /**
   * Where to go instead when the user may not open `screen` (e.g. a ledger → its Ledger report,
   * else its master form). Results that can be opened neither way are not offered.
   */
  fallback?: { screen: string; params?: Readonly<Record<string, unknown>> };
}

export interface RankedGoto {
  item: GotoItem;
  score: number;
  /** Highlight ranges in the label. */
  ranges: Range[];
}

/** In-order subsequence match with a score that rewards contiguous runs and word starts. */
export function subsequenceMatch(label: string, query: string): { score: number; ranges: Range[] } | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return null;
  const text = label.toLowerCase();
  const hits: number[] = [];
  let from = 0;
  for (const ch of q) {
    const i = text.indexOf(ch, from);
    if (i < 0) return null;
    hits.push(i);
    from = i + 1;
  }
  let score = 0;
  for (let k = 0; k < hits.length; k++) {
    const i = hits[k];
    if (k > 0 && hits[k - 1] === i - 1) score += 3;
    if (i === 0 || /[^a-z0-9]/.test(text[i - 1])) score += 2;
  }
  // Penalise spread-out matches.
  score -= Math.floor((hits[hits.length - 1] - hits[0]) / 4);
  return { score: Math.max(1, score), ranges: mergeRanges(hits.map((i) => [i, i + 1] as const)) };
}

export function scoreGotoItem(item: GotoItem, query: string): { score: number; ranges: Range[] } | null {
  const m = matchFields({ label: item.label, keywords: [...(item.keywords ?? []), item.description ?? ''] }, query);
  if (m) return { score: m.score + 100, ranges: m.ranges };
  return subsequenceMatch(item.label, query);
}

/**
 * Rank items for a query. Empty query → recents first (in recency order), then the rest in their
 * original order. Recent items get +40…+5 depending on recency. Ties keep the original order.
 */
export function rankGoto(items: readonly GotoItem[], query: string, recentIds: readonly string[] = [], limit = 50): RankedGoto[] {
  const recentRank = new Map(recentIds.map((id, i) => [id, i]));
  const boost = (id: string): number => {
    const r = recentRank.get(id);
    return r === undefined ? 0 : Math.max(5, 40 - r * 5);
  };
  const q = query.trim();
  const ranked: Array<RankedGoto & { order: number }> = [];
  items.forEach((item, order) => {
    if (!q) {
      ranked.push({ item, score: boost(item.id), ranges: [], order });
      return;
    }
    const m = scoreGotoItem(item, q);
    if (m) ranked.push({ item, score: m.score + boost(item.id), ranges: m.ranges, order });
  });
  ranked.sort((a, b) => b.score - a.score || a.order - b.order);
  return ranked.slice(0, limit).map(({ item, score, ranges }) => ({ item, score, ranges }));
}

/** Most-recent-first list of ids without duplicates. */
export function pushRecent<T extends { id: string }>(list: readonly T[], item: T, max = 8): T[] {
  return [item, ...list.filter((x) => x.id !== item.id)].slice(0, max);
}

/** De-duplicate by id, keeping the first occurrence. */
export function uniqueById<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
  }
  return out;
}

// ───────────────────────────── Async providers ─────────────────────────────

export interface GotoProvider {
  /** Unique id; registering the same id again replaces the previous provider (e.g. a built-in). */
  id: string;
  /** Group heading for its results ('Ledgers'). */
  label: string;
  /** Minimum query length before `search` runs (default 2). */
  minQuery?: number;
  /** Return matches for the query. Throwing/rejecting is treated as "no results" (silent). */
  search: (query: string, signal: AbortSignal) => Promise<readonly GotoItem[]>;
  /**
   * Screens its results open. The palette runs the provider only when the user may open at least
   * one of them (no pointless — or forbidden — API calls for users without access).
   */
  screens?: readonly string[];
}

const providers = new Map<string, GotoProvider>();
const providerListeners = new Set<() => void>();

/**
 * Add a Go To source (masters, vouchers…). Returns an unregister function. Registering an id that
 * already exists replaces it — except `{ builtin: true }` registrations (the shell's fallbacks),
 * which never replace a provider a feature module registered.
 */
export function registerGotoProvider(provider: GotoProvider, options: { builtin?: boolean } = {}): () => void {
  if (options.builtin && providers.has(provider.id)) return () => undefined;
  providers.set(provider.id, provider);
  for (const l of [...providerListeners]) l();
  return () => {
    if (providers.get(provider.id) === provider) {
      providers.delete(provider.id);
      for (const l of [...providerListeners]) l();
    }
  };
}

export function getGotoProviders(): GotoProvider[] {
  return [...providers.values()];
}

export function onGotoProvidersChange(listener: () => void): () => void {
  providerListeners.add(listener);
  return () => {
    providerListeners.delete(listener);
  };
}

/** Run every provider for a query; failures and slow providers never break the palette. */
export async function searchProviders(query: string, signal: AbortSignal, list: readonly GotoProvider[] = getGotoProviders()): Promise<GotoItem[]> {
  const q = query.trim();
  const runs = list
    .filter((p) => q.length >= (p.minQuery ?? 2))
    .map(async (p) => {
      try {
        const items = await p.search(q, signal);
        return items.map((i) => ({ ...i, group: i.group || p.label }));
      } catch {
        return [] as GotoItem[];
      }
    });
  const results = await Promise.all(runs);
  return uniqueById(results.flat());
}

/** Providers worth running for this user (see GotoProvider.screens). */
export function usableProviders(list: readonly GotoProvider[], canOpen: (screen: string) => boolean): GotoProvider[] {
  return list.filter((p) => !p.screens || p.screens.length === 0 || p.screens.some((s) => canOpen(s)));
}

/**
 * An async result as the user may open it: commands as they are; a screen the user may open as it
 * is; otherwise its fallback (when allowed); otherwise null (not offered).
 */
export function resolveGotoTarget(item: GotoItem, canOpen: (screen: string) => boolean): GotoItem | null {
  if (item.command) return item;
  if (item.screen && canOpen(item.screen)) return item;
  const f = item.fallback;
  if (f && canOpen(f.screen)) return { ...item, screen: f.screen, params: f.params, fallback: undefined };
  return null;
}
