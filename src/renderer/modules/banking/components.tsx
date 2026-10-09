/**
 * Shared pieces of the banking screens: the bank-account selector (from banking.summary, so it also shows
 * balances), the ledger options for vouchers created from statement lines, status badges and the
 * "no bank accounts yet" empty state.
 */
import { useEffect, useMemo } from 'react';
import type { BankSummaryRow, StatementLineStatus } from '../../../shared/types/banking.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { useNav } from '../../app/nav.tsx';
import { formatDrCr } from '../../../shared/format.ts';
import { Badge, Button, EmptyState, Select } from '../../ui/index.ts';
import type { SelectOption } from '../../ui/index.ts';
import { STATUS_LABEL, STATUS_TONE, type LedgerOption } from './lib/matchReview.ts';

/** Bank Accounts / Bank OD ledgers with balances as of `asOf`. */
export function useBanks(asOf: string) {
  const q = useApiQuery('banking.summary', { asOf }, { keepPrevious: true });
  return { banks: q.data ?? EMPTY_BANKS, loading: q.loading, error: q.error, refetch: q.refetch, refreshing: q.refreshing };
}

const EMPTY_BANKS: readonly BankSummaryRow[] = [];

/** Keep `ledgerId` pointing at an existing bank: the given one, else the first bank. */
export function useDefaultBank(banks: readonly BankSummaryRow[], ledgerId: number | null, setLedgerId: (id: number) => void): void {
  useEffect(() => {
    if (banks.length === 0) return;
    if (ledgerId === null || !banks.some((b) => b.id === ledgerId)) setLedgerId(banks[0].id);
  }, [banks, ledgerId, setLedgerId]);
}

export function bankLabel(b: Pick<BankSummaryRow, 'name' | 'accountNo' | 'isOd'>): string {
  const tail = b.accountNo ? ` · …${b.accountNo.slice(-4)}` : '';
  return `${b.name}${b.isOd ? ' (OD/CC)' : ''}${tail}`;
}

export function BankSelect({
  banks,
  value,
  onChange,
  allowAll = false,
  id,
  'aria-label': ariaLabel = 'Bank account',
  autoFocus,
}: {
  banks: readonly BankSummaryRow[];
  value: number | null;
  onChange: (id: number | null) => void;
  allowAll?: boolean;
  id?: string;
  'aria-label'?: string;
  autoFocus?: boolean;
}) {
  const options = useMemo<SelectOption[]>(
    () => [
      ...(allowAll ? [{ value: 'all', label: 'All bank accounts' }] : []),
      ...banks.map((b) => ({ value: String(b.id), label: `${bankLabel(b)} — ${formatDrCr(b.balanceAsPerBooks, { keepZero: true })}` })),
    ],
    [banks, allowAll],
  );
  return (
    <Select
      id={id}
      aria-label={ariaLabel}
      size="sm"
      autoFocus={autoFocus}
      options={options}
      value={value === null ? (allowAll ? 'all' : '') : String(value)}
      placeholder={allowAll ? undefined : 'Choose a bank account'}
      onChange={(v) => onChange(v === 'all' ? null : Number(v))}
    />
  );
}

export function NoBanks() {
  const nav = useNav();
  return (
    <EmptyState
      icon="bank"
      title="No bank accounts yet"
      body="Create a ledger under Bank Accounts (or Bank OD A/c for an overdraft / cash credit) to reconcile it with the bank."
      action={
        <Button variant="primary" icon="plus" onClick={() => nav.push('accounts.ledger.form', { groupCode: 'BANK_ACCOUNTS' })}>
          Create bank ledger
        </Button>
      }
    />
  );
}

export function LineStatusBadge({ status }: { status: StatementLineStatus }) {
  return (
    <Badge size="sm" tone={STATUS_TONE[status]} dot>
      {STATUS_LABEL[status]}
    </Badge>
  );
}

/** Every active ledger with its classes (for the contra ledger picker). */
export function useLedgerOptions(enabled = true): { ledgers: readonly LedgerOption[]; loading: boolean } {
  const q = useApiQuery('accounts.ledger.picker', {}, { enabled, staleTime: 60_000 });
  const ledgers = useMemo<readonly LedgerOption[]>(
    () => (q.data ?? []).map((l) => ({ id: l.id, name: l.name, alias: l.alias, groupName: l.groupName, classes: l.classes })),
    [q.data],
  );
  return { ledgers, loading: q.loading };
}

/** "₹ 1,250.00 deposit" / "₹ 590.00 withdrawal" — direction in words (never colour alone). */
export function directionText(amount: number): string {
  return amount >= 0 ? 'Deposit' : 'Withdrawal';
}
