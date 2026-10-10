/**
 * Attachments voucher hook (vouchers/hooks.ts extension point; dataplus).
 *
 *   beforeRemove  deleting a voucher that still has attached files is refused: the files are the
 *                 evidence of the entry (a purchase bill for ITC, a signed challan) and deleting the
 *                 voucher would silently take them away — also for a user who may delete vouchers but
 *                 not remove attachments. Remove the files first (each removal is in the edit log),
 *                 then delete the voucher. Cancelling keeps the voucher and its files, so it is allowed.
 */
import type { CompanyCtx } from '../../api/context.ts';
import { rule } from '../../lib/errors.ts';
import type { VoucherHook } from '../vouchers/hooks.ts';
import type { VoucherRow } from '../vouchers/service.ts';

function beforeRemove(ctx: CompanyCtx, row: VoucherRow, action: 'delete' | 'cancel'): void {
  if (action !== 'delete') return;
  const files = ctx.db.value<number>('SELECT COUNT(*) FROM attachments WHERE voucher_id = :id', { id: row.id }) ?? 0;
  if (files === 0) return;
  throw rule(
    `This voucher has ${files === 1 ? '1 attached file' : `${files} attached files`}. Remove the attachments first (Alt+F on the voucher), ` +
      'then delete the voucher — or cancel the voucher instead, which keeps its number and its files.',
    { attachments: files },
  );
}

export const attachmentsVoucherHook: VoucherHook = { name: 'attachments', beforeRemove };
