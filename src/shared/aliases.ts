/**
 * Alias lists in master forms (dataplus): the ledger / stock item forms show the first alias in the
 * "Alias" field and the additional aliases one per line in "More aliases". Pure helpers shared by the
 * forms and their tests; the core re-normalises everything (src/core/lib/masterAliases.ts).
 */

/** Non-blank, trimmed lines of a "More aliases" box (inner whitespace collapsed). */
export function aliasLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l !== '');
}

/** "More aliases" text for a master: every alias after the first, one per line. */
export function moreAliasesText(aliases: readonly string[] | undefined, first: string | null): string {
  const list = aliases ?? [];
  const rest = first !== null && list.length > 0 && list[0] === first ? list.slice(1) : list.filter((a) => a !== first);
  return rest.join('\n');
}

/** The complete alias list a form stands for: the Alias field, then the More aliases lines. */
export function formAliasList(first: string, moreText: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of [first.replace(/\s+/g, ' ').trim(), ...aliasLines(moreText)]) {
    if (a === '' || seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    out.push(a);
  }
  return out;
}

/** Same aliases in the same order (case-sensitive: a change of case is an alteration). */
export function sameAliasList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Problem with the "More aliases" lines as typed (client-side check; the server checks uniqueness
 * against other masters): a line equal to the name, repeated lines, or more than `max` aliases.
 */
export function moreAliasesProblem(name: string, first: string, moreText: string, max = 20): string | null {
  const lines = aliasLines(moreText);
  const n = name.trim().toLowerCase();
  if (n !== '' && lines.some((l) => l.toLowerCase() === n)) return 'An alias is the same as the name — remove that line';
  const all = [first.trim(), ...lines].filter((x) => x !== '').map((x) => x.toLowerCase());
  if (new Set(all).size !== all.length) return 'The same alias is entered twice — remove the repeated line';
  if (all.length > max) return `At most ${max} aliases (${all.length} entered)`;
  return null;
}

/** Text to search a master by: name plus every alias (pickers, Go To keywords). */
export function aliasKeywords(alias: string | null | undefined, otherAliases: readonly string[] | undefined): string[] {
  return [...(alias ? [alias] : []), ...(otherAliases ?? [])];
}
