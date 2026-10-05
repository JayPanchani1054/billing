/**
 * Self-contained printable HTML for the statement of account and payment-reminder letters
 * (sent to bahi.native('print.print' | 'print.savePdf')). Pure and deterministic: no scripts, no
 * external resources, and EVERY value goes through escapeHtml.
 */
import { formatDate } from '../../../../shared/dates.ts';
import { formatDrCr, formatMoney } from '../../../../shared/format.ts';
import type { ReminderLetter, StatementResult } from '../../../../shared/types/outstanding.ts';
import { escapeHtml } from '../../../app/lib/exportFormat.ts';

const BASE_CSS = `
@page { size: A4 portrait; margin: 14mm 14mm 16mm;
  @bottom-left { content: "FOOTER_LEFT"; font: 8pt/1.2 "Segoe UI", system-ui, sans-serif; opacity: .7; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt/1.2 "Segoe UI", system-ui, sans-serif; opacity: .7; }
}
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font: 9.5pt/1.4 "Segoe UI", system-ui, -apple-system, sans-serif; }
.letterhead { text-align: center; padding-bottom: 6pt; border-bottom: 1.5px solid currentColor; margin-bottom: 10pt; }
.letterhead .company { font-size: 14pt; font-weight: 700; }
.letterhead .line { font-size: 8.5pt; }
h1 { font-size: 12pt; text-align: center; margin: 4pt 0 8pt; letter-spacing: .04em; text-transform: uppercase; }
h2 { font-size: 10.5pt; margin: 14pt 0 4pt; }
.meta { display: flex; justify-content: space-between; gap: 16pt; margin-bottom: 10pt; }
.meta .block { max-width: 60%; }
.meta .right { text-align: right; }
.label { font-size: 8pt; text-transform: uppercase; letter-spacing: .05em; opacity: .7; }
.strong { font-weight: 700; }
table { width: 100%; border-collapse: collapse; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
th, td { padding: 3pt 5pt; text-align: left; vertical-align: top; }
th { font-weight: 600; border-top: 1px solid currentColor; border-bottom: 1px solid currentColor;
  background: color-mix(in srgb, currentColor 6%, transparent); }
td { border-bottom: 0.5px solid color-mix(in srgb, currentColor 18%, transparent); }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
tr.sub td { font-style: italic; }
tr.total td { font-weight: 700; border-top: 1px solid currentColor; }
tr.closing td { font-weight: 700; border-bottom: 2px double currentColor; }
.note { margin-top: 12pt; font-size: 8.5pt; opacity: .85; }
.empty { padding: 10pt; text-align: center; opacity: .7; }
.letter { break-after: page; }
.letter:last-child { break-after: auto; }
.letter p { margin: 0 0 8pt; }
.letter .date { text-align: right; margin-bottom: 8pt; }
.letter .to { margin-bottom: 10pt; }
.letter .subject { font-weight: 700; margin-bottom: 10pt; }
.letter table { margin: 4pt 0 12pt; }
.letter .signoff { margin-top: 14pt; }
.letter .signoff .gap { height: 22pt; }
`;

function css(footerLeft: string): string {
  // CSS string content: escape backslashes and quotes (the value is ours, but be safe).
  return BASE_CSS.replace('FOOTER_LEFT', footerLeft.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' '));
}

function doc(title: string, body: string, opts: PrintOptions): string {
  const footerLeft = `${opts.appName ?? 'Bahi ERP'}${opts.printedOn ? ` · Printed on ${formatDate(opts.printedOn)}` : ''}`;
  return [
    '<!doctype html>',
    '<html lang="en-IN"><head><meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${css(footerLeft)}</style></head><body>`,
    body,
    '</body></html>',
  ].join('\n');
}

export interface PrintOptions {
  /** ISO date for the page footer ("Printed on …"). */
  printedOn?: string;
  appName?: string;
}

