/**
 * Payment reminders: debtors with bills overdue by at least `minOverdueDays`, each with a polite
 * reminder letter as structured data + plain text (no HTML; the print/UI layer renders it).
 *
 * Selection: a party qualifies when it has positive bills overdue ≥ minOverdueDays AND
 * amountDue = Σ those bills + unadjusted credits (advances, credit bills, credit on account) > 0 —
 * a customer whose unadjusted payments already cover the overdue bills is not chased.
 * Tone follows the oldest overdue bill: ≤ 30 days gentle, 31–60 second reminder, > 60 firm (still polite).
 */
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import { stateName } from '../../../shared/gst/states.ts';
import type { ReminderBill, ReminderLetter, ReminderParty, ReminderTone, RemindersInput, RemindersResult } from '../../../shared/types/outstanding.ts';
import type { Db } from '../../db/db.ts';
import { getCompanyProfile } from '../company/service.ts';
import { overdueDays } from './engine.ts';
import { sideParties } from './reports.ts';

export interface LetterCompany {
  name: string;
  address: string | null;
  stateCode: string | null;
  pincode: string | null;
  phone: string | null;
  mobile: string | null;
  email: string | null;
  gstin: string | null;
}

export interface LetterParty {
  name: string;
  mailingName: string | null;
  address: string | null;
  stateCode: string | null;
  pincode: string | null;
  contactPerson: string | null;
  gstin: string | null;
}

export interface LetterData {
  company: LetterCompany;
  party: LetterParty;
  /** Letter date (the working date). */
  date: string;
  /** Outstanding position date. */
  asOf: string;
  bills: readonly ReminderBill[];
  totalOverdue: number;
  /** ≤ 0. */
  unadjustedCredits: number;
  amountDue: number;
  tone: ReminderTone;
  oldestOverdueDays: number;
}

export function toneFor(oldestOverdueDays: number): ReminderTone {
  return oldestOverdueDays > 60 ? 'firm' : oldestOverdueDays > 30 ? 'second' : 'gentle';
}

const rupees = (p: number): string => formatMoney(p, { symbol: true });

