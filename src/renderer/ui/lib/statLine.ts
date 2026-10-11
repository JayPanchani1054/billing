/**
 * The stat line's rules (SPEC-21 §2.2, §2.3 `StatLine`), pure so they are tested in node.
 * Money in a stat is EXACT — Indian grouping, "₹" prefix, paise only when non-zero ("₹4,65,953",
 * "₹3,43,160.32") — never compact, so it matches the table cell digit for digit.
 */
import { formatMoney } from '../../../shared/format.ts';
import type { Paise } from '../../../shared/money.ts';

/** At most three figures and one link on a stat line. */
export const STAT_MAX_FIGURES = 3;
export const STAT_MAX_LINKS = 1;

/** Exact money for a stat: "₹4,65,953" · "₹3,43,160.32" · "-₹1,200". */
export function statMoney(p: Paise): string {
  const s = formatMoney(Math.abs(p));
  const body = s.endsWith('.00') ? s.slice(0, -3) : s;
  return `${p < 0 ? '-' : ''}₹${body}`;
}

/** Drops the items whose value is a zero amount (a stat shows only what is there). */
export function dropZeros<T extends { value: unknown }>(items: readonly T[]): T[] {
  return items.filter((it) => !(typeof it.value === 'number' && it.value === 0));
}

/** What breaks the stat-line rule (empty = fine): ≤ 3 figures + ≤ 1 link. */
export function statProblems(items: readonly { link?: boolean }[]): string[] {
  const links = items.filter((i) => i.link).length;
  const figures = items.length - links;
  const out: string[] = [];
  if (figures > STAT_MAX_FIGURES) out.push(`${figures} figures (max ${STAT_MAX_FIGURES})`);
  if (links > STAT_MAX_LINKS) out.push(`${links} links (max ${STAT_MAX_LINKS})`);
  return out;
}

/**
 * The hover text of a stat item: its label (plus its own `title`). Below 1200 px of report width the
 * labels are visually hidden (styles/report.css `@container`), so the label moves to the tooltip
 * (SPEC-21 §1.2); a link item reads its label in its text and keeps only its own title.
 */
export function statTitle(item: { label: string; title?: string; link?: boolean }): string | undefined {
  if (item.link) return item.title;
  return item.title ? `${item.label} · ${item.title}` : item.label;
}
