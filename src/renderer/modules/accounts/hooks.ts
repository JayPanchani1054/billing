/**
 * Mutation flows shared by the accounts screens (delete with explanation → offer to deactivate).
 */
import { useCallback } from 'react';
import { api } from '../../app/api.ts';
import { useConfirm } from '../../app/confirm.tsx';
import { invalidate } from '../../app/queryClient.ts';
import { userMessage } from '../../app/lib/apiErrors.ts';
import { useToast } from '../../ui/index.ts';
import { deleteRefusal } from './components.tsx';

/** Modules whose screens show ledger data (refresh after a ledger master changes). */
export const LEDGER_DEPENDENTS = ['accounts', 'reports', 'outstanding', 'vouchers', 'banking', 'dashboard', 'gst'] as const;

/**
 * Delete a ledger after confirmation. When the server refuses (used in vouchers, opening balance,
 * bills…) its message says why; an active ledger can then be deactivated instead.
 * Resolves true when the ledger was deleted.
 */
export function useDeleteLedger(): (ledger: { id: number; name: string; isActive: boolean; isPredefined?: boolean }) => Promise<boolean> {
  const confirm = useConfirm();
  const toast = useToast();
  return useCallback(
    async (ledger) => {
      if (ledger.isPredefined) {
        toast.info(`“${ledger.name}” is a built-in ledger`, { message: 'Built-in ledgers cannot be deleted. You may rename them.' });
        return false;
      }
      const ok = await confirm({
        title: `Delete ledger “${ledger.name}”?`,
        message: 'The ledger is removed permanently. A ledger that is used in vouchers or has an opening balance cannot be deleted — you will be told why.',
        confirmLabel: 'Delete',
        tone: 'danger',
      });
      if (!ok) return false;
      try {
        await api('accounts.ledger.delete', { id: ledger.id });
        for (const p of LEDGER_DEPENDENTS) invalidate(p);
        toast.success(`Ledger “${ledger.name}” deleted`);
        return true;
      } catch (err) {
        const refusal = deleteRefusal(err);
        if (refusal && ledger.isActive) {
          const deactivate = await confirm({
            title: `“${ledger.name}” cannot be deleted`,
            message: `${refusal} You can deactivate it instead: it stays in old vouchers and reports but cannot be chosen in new vouchers.`,
            confirmLabel: 'Deactivate',
            cancelLabel: 'Keep as is',
          });
          if (deactivate) {
            try {
              await api('accounts.ledger.save', { id: ledger.id, isActive: false });
              for (const p of LEDGER_DEPENDENTS) invalidate(p);
              toast.success(`Ledger “${ledger.name}” deactivated`);
            } catch (e2) {
              toast.error('Could not deactivate the ledger', { message: userMessage(e2) });
            }
          }
          return false;
        }
        toast.error(refusal ? `“${ledger.name}” cannot be deleted` : 'Could not delete the ledger', { message: userMessage(err), duration: 10_000 });
        return false;
      }
    },
    [confirm, toast],
  );
}