/** Address text → lines (newlines or commas are kept as typed; blank lines dropped) + "State - PIN". */
export function addressLines(address: string | null, stateCode: string | null, pincode: string | null): string[] {
  const lines = (address ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const state = stateName(stateCode);
  const last = [state, pincode?.trim() ?? ''].filter((s) => s !== '').join(' - ');
  if (last) lines.push(last);
  return lines;
}

function renderTable(columns: readonly string[], rows: readonly string[][], total: readonly string[], rightAligned: ReadonlySet<number>): string[] {
  const all = [columns, ...rows, total];
  const widths = columns.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  const fmt = (r: readonly string[]): string =>
    r
      .map((c, i) => (rightAligned.has(i) ? (c ?? '').padStart(widths[i]) : (c ?? '').padEnd(widths[i])))
      .join('  ')
      .trimEnd();
  const rule = widths.map((w) => '-'.repeat(w)).join('  ');
  return [fmt(columns), rule, ...rows.map(fmt), rule, fmt(total)];
}

/** Build the reminder letter. Pure (testable without a database). */
export function buildReminderLetter(d: LetterData): ReminderLetter {
  const asOf = formatDate(d.asOf);
  const count = d.bills.length;
  const billWord = count === 1 ? 'bill' : 'bills';
  const from = [d.company.name, ...addressLines(d.company.address, d.company.stateCode, d.company.pincode)];
  if (d.company.gstin) from.push(`GSTIN: ${d.company.gstin}`);
  const to = ['To,', d.party.mailingName || d.party.name, ...addressLines(d.party.address, d.party.stateCode, d.party.pincode)];
  if (d.party.gstin) to.push(`GSTIN: ${d.party.gstin}`);

  const due = rupees(d.amountDue);
  let subject: string;
  let opening: string[];
  let closing: string[];
  switch (d.tone) {
    case 'firm':
      subject = `Request for payment of overdue ${billWord} — ${due}`;
      opening = [
        `As per our books of account, the following ${billWord} ${count === 1 ? 'remains' : 'remain'} unpaid as on ${asOf}, ` +
          `the oldest being overdue by ${d.oldestOverdueDays} days:`,
      ];
      closing = [
        `The due dates of these bills passed some time ago. We request you to kindly clear the payment of ${due} within 7 days of the date of this letter. ` +
          'If the payment has already been made, please share the details (date, amount and reference/UTR number) so that we can update our records; ' +
          'if you have any concern about these bills, please contact us immediately so that it can be resolved.',
        'We would appreciate your prompt attention to this matter and thank you for your cooperation.',
      ];
      break;
    case 'second':
      subject = `Second reminder: overdue ${billWord} — ${due}`;
      opening = [
        `We write to bring to your kind attention that, as per our books of account, the following ${billWord} ` +
          `${count === 1 ? 'remains' : 'remain'} unpaid beyond the due date as on ${asOf}:`,
      ];
      closing = [
        `We request you to kindly arrange the payment of ${due} within the next 7 days. ` +
          'If the payment has already been made, please share the details (date, amount and reference/UTR number) so that we can reconcile our records. ' +
          'If there is any discrepancy in the bills listed above, please let us know so that it can be resolved promptly.',
        'We value our association and look forward to your early response.',
      ];
      break;
    default:
      subject = `Payment reminder: overdue ${billWord} — ${due}`;
      opening = [
        'We hope this letter finds you well.',
        `This is a gentle reminder that, as per our books of account, the following ${billWord} ` +
          `${count === 1 ? 'was' : 'were'} not yet paid on the due date and ${count === 1 ? 'is' : 'are'} outstanding as on ${asOf}:`,
      ];
      closing = [
        `We request you to kindly arrange the payment of ${due} at your earliest convenience. ` +
          'If you have already made the payment, please ignore this reminder and share the payment details (date, amount and reference/UTR number) ' +
          'so that we may update our records.',
        'Thank you for your continued business.',
      ];
  }
  if (d.unadjustedCredits < 0) {
    closing.unshift(
      `Our records also show ${rupees(-d.unadjustedCredits)} received from you in advance, on account or as credit notes that is not yet ` +
        `adjusted against specific bills. After adjusting it, the net amount due is ${due}. ` +
        'Kindly let us know the bills against which it should be applied.',
    );
  }
  const contact = [d.company.phone || d.company.mobile, d.company.email].filter((s): s is string => !!s);
  if (contact.length > 0) closing.push(`For any clarification, please contact us at ${contact.join(' or ')}.`);

  const columns = ['Bill No.', 'Bill Date', 'Due Date', 'Overdue (days)', 'Amount (₹)'];
  const rows = d.bills.map((b) => [b.billName, formatDate(b.billDate), formatDate(b.dueDate), String(b.overdueDays), formatMoney(b.pendingAmount)]);
  const total = ['Total overdue', '', '', '', formatMoney(d.totalOverdue)];
  const salutation = d.party.contactPerson ? `Dear ${d.party.contactPerson},` : 'Dear Sir/Madam,';
  const signOff = ['Yours faithfully,', `For ${d.company.name}`, '', '', 'Authorised Signatory'];
  const date = formatDate(d.date);

  const text = [
    from.join('\n'),
    `Date: ${date}`,
    to.join('\n'),
    `Subject: ${subject}`,
    salutation,
    ...opening,
    renderTable(columns, rows, total, new Set([3, 4])).join('\n'),
    ...closing,
    signOff.join('\n'),
  ].join('\n\n');

  return { date, from, to, subject, salutation, opening, table: { columns, rows, total }, closing, signOff, text: `${text}\n` };
}

interface PartyDetailRow {
  id: number;
  mailing_name: string | null;
  address: string | null;
  state_code: string | null;
  pincode: string | null;
  contact_person: string | null;
  gstin: string | null;
}

export function reminders(db: Db, today: string, input: RemindersInput): RemindersResult {
  const minOverdueDays = input.minOverdueDays ?? 1;
  const parties = sideParties(db, today, {
    side: 'receivable',
    asOf: input.asOf,
    groupId: input.groupId,
    ledgerId: input.ledgerId,
    nonBillWise: input.nonBillWise,
  });
  const profile = getCompanyProfile(db);
  const company: LetterCompany = {
    name: profile.mailingName || profile.name,
    address: profile.address,
    stateCode: profile.stateCode,
    pincode: profile.pincode,
    phone: profile.phone,
    mobile: profile.mobile,
    email: profile.email,
    gstin: profile.gstin,
  };

  const out: ReminderParty[] = [];
  let amountDueTotal = 0;
  const selected: Array<{ p: (typeof parties)[number]; bills: ReminderBill[]; totalOverdue: number; credits: number; amountDue: number; oldest: number }> = [];
  for (const p of parties) {
    const bills: ReminderBill[] = [];
    let credits = Math.min(0, p.onAccount);
    let totalOverdue = 0;
    let oldest = 0;
    for (const b of p.bills) {
      if (b.pending < 0) {
        credits += b.pending;
        continue;
      }
      if (b.refType === 'advance') continue;
      const od = overdueDays(b, input.asOf);
      if (b.pending === 0 || od < minOverdueDays || od === 0) continue;
      bills.push({ billName: b.billName, billDate: b.billDate, dueDate: b.dueDate, pendingAmount: b.pending, overdueDays: od });
      totalOverdue += b.pending;
      if (od > oldest) oldest = od;
    }
    const amountDue = Math.max(0, totalOverdue + credits);
    if (bills.length === 0 || amountDue <= 0) continue;
    selected.push({ p, bills, totalOverdue, credits, amountDue, oldest });
  }

  const details = new Map(
    db
      .all<PartyDetailRow>(
        `SELECT id, mailing_name, address, state_code, pincode, contact_person, gstin FROM ledgers
          WHERE id IN (SELECT value FROM json_each(:ids))`,
        { ids: JSON.stringify(selected.map((s) => s.p.ledger.id)) },
      )
      .map((r) => [r.id, r]),
  );

  for (const s of selected) {
    const det = details.get(s.p.ledger.id);
    const tone = toneFor(s.oldest);
    const letter = buildReminderLetter({
      company,
      party: {
        name: s.p.ledger.name,
        mailingName: det?.mailing_name ?? null,
        address: det?.address ?? null,
        stateCode: det?.state_code ?? null,
        pincode: det?.pincode ?? null,
        contactPerson: det?.contact_person ?? null,
        gstin: det?.gstin ?? null,
      },
      date: today,
      asOf: input.asOf,
      bills: s.bills,
      totalOverdue: s.totalOverdue,
      unadjustedCredits: s.credits,
      amountDue: s.amountDue,
      tone,
      oldestOverdueDays: s.oldest,
    });
    out.push({
      ledgerId: s.p.ledger.id,
      ledgerName: s.p.ledger.name,
      email: s.p.ledger.email,
      mobile: s.p.ledger.mobile ?? s.p.ledger.phone,
      tone,
      overdueBills: s.bills,
      totalOverdue: s.totalOverdue,
      unadjustedCredits: s.credits,
      amountDue: s.amountDue,
      netOutstanding: s.p.balance,
      oldestOverdueDays: s.oldest,
      letter,
    });
    amountDueTotal += s.amountDue;
  }
  return { asOf: input.asOf, minOverdueDays, parties: out, totals: { partyCount: out.length, amountDue: amountDueTotal } };
}
