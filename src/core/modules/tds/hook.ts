/**
 * TDS/TCS voucher hook (vouchers/hooks.ts): computes the deduction/collection of a voucher, posts the
 * auto-lines and rebuilds tds_lines / tds_challans with the voucher. Filled in by the tds module.
 */
import type { VoucherHook } from '../vouchers/hooks.ts';

export const tdsVoucherHook: VoucherHook = {
  name: 'tds',
};
