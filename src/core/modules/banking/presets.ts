/**
 * Bank statement layouts: header normalisation, fuzzy column classification, the bank presets (SBI, HDFC,
 * ICICI, Axis, Kotak, Yes Bank, PNB, Bank of Baroda, Canara + generic) and header-row location.
 * Pure functions (no DB). See README.md › "Statement import".
 */
import type { BankPresetId, BankPresetInfo, StatementColumnMap, StatementColumnRole } from '../../../shared/types/banking.ts';
import { cellText, type Cell } from './values.ts';

/**
 * Header caption → comparable key: lower case, punctuation → spaces, currency words dropped.
 *   'Chq./Ref.No.' → 'chq ref no'   'Withdrawal Amount (INR )' → 'withdrawal amount'   'Dr / Cr' → 'dr cr'
 */
export function headerKey(cell: Cell | undefined): string {
  const t = cellText(cell ?? null).toLowerCase();
  if (t === '') return '';
  return t
    .replace(/₹/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w !== '' && w !== 'inr' && w !== 'rs' && w !== 'rupees' && w !== 'in')
    .join(' ');
}

const has = (words: readonly string[], ...any: string[]): boolean => any.some((a) => words.includes(a));

/** Priority of a date caption: 1 = transaction date, 2 = posting date (used only when no better one). */
export interface HeaderClass {
  role: StatementColumnRole;
  priority: number;
}

/**
 * Classify one header caption by meaning (ordered rules, first match wins). Returns null for captions that
 * are not statement columns (serial no., branch, transaction id …) or that look like data, not a caption.
 */
export function classifyHeader(cell: Cell | undefined): HeaderClass | null {
  if (typeof cell !== 'string') return null;
  const raw = cell.trim();
  if (raw === '' || raw.length > 40 || /\d{2}[-/.]\d{2}/.test(raw)) return null;
  const key = headerKey(raw);
  if (key === '') return null;
  const w = key.split(' ');
  const joined = w.join('');

  // Dr/Cr indicator columns.
  if (['drcr', 'crdr', 'debitcredit', 'creditdebit', 'dc', 'cd', 'drorcr', 'crordr', 'type', 'txntype', 'transactiontype', 'trantype'].includes(joined)) {
    return { role: 'drCr', priority: 1 };
  }
  if (has(w, 'value') && has(w, 'date', 'dt', 'dat')) return { role: 'valueDate', priority: 1 };
  if (has(w, 'date', 'dt', 'dated')) {
    if (has(w, 'cheque', 'chq', 'instrument')) return null; // cheque date
    if (has(w, 'posted', 'posting', 'post')) return { role: 'date', priority: 2 };
    return { role: 'date', priority: 1 };
  }
  if (has(w, 'balance', 'bal', 'balances')) return { role: 'balance', priority: has(w, 'available') ? 2 : 1 };
  if (has(w, 'chq', 'cheque', 'check', 'ref', 'reference', 'utr', 'instrument', 'chqno', 'refno', 'chequeno') || joined.startsWith('chq')) {
    return { role: 'reference', priority: 1 };
  }
  if (has(w, 'narration', 'description', 'particulars', 'remarks', 'details', 'desc', 'narrative', 'memo')) {
    return { role: 'description', priority: 1 };
  }
  if (has(w, 'withdrawal', 'withdrawals', 'debit', 'debits', 'dr', 'wdl', 'withdrawn', 'payments', 'paid')) return { role: 'debit', priority: 1 };
  if (has(w, 'deposit', 'deposits', 'credit', 'credits', 'cr', 'receipts', 'lodgement', 'lodgements')) return { role: 'credit', priority: 1 };
  if (has(w, 'amount', 'amt', 'amounts')) return { role: 'amount', priority: 1 };
  return null;
}

// ───────────────────────────── Presets ─────────────────────────────

export interface BankPreset extends BankPresetInfo {
  /** Normalised captions (headerKey) per role, in preference order. */
  columns: Partial<Record<StatementColumnRole, readonly string[]>>;
  /** Captions that identify the layout (headerKey); the share present decides detection. */
  signature: readonly string[];
  /** Ledger/bank name pattern used as a tie-breaker. */
  hint: RegExp;
}

