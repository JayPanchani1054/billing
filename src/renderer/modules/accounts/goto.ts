/**
 * Go To provider 'ledgers' (replaces the shell's built-in): searches ledgers by name, alias or
 * GSTIN through accounts.ledger.list and opens the Ledger report ('reports.ledger') when the
 * reports module registers it, otherwise the ledger form.
 */
import { api } from '../../app/api.ts';
import { registerGotoProvider } from '../../app/lib/goto.ts';
import { ledgerGotoItems } from './lib/gotoItems.ts';

let installed = false;

/** Is a screen registered by any module? Resolved lazily (the module list imports this module). */
async function screenRegistered(id: string): Promise<boolean> {
  try {
    const { modules } = await import('../index.ts');
    return modules.some((m) => m.screens.some((s) => s.id === id));
  } catch {
    return false;
  }
}

export function installLedgerGoto(): void {
  if (installed) return;
  installed = true;
  registerGotoProvider({
    id: 'ledgers',
    label: 'Ledgers',
    minQuery: 2,
    search: async (query, signal) => {
      const out = await api('accounts.ledger.list', { search: query, limit: 8, withBalance: true });
      if (signal.aborted) return [];
      return ledgerGotoItems(out.rows, await screenRegistered('reports.ledger'));
    },
  });
}
