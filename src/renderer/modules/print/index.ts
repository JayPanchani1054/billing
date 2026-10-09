/**
 * Print module: invoice / voucher documents (preview, print, PDF), combined printing of many
 * vouchers, and invoice print settings. Templates are React components over the print DTO
 * (shared/types/print.ts); the printed HTML is the serialised preview.
 *
 * Screens:
 *   'print.voucher'  {id, copies?, template?, pageSize?, autoPrint?}  preview + print one voucher
 *   'print.batch'    {ids?, template?}                                 pick / print many vouchers
 *   'print.settings' —                                                 Invoice Printing (the only editor of config.invoice;
 *                                                                      F12 › Invoices links here), live preview
 */
import type { ModuleDef } from '../../app/registry.ts';
import { PrintBatchScreen } from './PrintBatchScreen.tsx';
import { PrintSettingsScreen } from './PrintSettingsScreen.tsx';
import { PrintVoucherScreen } from './PrintVoucherScreen.tsx';

export const printModule: ModuleDef = {
  id: 'print',
  screens: [
    { id: 'print.voucher', title: 'Print Preview', component: PrintVoucherScreen, access: 'vouchers.view', keywords: ['print', 'invoice', 'pdf'] },
    { id: 'print.batch', title: 'Print Vouchers', component: PrintBatchScreen, access: 'vouchers.view', keywords: ['print', 'batch', 'bulk', 'multiple invoices', 'pdf'] },
    { id: 'print.settings', title: 'Invoice Printing', component: PrintSettingsScreen, access: 'company.view', keywords: ['invoice template', 'print settings', 'bank details', 'upi qr', 'declaration', 'copies'] },
  ],
  menu: [
    {
      section: 'utilities',
      label: 'Print Vouchers',
      screen: 'print.batch',
      order: 40,
      keywords: ['bulk print', 'print invoices', 'pdf'],
      description: 'Print or save many invoices and vouchers at once',
    },
    {
      section: 'company',
      label: 'Invoice Printing',
      screen: 'print.settings',
      order: 35,
      keywords: ['invoice template', 'print settings', 'upi qr', 'bank details'],
      description: 'Template, copies, bank details, UPI QR and declaration',
    },
  ],
};
