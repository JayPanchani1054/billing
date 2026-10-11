/**
 * (2.1, SPEC-21 §1.11) The words of the calm print screens — pure, tested in calm.test.ts:
 *
 *   - the title row's context run of Print Preview: "Sales 33 · Asha Retail", then the state words with
 *     at most one coloured word (Cancelled, else Optional);
 *   - the layout editor's group captions ("Header", or "Header · 2 hidden" only when something is hidden)
 *     and the one line its locked parts collapse to ("Always printed: Invoice no., Date, …");
 *   - which part's notes the editor shows (the focused / clicked row — never changed between a mouse press
 *     and its release, so a click is never moved onto another row by notes collapsing above it);
 *   - the one-line "Before you print" banner text (and, for Print Vouchers, one entry per warning text);
 *   - the More item and dialog of the printer for direct printing ("Printer: Ask every time…").
 */

/** The context run of Print Preview: document title and number, then the party. */
export function previewContext(doc: { title: string; number: string | null; party: { name: string | null } | null }): string {
  const head = `${doc.title}${doc.number ? ` ${doc.number}` : ''}`;
  return doc.party?.name ? `${head} · ${doc.party.name}` : head;
}

export interface StateWord {
  text: string;
  /** The one coloured word of the context run (SPEC-21 §1.2: at most one, only for a real state). */
  tone: 'danger' | 'warning' | null;
}

/**
 * State words of Print Preview, in order: Cancelled (danger — the legal state, it stays) or Optional
 * (warning) — one of them coloured, never both — then "e-Invoice" and "Customized for this print" as
 * plain words.
 */
export function previewStateWords(s: { cancelled: boolean; optional: boolean; einvoice: boolean; customized: boolean }): StateWord[] {
  const out: StateWord[] = [];
  if (s.cancelled) out.push({ text: 'Cancelled', tone: 'danger' });
  if (s.optional) out.push({ text: 'Optional', tone: s.cancelled ? null : 'warning' });
  if (s.einvoice) out.push({ text: 'e-Invoice', tone: null });
  if (s.customized) out.push({ text: 'Customized for this print', tone: null });
  return out;
}

/** Rows of an editor group, as the caption needs them. */
export interface CaptionRow {
  shown: boolean;
  locked: boolean;
}

/** How many switchable parts of a group are off. Locked parts always print. */
export function hiddenCount(rows: readonly CaptionRow[]): number {
  return rows.filter((r) => !r.locked && !r.shown).length;
}

/** "Header", or "Header · 2 hidden" when something in the group is hidden (2.0 printed "(n of m shown)"). */
export function groupCaption(label: string, rows: readonly CaptionRow[]): string {
  const n = hiddenCount(rows);
  return n > 0 ? `${label} · ${n} hidden` : label;
}

/** The one line a group's locked parts collapse to; '' when the group has none. */
export function alwaysPrintedText(labels: readonly string[]): string {
  return labels.length > 0 ? `Always printed: ${labels.join(', ')}` : '';
}

/**
 * What moves the editor's "notes" row (the one part whose notes are visible):
 *   - `focus`: a row's switch got the focus — by keyboard or click-to-select (`pointerDown` false), or by a
 *     mouse press inside the panel (`pointerDown` true);
 *   - `click`: a row was clicked (after the button was released);
 *   - `leave`: the focus went to something outside the panel.
 */
export type NoteEvent = { type: 'focus'; row: string; pointerDown: boolean } | { type: 'click'; row: string } | { type: 'leave' };

/**
 * The row whose notes show after `e`. A focus that comes with a mouse press changes nothing: hiding the
 * notes of a row above the pressed one would move the pressed control up between the press and the release,
 * and the click would land on whatever slid under the pointer (or nowhere). The click itself then selects
 * the row, after the release.
 */
export function activeNoteRow(current: string | null, e: NoteEvent): string | null {
  if (e.type === 'leave') return null;
  if (e.type === 'click') return e.row;
  return e.pointerDown ? current : e.row;
}

/** The body of the one-line "Before you print" banner: every warning, in order, on one line. */
export function warningsLine(warnings: readonly string[]): string {
  return warnings
    .map((w) => w.trim())
    .filter((w) => w !== '')
    .join(' · ');
}

export interface PrinterInfo {
  name: string;
  displayName: string;
}

/** What the "Ask every time" choice is called ('' = the OS print dialog). */
export const ASK_EVERY_TIME = 'Ask every time';

/** The printer's display name ('' → "Ask every time"; an unknown saved name is shown as it is). */
export function printerName(printer: string, printers: readonly PrinterInfo[] | null): string {
  if (printer === '') return ASK_EVERY_TIME;
  return (printers ?? []).find((p) => p.name === printer)?.displayName ?? printer;
}

/** "Printer" for sheets, "Receipt printer" for a thermal roll. */
export function printerTitle(roll: boolean): string {
  return roll ? 'Receipt printer' : 'Printer';
}

/** The keyless More item that opens the printer choice: "Printer: Ask every time…". */
export function printerItemLabel(printer: string, printers: readonly PrinterInfo[] | null, roll: boolean): string {
  return `${printerTitle(roll)}: ${printerName(printer, printers)}…`;
}

/** Options of the printer select: ask every time, the installed printers, and a saved one no longer listed. */
export function printerOptions(printer: string, printers: readonly PrinterInfo[] | null): Array<{ value: string; label: string }> {
  const list = printers ?? [];
  return [
    { value: '', label: `${ASK_EVERY_TIME} (printer dialog)` },
    ...list.map((p) => ({ value: p.name, label: p.displayName })),
    ...(printer && !list.some((p) => p.name === printer) ? [{ value: printer, label: printer }] : []),
  ];
}

/**
 * Print Vouchers: the warnings of many documents, one entry per warning text with the documents it applies
 * to ("Sales 33, Sales 34: …"), in first-seen order — the same rule hidden on fifty invoices is one entry,
 * not fifty.
 */
export function mergeDocWarnings(docs: ReadonlyArray<{ label: string; warnings: readonly string[] }>): string[] {
  const byText = new Map<string, string[]>();
  for (const d of docs) {
    const label = d.label.trim();
    for (const raw of d.warnings) {
      const w = raw.trim();
      if (w === '') continue;
      const labels = byText.get(w) ?? [];
      if (!labels.includes(label)) labels.push(label);
      byText.set(w, labels);
    }
  }
  return [...byText].map(([w, labels]) => {
    const named = labels.filter((l) => l !== '');
    return named.length > 0 ? `${named.join(', ')}: ${w}` : w;
  });
}