/** Text with line breaks → escaped lines joined by <br>. */
function lines(text: string | null | undefined): string[] {
  return (text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

const drcr = (p: number): string => formatDrCr(p, { keepZero: true });
const amt = (p: number): string => (p === 0 ? '' : formatMoney(p));

// ───────────────────────────── Statement of account ─────────────────────────────

export function buildStatementHtml(s: StatementResult, opts: PrintOptions = {}): string {
  const c = s.company;
  const p = s.party;
  const companyLines = [
    ...lines(c.address),
    [c.stateName, c.pincode].filter(Boolean).join(' - '),
    [c.gstin ? `GSTIN: ${c.gstin}` : '', c.pan ? `PAN: ${c.pan}` : ''].filter(Boolean).join(' · '),
    [c.phone || c.mobile ? `Phone: ${c.phone || c.mobile}` : '', c.email ? `Email: ${c.email}` : ''].filter(Boolean).join(' · '),
  ].filter((l) => l !== '');
  const partyLines = [
    ...lines(p.address),
    [p.stateName, p.pincode].filter(Boolean).join(' - '),
    p.gstin ? `GSTIN: ${p.gstin}` : '',
    p.contactPerson ? `Kind attn: ${p.contactPerson}` : '',
  ].filter((l) => l !== '');
  const terms = [
    p.creditDays !== null ? `Credit period: ${p.creditDays} days` : '',
    p.creditLimit !== null ? `Credit limit: ${formatMoney(p.creditLimit, { symbol: true })}` : '',
  ].filter(Boolean);

  const head = `<tr><th>Date</th><th>Particulars</th><th>Vch type</th><th>Vch no.</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr>`;
  const body: string[] = [
    `<tr class="sub"><td>${escapeHtml(formatDate(s.from))}</td><td>Opening Balance</td><td></td><td></td><td class="num"></td><td class="num"></td><td class="num">${escapeHtml(drcr(s.openingBalance))}</td></tr>`,
  ];
  for (const t of s.transactions) {
    const particulars = t.narration ? `${escapeHtml(t.particulars)}<br><span class="label">${escapeHtml(t.narration)}</span>` : escapeHtml(t.particulars);
    body.push(
      `<tr><td>${escapeHtml(formatDate(t.date))}</td><td>${particulars}</td><td>${escapeHtml(t.voucherType)}</td><td>${escapeHtml(t.voucherNumber ?? '')}</td>` +
        `<td class="num">${escapeHtml(amt(t.debit))}</td><td class="num">${escapeHtml(amt(t.credit))}</td><td class="num">${escapeHtml(drcr(t.balance))}</td></tr>`,
    );
  }
  if (s.transactions.length === 0) body.push('<tr><td class="empty" colspan="7">No transactions in this period.</td></tr>');
  body.push(
    `<tr class="total"><td></td><td>Total</td><td></td><td></td><td class="num">${escapeHtml(formatMoney(s.totals.debit))}</td><td class="num">${escapeHtml(formatMoney(s.totals.credit))}</td><td></td></tr>`,
    `<tr class="closing"><td>${escapeHtml(formatDate(s.to))}</td><td>Closing Balance</td><td></td><td></td><td></td><td></td><td class="num">${escapeHtml(drcr(s.closingBalance))}</td></tr>`,
  );

  const pb = s.pendingBills;
  const ageHead = [...pb.buckets.map((b) => b.label), 'Advance', 'On account', 'Total'];
  const ageCells = [...pb.bucketTotals, pb.advance, pb.onAccount, pb.total];
  const ageing =
    `<table><thead><tr>${ageHead.map((h) => `<th class="num">${escapeHtml(h)}</th>`).join('')}</tr></thead>` +
    `<tbody><tr>${ageCells.map((v) => `<td class="num">${escapeHtml(v === 0 ? '' : formatDrCr(v))}</td>`).join('')}</tr></tbody></table>`;
  const billRows = pb.rows.length
    ? pb.rows
        .map(
          (b) =>
            `<tr><td>${escapeHtml(b.billName)}</td><td>${escapeHtml(formatDate(b.billDate))}</td><td>${escapeHtml(formatDate(b.dueDate))}</td>` +
            `<td class="num">${b.overdueDays > 0 ? escapeHtml(String(b.overdueDays)) : ''}</td><td class="num">${escapeHtml(formatDrCr(b.pendingAmount))}</td></tr>`,
        )
        .join('\n')
    : '<tr><td class="empty" colspan="5">No pending bills.</td></tr>';
  const onAccountRow =
    pb.onAccount !== 0
      ? `<tr class="sub"><td>On Account (not adjusted against bills)</td><td></td><td></td><td></td><td class="num">${escapeHtml(formatDrCr(pb.onAccount))}</td></tr>`
      : '';

  const html = [
    '<header class="letterhead">',
    `<div class="company">${escapeHtml(c.mailingName || c.name)}</div>`,
    ...companyLines.map((l) => `<div class="line">${escapeHtml(l)}</div>`),
    '</header>',
    '<h1>Statement of Account</h1>',
    '<div class="meta">',
    '<div class="block">',
    '<div class="label">To</div>',
    `<div class="strong">${escapeHtml(p.mailingName || p.name)}</div>`,
    ...partyLines.map((l) => `<div>${escapeHtml(l)}</div>`),
    '</div>',
    '<div class="block right">',
    `<div><span class="label">Period</span><br>${escapeHtml(formatDate(s.from))} to ${escapeHtml(formatDate(s.to))}</div>`,
    `<div><span class="label">Date</span><br>${escapeHtml(formatDate(s.generatedOn))}</div>`,
    ...terms.map((t) => `<div>${escapeHtml(t)}</div>`),
    '</div>',
    '</div>',
    `<table><thead>${head}</thead><tbody>`,
    body.join('\n'),
    '</tbody></table>',
    `<h2>Pending bills as on ${escapeHtml(formatDate(pb.asOf))}</h2>`,
    ageing,
    '<table><thead><tr><th>Bill no.</th><th>Bill date</th><th>Due date</th><th class="num">Overdue (days)</th><th class="num">Pending</th></tr></thead><tbody>',
    billRows,
    onAccountRow,
    `<tr class="closing"><td>Total outstanding</td><td></td><td></td><td></td><td class="num">${escapeHtml(drcr(pb.total))}</td></tr>`,
    '</tbody></table>',
    `<p class="note">Kindly verify this statement and confirm the balance of ${escapeHtml(drcr(s.closingBalance))} as on ${escapeHtml(formatDate(s.to))}. ` +
      'If we do not hear from you within 15 days, the balance will be treated as confirmed. This is a computer-generated statement.</p>',
  ].join('\n');
  return doc(`Statement of Account — ${p.name}`, html, opts);
}

// ───────────────────────────── Reminder letters ─────────────────────────────

const NUMERIC_CELL = /^-?[\d,]+(\.\d+)?$/;

/** One page per letter (batch printing). */
export function buildLettersHtml(letters: readonly ReminderLetter[], opts: PrintOptions = {}): string {
  const sections = letters.map((l) => {
    const numeric = l.table.columns.map((_, i) => l.table.rows.length > 0 && l.table.rows.every((r) => (r[i] ?? '') === '' || NUMERIC_CELL.test(r[i] ?? '')));
    const cell = (tag: 'th' | 'td', text: string, i: number): string => `<${tag}${numeric[i] ? ' class="num"' : ''}>${escapeHtml(text)}</${tag}>`;
    const [firstFrom, ...restFrom] = l.from;
    const [toLabel, ...toLines] = l.to;
    return [
      '<section class="letter">',
      '<header class="letterhead">',
      `<div class="company">${escapeHtml(firstFrom ?? '')}</div>`,
      ...restFrom.map((x) => `<div class="line">${escapeHtml(x)}</div>`),
      '</header>',
      `<div class="date">Date: ${escapeHtml(l.date)}</div>`,
      '<div class="to">',
      `<div>${escapeHtml(toLabel ?? '')}</div>`,
      ...toLines.map((x, i) => `<div${i === 0 ? ' class="strong"' : ''}>${escapeHtml(x)}</div>`),
      '</div>',
      `<div class="subject">Subject: ${escapeHtml(l.subject)}</div>`,
      `<p>${escapeHtml(l.salutation)}</p>`,
      ...l.opening.map((x) => `<p>${escapeHtml(x)}</p>`),
      `<table><thead><tr>${l.table.columns.map((c, i) => cell('th', c, i)).join('')}</tr></thead><tbody>`,
      ...l.table.rows.map((r) => `<tr>${l.table.columns.map((_, i) => cell('td', r[i] ?? '', i)).join('')}</tr>`),
      `<tr class="total">${l.table.columns.map((_, i) => cell('td', l.table.total[i] ?? '', i)).join('')}</tr>`,
      '</tbody></table>',
      ...l.closing.map((x) => `<p>${escapeHtml(x)}</p>`),
      '<div class="signoff">',
      ...l.signOff.map((x) => (x === '' ? '<div class="gap"></div>' : `<div>${escapeHtml(x)}</div>`)),
      '</div>',
      '</section>',
    ].join('\n');
  });
  const title = letters.length === 1 ? `Payment reminder — ${letters[0].to[1] ?? ''}` : `Payment reminders (${letters.length})`;
  return doc(title, sections.join('\n'), opts);
}

/** File name for a saved PDF: 'Statement-Acme-Traders_01-04-2026_to_30-09-2026.pdf'. */
export function pdfName(kind: 'Statement' | 'Reminder' | 'Reminders', party: string | null, from?: string, to?: string): string {
  const slug = (party ?? '')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const period = from && to ? `_${formatDate(from, 'DD-MM-YYYY')}_to_${formatDate(to, 'DD-MM-YYYY')}` : '';
  return `${kind}${slug ? `-${slug}` : ''}${period}.pdf`;
}
