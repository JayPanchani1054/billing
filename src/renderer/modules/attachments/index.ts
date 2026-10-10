/**
 * Attachments module UI (dataplus; core: src/core/modules/attachments). Screens and params:
 *
 *   'attachments.manage'    { entityType: 'voucher' | 'ledger' | 'stock_item', entityId, label? }
 *   'attachments.register'  every attachment of the company (Gateway › Display › Attachment Register, Go To)
 *
 * Extension points used: voucherPanels (the voucher's files on 'vouchers.view' + Alt+F). The ledger
 * and stock item forms add Alt+F through AttachmentsRailAction.
 */
import type { ModuleDef } from '../../app/registry.ts';
import { AttachmentRegisterScreen, AttachmentsScreen, VoucherAttachmentsPanel } from './AttachmentsScreens.tsx';

export const attachmentsModule: ModuleDef = {
  id: 'attachments',
  screens: [
    { id: 'attachments.manage', title: 'Attachments', component: AttachmentsScreen },
    {
      id: 'attachments.register',
      title: 'Attachment Register',
      component: AttachmentRegisterScreen,
      goto: true,
      keywords: ['attachments', 'attached files', 'documents', 'scanned bills', 'evidence', 'proof', 'files'],
    },
  ],
  menu: [
    {
      section: 'reports',
      label: 'Attachment Register',
      screen: 'attachments.register',
      order: 95,
      keywords: ['attachments', 'files', 'scans'],
      description: 'Files attached to vouchers, ledgers and stock items',
    },
  ],
  voucherPanels: [VoucherAttachmentsPanel],
};