export const BANK_PRESETS: readonly BankPreset[] = [
  {
    id: 'sbi',
    name: 'State Bank of India',
    headers: ['Txn Date', 'Value Date', 'Description', 'Ref No./Cheque No.', 'Debit', 'Credit', 'Balance'],
    note: 'YONO / OnlineSBI › Account Statement › Excel. The ".xls" file is tab-separated text with account details above the table; dates like "1 Apr 2026".',
    columns: {
      date: ['txn date'],
      valueDate: ['value date'],
      description: ['description'],
      reference: ['ref no cheque no'],
      debit: ['debit'],
      credit: ['credit'],
      balance: ['balance'],
    },
    signature: ['txn date', 'value date', 'description', 'ref no cheque no', 'debit', 'credit', 'balance'],
    hint: /\b(sbi|state bank)\b/i,
  },
  {
    id: 'hdfc',
    name: 'HDFC Bank',
    headers: ['Date', 'Narration', 'Chq./Ref.No.', 'Value Dt', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'],
    note: 'NetBanking › Download › Excel or Delimited. Dates dd/mm/yy; asterisk separator rows and a "STATEMENT SUMMARY" block are skipped.',
    columns: {
      date: ['date'],
      description: ['narration'],
      reference: ['chq ref no', 'chq ref number'],
      valueDate: ['value dt', 'value dat', 'value date'],
      debit: ['withdrawal amt', 'debit amount'],
      credit: ['deposit amt', 'credit amount'],
      balance: ['closing balance'],
    },
    signature: ['date', 'narration', 'chq ref no', 'value dt', 'withdrawal amt', 'deposit amt', 'closing balance'],
    hint: /\bhdfc\b/i,
  },
  {
    id: 'icici',
    name: 'ICICI Bank',
    headers: ['S No.', 'Value Date', 'Transaction Date', 'Cheque Number', 'Transaction Remarks', 'Withdrawal Amount (INR )', 'Deposit Amount (INR )', 'Balance (INR )'],
    note: 'Internet Banking › Detailed Statement › XLS. Title rows above the table; both value and transaction dates are given.',
    columns: {
      date: ['transaction date'],
      valueDate: ['value date'],
      reference: ['cheque number', 'cheque no ref no', 'chq no ref no'],
      description: ['transaction remarks'],
      debit: ['withdrawal amount', 'withdrawal dr'],
      credit: ['deposit amount', 'deposit cr'],
      balance: ['balance'],
    },
    signature: ['value date', 'transaction date', 'cheque number', 'transaction remarks', 'withdrawal amount', 'deposit amount', 'balance'],
    hint: /\bicici\b/i,
  },
  {
    id: 'axis',
    name: 'Axis Bank',
    headers: ['Tran Date', 'CHQNO', 'PARTICULARS', 'DR', 'CR', 'BAL', 'SOL'],
    note: 'Internet Banking › Statement › Excel/CSV. An OPENING BALANCE row starts the table; TRANSACTION TOTAL / CLOSING BALANCE rows end it.',
    columns: {
      date: ['tran date'],
      reference: ['chqno', 'chq no'],
      description: ['particulars'],
      debit: ['dr'],
      credit: ['cr'],
      balance: ['bal'],
    },
    signature: ['tran date', 'chqno', 'particulars', 'dr', 'cr', 'bal', 'sol'],
    hint: /\baxis\b/i,
  },
  {
    id: 'kotak',
    name: 'Kotak Mahindra Bank',
    headers: ['Sl. No.', 'Transaction Date', 'Value Date', 'Description', 'Chq / Ref No.', 'Amount', 'Dr / Cr', 'Balance', 'Dr / Cr'],
    note: 'Net Banking › Statement › Excel/CSV. One amount column with a Dr/Cr column, and a second Dr/Cr column for the balance.',
    columns: {
      date: ['transaction date', 'date'],
      valueDate: ['value date'],
      description: ['description'],
      reference: ['chq ref no', 'chq ref number'],
      amount: ['amount'],
      balance: ['balance'],
    },
    signature: ['transaction date', 'value date', 'description', 'chq ref no', 'amount', 'dr cr', 'balance'],
    hint: /\bkotak\b/i,
  },
  {
    id: 'yes',
    name: 'Yes Bank',
    headers: ['Transaction Date', 'Value Date', 'Cheque No/Reference No', 'Description', 'Withdrawals', 'Deposits', 'Running Balance'],
    note: 'YES Online › Statement › Excel. Dates dd-MMM-yyyy.',
    columns: {
      date: ['transaction date'],
      valueDate: ['value date'],
      reference: ['cheque no reference no'],
      description: ['description'],
      debit: ['withdrawals'],
      credit: ['deposits'],
      balance: ['running balance'],
    },
    signature: ['transaction date', 'value date', 'cheque no reference no', 'description', 'withdrawals', 'deposits', 'running balance'],
    hint: /\byes\s*bank\b/i,
  },
  {
    id: 'pnb',
    name: 'Punjab National Bank',
    headers: ['Txn No.', 'Txn Date', 'Description', 'Branch Name', 'Cheque No.', 'Dr Amount', 'Cr Amount', 'Balance', 'Value Date'],
    note: 'PNB ONE / Internet Banking › Account Statement › Excel. Balances carry a Cr/Dr suffix.',
    columns: {
      date: ['txn date'],
      description: ['description'],
      reference: ['cheque no'],
      debit: ['dr amount'],
      credit: ['cr amount'],
      balance: ['balance'],
      valueDate: ['value date'],
    },
    signature: ['txn no', 'txn date', 'description', 'branch name', 'cheque no', 'dr amount', 'cr amount', 'balance', 'value date'],
    hint: /\b(pnb|punjab national)\b/i,
  },
  {
    id: 'bob',
    name: 'Bank of Baroda',
    headers: ['TRAN DATE', 'VALUE DATE', 'NARRATION', 'CHQ.NO.', 'WITHDRAWAL(DR)', 'DEPOSIT(CR)', 'BALANCE(INR)'],
    note: 'bob World / Internet Banking › Statement › Excel. Balances like "1,00,000.00Cr".',
    columns: {
      date: ['tran date'],
      valueDate: ['value date'],
      description: ['narration'],
      reference: ['chq no'],
      debit: ['withdrawal dr'],
      credit: ['deposit cr'],
      balance: ['balance'],
    },
    signature: ['tran date', 'value date', 'narration', 'chq no', 'withdrawal dr', 'deposit cr', 'balance'],
    hint: /\b(baroda|bob)\b/i,
  },
  {
    id: 'canara',
    name: 'Canara Bank',
    headers: ['Txn Date', 'Value Date', 'Cheque No.', 'Description', 'Branch Code', 'Debit', 'Credit', 'Balance'],
    note: 'Canara ai1 / Net Banking › Statement › Excel. Transaction dates may include the time.',
    columns: {
      date: ['txn date'],
      valueDate: ['value date'],
      reference: ['cheque no'],
      description: ['description'],
      debit: ['debit'],
      credit: ['credit'],
      balance: ['balance'],
    },
    signature: ['txn date', 'value date', 'cheque no', 'description', 'branch code', 'debit', 'credit', 'balance'],
    hint: /\bcanara\b/i,
  },
  {
    id: 'generic',
    name: 'Other bank (columns matched by name)',
    headers: ['Date', 'Description / Narration / Particulars', 'Cheque / Reference No.', 'Debit / Withdrawal', 'Credit / Deposit', 'Amount + Dr/Cr', 'Balance'],
    note: 'Any CSV/Excel statement with a header row: columns are recognised by their captions and can be changed before importing.',
    columns: {},
    signature: [],
    hint: /$^/,
  },
];

export function presetById(id: BankPresetId): BankPreset {
  return BANK_PRESETS.find((p) => p.id === id) ?? (BANK_PRESETS[BANK_PRESETS.length - 1] as BankPreset);
}

export function presetInfo(p: BankPreset): BankPresetInfo {
  return { id: p.id, name: p.name, headers: [...p.headers], note: p.note };
}

// ───────────────────────────── Column resolution ─────────────────────────────

const MONEY_ROLES: readonly StatementColumnRole[] = ['debit', 'credit', 'amount', 'balance'];

/**
 * Columns by meaning (fuzzy captions). Several candidates for one role: best priority, then leftmost.
 * Dr/Cr indicators are assigned by position: one right after the balance column belongs to the balance.
 */
export function fuzzyColumns(header: readonly Cell[]): Partial<StatementColumnMap> {
  const best = new Map<StatementColumnRole, { idx: number; priority: number }>();
  const drCrCols: number[] = [];
  header.forEach((cell, idx) => {
    const c = classifyHeader(cell);
    if (!c) return;
    if (c.role === 'drCr') {
      drCrCols.push(idx);
      return;
    }
    const cur = best.get(c.role);
    if (!cur || c.priority < cur.priority) best.set(c.role, { idx, priority: c.priority });
  });
  const out: Partial<StatementColumnMap> = {};
  for (const [role, v] of best) (out as Record<string, number>)[role] = v.idx;
  assignDrCr(out, drCrCols);
  if (out.date === undefined && out.valueDate !== undefined) {
    out.date = out.valueDate;
    delete out.valueDate;
  }
  return out;
}

function assignDrCr(out: Partial<StatementColumnMap>, drCrCols: readonly number[]): void {
  for (const idx of drCrCols) {
    // The nearest money column to the left decides what the indicator qualifies.
    let owner: StatementColumnRole | null = null;
    for (let j = idx - 1; j >= 0 && owner === null; j--) {
      for (const role of MONEY_ROLES) if ((out as Record<string, number | undefined>)[role] === j) owner = role;
    }
    if (owner === 'balance' && out.balanceDrCr === undefined) out.balanceDrCr = idx;
    else if (out.drCr === undefined) out.drCr = idx;
  }
}

/** Columns from a preset's captions (exact headerKey match), with fuzzy matching for anything it does not name. */
export function presetColumns(header: readonly Cell[], preset: BankPreset): Partial<StatementColumnMap> {
  const keys = header.map((c) => headerKey(c));
  const out: Partial<StatementColumnMap> = {};
  const used = new Set<number>();
  for (const [role, names] of Object.entries(preset.columns) as Array<[StatementColumnRole, readonly string[]]>) {
    for (const name of names) {
      const idx = keys.findIndex((k, i) => k === name && !used.has(i));
      if (idx >= 0) {
        (out as Record<string, number>)[role] = idx;
        used.add(idx);
        break;
      }
    }
  }
  const fuzzy = fuzzyColumns(header);
  for (const role of Object.keys(fuzzy) as StatementColumnRole[]) {
    const idx = (fuzzy as Record<string, number>)[role];
    if ((out as Record<string, number | undefined>)[role] === undefined && !used.has(idx)) {
      (out as Record<string, number>)[role] = idx;
      used.add(idx);
    }
  }
  return out;
}

/** Share of a preset's signature captions present in the header row (0 for the generic preset). */
export function presetFit(header: readonly Cell[], preset: BankPreset): number {
  if (preset.signature.length === 0) return 0;
  const keys = new Set(header.map((c) => headerKey(c)).filter(Boolean));
  let hit = 0;
  for (const s of preset.signature) if (keys.has(s)) hit++;
  return hit / preset.signature.length;
}

/** Minimum signature share for a header row to be recognised as a bank's layout. */
export const PRESET_MIN_FIT = 0.7;

/** The bank layout of a header row (best signature share; the ledger's bank name breaks ties), or generic. */
export function detectPreset(header: readonly Cell[], bankHint: string | null): BankPreset {
  let best: BankPreset | null = null;
  let bestFit = 0;
  for (const p of BANK_PRESETS) {
    const fit = presetFit(header, p);
    if (fit < PRESET_MIN_FIT) continue;
    const hinted = bankHint !== null && p.hint.test(bankHint);
    const bestHinted = best !== null && bankHint !== null && best.hint.test(bankHint);
    if (fit > bestFit + 1e-9 || (Math.abs(fit - bestFit) <= 1e-9 && hinted && !bestHinted)) {
      best = p;
      bestFit = fit;
    }
  }
  return best ?? presetById('generic');
}

/** A header row is usable when it has a date and money columns (debit/credit or amount). */
export function isUsableColumns(c: Partial<StatementColumnMap>): c is StatementColumnMap {
  return c.date !== undefined && (c.debit !== undefined || c.credit !== undefined || c.amount !== undefined);
}

/** Roles found in a row (header candidate score). */
export function headerScore(row: readonly Cell[]): number {
  const roles = new Set<StatementColumnRole>();
  for (const cell of row) {
    const c = classifyHeader(cell);
    if (c) roles.add(c.role);
  }
  return roles.size;
}

/** Rows scanned for the header. Banks put at most ~25 lines of account details above the table. */
export const HEADER_SCAN_ROWS = 80;

/** The most header-like usable row among the first HEADER_SCAN_ROWS rows (−1 when none). */
export function locateHeaderRow(rows: readonly (readonly Cell[])[]): number {
  let bestRow = -1;
  let bestScore = 0;
  const n = Math.min(rows.length, HEADER_SCAN_ROWS);
  for (let r = 0; r < n; r++) {
    const row = rows[r];
    if (!row || row.length < 2) continue;
    const score = headerScore(row);
    if (score < 3 || score <= bestScore) continue;
    if (!isUsableColumns(fuzzyColumns(row))) continue;
    bestRow = r;
    bestScore = score;
  }
  return bestRow;
}
