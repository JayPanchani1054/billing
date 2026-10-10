/**
 * Go To results for ledgers (replaces the shell's built-in 'ledgers' provider): a ledger opens its
 * Ledger report when the reports module registers 'reports.ledger' — falling back to the ledger
 * form for a user who may not open reports (the palette checks nav.canOpen) — else the ledger form.
 * Pure — tested in gotoItems.test.ts.
 */
import { formatDrCr } from '../../../../shared/format.ts';
import type { LedgerListRow } from '../../../../shared/types/accounts.ts';
import type { GotoItem } from '../../../app/lib/goto.ts';

export function ledgerGotoItems(rows: readonly LedgerListRow[], hasLedgerReport: boolean): GotoItem[] {
  return rows.map((l) => {
    const balance = l.closingBalance ? formatDrCr(l.closingBalance) : '';
    return {
      id: `ledger:${l.id}`,
      label: l.name,
      group: 'Ledgers',
      description: [l.groupName, balance, l.isActive ? '' : 'inactive'].filter(Boolean).join(' · '),
      keywords: [l.alias ?? '', l.gstin ?? '', ...(l.otherAliases ?? [])].filter(Boolean),
      screen: hasLedgerReport ? 'reports.ledger' : 'accounts.ledger.form',
      params: hasLedgerReport ? { ledgerId: l.id } : { id: l.id },
      ...(hasLedgerReport ? { fallback: { screen: 'accounts.ledger.form', params: { id: l.id } } } : {}),
    };
  });
}
