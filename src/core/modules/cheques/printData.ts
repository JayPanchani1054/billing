/**
 * Cheque print data: one cheque per bank credit with instrument type 'cheque' on a Payment / Contra
 * (bulk: many vouchers at once), and the record of what was printed.
 *
 * Payee: the instrument's "favouring" when typed; a Contra (cash withdrawal / own-account transfer) is
 * a self cheque ('Self', never crossed); a Payment pays its debit party — the payee's "name on cheque",
 * else the beneficiary name, else the ledger's mailing name, else its name.
 */
import { addMonths, formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import type { Paise } from '../../../shared/money.ts';
import type { ChequeLayoutSpec, ChequePrintData, ChequePrintItem, ChequePrintRecordInput } from '../../../shared/types/cheques.ts';
import { amountInWords } from '../../../shared/words.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { validation } from '../../lib/errors.ts';
import { loadGroupTree } from '../accounts/books.ts';
import { CHEQUE_VALIDITY_MONTHS } from '../banking/registers.ts';
import { chequePayeeName, requirePermission, voucherLabel } from './common.ts';
import { getBankSettings, layoutForBank } from './layouts.ts';

export const CHEQUE_PRINT_MAX = 200;

/** 'DDMMYYYY' for the eight date boxes. */
export function dateDigits(iso: string): string {
  return `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}`;
}

/**
 * Amount in words for the cheque, Indian system: 'One Lakh Twenty Thousand and Fifty Paise Only'. The
 * leaf already says "Rupees" before the line, so the word is not repeated.
 */
export function chequeWords(amount: Paise): string {
  return amountInWords(amount).replace(/^Rupees\s+/, '');
}

/** '**1,180.00/-' — the guards stop anyone writing digits before or after the amount. */
export function amountFigures(amount: Paise, paise = true): string {
  const text = formatMoney(amount);
  return `**${!paise && text.endsWith('.00') ? text.slice(0, -3) : text}/-`;
}

interface VoucherHead {
  id: number;
  date: string;
  number: string | null;
  base_type: string;
  is_cancelled: number;
  type_name: string;
}

interface EntryRow {
  line_no: number;
  ledger_id: number;
  amount: number;
  instrument_type: string | null;
  instrument_no: string | null;
  instrument_date: string | null;
  favouring: string | null;
}

interface ResolvedCheque {
  voucher: VoucherHead;
  label: string;
  lineNo: number;
  bankLedgerId: number;
  chequeNo: string | null;
  chequeDate: string;
  payee: string;
  self: boolean;
  amount: Paise;
}

/** Cheques of one voucher, or the reason it has none. */
function chequesOf(db: Db, voucherId: number, isBank: (ledgerId: number) => boolean, isCash: (ledgerId: number) => boolean): ResolvedCheque[] | string {
  const v = db.get<VoucherHead>(
    `SELECT v.id, v.date, v.number, v.base_type, v.is_cancelled, vt.name AS type_name
       FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id WHERE v.id = :id`,
    { id: voucherId },
  );
  if (!v) return 'The voucher no longer exists.';
  if (v.base_type !== 'payment' && v.base_type !== 'contra') return 'Cheques are printed from Payment and Contra vouchers.';
  if (v.is_cancelled === 1) return 'The voucher is cancelled.';
  const entries = db.all<EntryRow>(
    `SELECT line_no, ledger_id, amount, instrument_type, instrument_no, instrument_date, favouring
       FROM ledger_entries WHERE voucher_id = :id ORDER BY line_no`,
    { id: voucherId },
  );
  const label = voucherLabel(v.type_name, v.number, v.date);
  const cheques = entries.filter((e) => e.amount < 0 && e.instrument_type === 'cheque' && isBank(e.ledger_id));
  if (cheques.length === 0) return 'No bank line of this voucher is paid by cheque (instrument type Cheque, Alt+K in the voucher).';
  const debits = entries.filter((e) => e.amount > 0);
  const out: ResolvedCheque[] = [];
  for (const c of cheques) {
    const favouring = (c.favouring ?? '').trim();
    let payee = favouring;
    let self = /^self$/i.test(favouring);
    if (!payee) {
      if (v.base_type === 'contra' || debits.every((d) => isCash(d.ledger_id) || isBank(d.ledger_id))) {
        payee = 'Self';
        self = true;
      } else {
        // The payment's party: the largest debit that is not cash / bank (ties: first line).
        const parties = debits.filter((d) => !isCash(d.ledger_id) && !isBank(d.ledger_id)).sort((a, b) => b.amount - a.amount || a.line_no - b.line_no);
        payee = parties.length > 0 ? chequePayeeName(db, parties[0].ledger_id) : '';
      }
    }
    if (!payee) continue;
    out.push({
      voucher: v,
      label,
      lineNo: c.line_no,
      bankLedgerId: c.ledger_id,
      chequeNo: (c.instrument_no ?? '').trim() || null,
      chequeDate: c.instrument_date ?? v.date,
      payee,
      self,
      amount: -c.amount,
    });
  }
  return out.length > 0 ? out : 'The payee could not be found: type it in "Favouring" in the bank details of the voucher (Alt+K).';
}

function classifier(db: Db): { isBank: (id: number) => boolean; isCash: (id: number) => boolean } {
  const tree = loadGroupTree(db);
  const cache = new Map<number, { bank: boolean; cash: boolean }>();
  const of = (id: number): { bank: boolean; cash: boolean } => {
    let c = cache.get(id);
    if (!c) {
      const g = db.value<number>('SELECT group_id FROM ledgers WHERE id = :id', { id });
      const cls = g !== undefined ? tree.byId.get(g)?.cls : undefined;
      c = { bank: cls?.isBank === true, cash: cls?.isCash === true };
      cache.set(id, c);
    }
    return c;
  };
  return { isBank: (id) => of(id).bank, isCash: (id) => of(id).cash };
}

export function chequePrintData(ctx: CompanyCtx, voucherIds: readonly number[], layoutId?: number | null): ChequePrintData {
  const { db } = ctx;
  if (voucherIds.length > CHEQUE_PRINT_MAX) throw validation([{ path: 'voucherIds', message: `Print at most ${CHEQUE_PRINT_MAX} cheques at a time` }]);
  const today = ctx.clock.today();
  const company = db.value<string>("SELECT COALESCE(NULLIF(TRIM(mailing_name), ''), name) FROM company LIMIT 1") ?? ctx.company.name;
  const { isBank, isCash } = classifier(db);
  const settingsCache = new Map<number, { acPayee: boolean; signatory: string; bankName: string; layout: { id: number | null; name: string; spec: ChequeLayoutSpec } }>();
  const bankSetup = (bankId: number) => {
    let s = settingsCache.get(bankId);
    if (!s) {
      const st = getBankSettings(db, bankId);
      s = { acPayee: st.acPayee, signatory: st.signatory ?? 'Authorised Signatory', bankName: st.bankLedgerName, layout: layoutForBank(db, bankId, layoutId) };
      settingsCache.set(bankId, s);
    }
    return s;
  };
  const cheques: ChequePrintItem[] = [];
  const skipped: ChequePrintData['skipped'] = [];
  const seen = new Set<number>();
  for (const id of voucherIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const res = chequesOf(db, id, isBank, isCash);
    if (typeof res === 'string') {
      const head = db.get<{ number: string | null; date: string; type_name: string }>(
        'SELECT v.number, v.date, vt.name AS type_name FROM vouchers v JOIN voucher_types vt ON vt.id = v.voucher_type_id WHERE v.id = :id',
        { id },
      );
      skipped.push({ voucherId: id, label: head ? voucherLabel(head.type_name, head.number, head.date) : `Voucher #${id}`, reason: res });
      continue;
    }
    for (const c of res) {
      const setup = bankSetup(c.bankLedgerId);
      const printed = db
        .all<{ printed_at: string; cheque_no: string | null }>('SELECT printed_at, cheque_no FROM cheque_prints WHERE voucher_id = :v ORDER BY id', { v: id })
        .map((p) => ({ at: p.printed_at, chequeNo: p.cheque_no }));
      const warnings: string[] = [];
      if (!c.chequeNo) warnings.push('The voucher has no cheque number: enter it in the bank details (Alt+K) or add a cheque book so numbers are filled in.');
      if (c.chequeDate > today) warnings.push(`Post-dated cheque: dated ${formatDate(c.chequeDate)}.`);
      else if (addMonths(c.chequeDate, CHEQUE_VALIDITY_MONTHS) < today) {
        warnings.push(`The cheque is dated ${formatDate(c.chequeDate)}, more than ${CHEQUE_VALIDITY_MONTHS} months ago: banks do not pay stale cheques. Change the cheque date in the voucher.`);
      }
      if (printed.length > 0) warnings.push(`Already printed ${printed.length === 1 ? 'once' : `${printed.length} times`} (last on ${formatDate(printed[printed.length - 1].at.slice(0, 10))}). Cancel the spoilt leaf if you print it again on a new one.`);
      cheques.push({
        key: `${id}:${c.lineNo}`,
        voucherId: id,
        lineNo: c.lineNo,
        voucherLabel: c.label,
        voucherDate: c.voucher.date,
        bankLedgerId: c.bankLedgerId,
        bankLedgerName: setup.bankName,
        chequeNo: c.chequeNo,
        chequeDate: c.chequeDate,
        dateDigits: dateDigits(c.chequeDate),
        payee: c.payee,
        self: c.self,
        amount: c.amount,
        amountWords: chequeWords(c.amount),
        amountFigures: amountFigures(c.amount, setup.layout.spec.figuresPaise),
        acPayee: setup.acPayee && !c.self,
        signatory: setup.signatory,
        companyName: company,
        layoutId: setup.layout.id,
        layoutName: setup.layout.name,
        spec: setup.layout.spec,
        printed,
        warnings,
      });
    }
  }
  return { cheques, skipped };
}

/** Record printed cheques (edit log 'export' + cheque_prints): called right before the print job. */
export function recordChequePrints(ctx: CompanyCtx, input: ChequePrintRecordInput): { recorded: number } {
  const { db } = ctx;
  requirePermission(ctx, 'vouchers.view', 'view vouchers');
  const ids = [...new Set(input.items.map((i) => i.voucherId))];
  const data = chequePrintData(ctx, ids, input.layoutId);
  const wanted = new Set(input.items.map((i) => `${i.voucherId}:${i.lineNo}`));
  const now = ctx.clock.now().toISOString();
  let recorded = 0;
  for (const c of data.cheques) {
    if (!wanted.has(c.key)) continue;
    db.run(
      `INSERT INTO cheque_prints (voucher_id, voucher_label, bank_ledger_id, cheque_no, cheque_date, payee, amount, layout_id, printed_by, printed_at)
       VALUES (:v, :label, :bank, :no, :date, :payee, :amount, :layout, :by, :now)`,
      { v: c.voucherId, label: c.voucherLabel, bank: c.bankLedgerId, no: c.chequeNo, date: c.chequeDate, payee: c.payee, amount: c.amount, layout: c.layoutId, by: ctx.session.userId, now },
    );
    ctx.audit({
      action: 'export',
      entityType: 'voucher',
      entityId: c.voucherId,
      entityLabel: `Cheque ${c.chequeNo ?? '(no number)'} printed — ${c.voucherLabel}`,
      after: { format: 'cheque', bank: c.bankLedgerName, chequeNo: c.chequeNo, payee: c.payee, amount: c.amount, chequeDate: c.chequeDate },
    });
    recorded++;
  }
  if (recorded === 0) throw validation([{ path: 'items', message: 'None of these vouchers has a cheque to print' }]);
  return { recorded };
}
