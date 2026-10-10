/**
 * Data module: backup & restore, export centre, Excel/CSV import, Tally migration and the data check.
 * The Company Select screen's "Restore a backup…" dialog is RestoreBackupDialog (RestoreFlow.tsx).
 */
import type { ModuleDef } from '../../app/registry.ts';
import { BackupScreen } from './BackupScreen.tsx';
import { ExportScreen } from './ExportScreen.tsx';
import { ImportScreen } from './ImportScreen.tsx';
import { RestoreScreen } from './RestoreFlow.tsx';
import { TallyExportScreen } from './TallyExportScreen.tsx';
import { TallyScreen } from './TallyScreen.tsx';
import { VerifyScreen } from './VerifyScreen.tsx';
import './data.css';

export { RestoreBackupDialog } from './RestoreFlow.tsx';

export const dataModule: ModuleDef = {
  id: 'data',
  screens: [
    { id: 'data.backup', title: 'Backup', component: BackupScreen, access: 'data.backup', keywords: ['backup', 'copy', 'save data', 'usb', 'safe'] },
    { id: 'data.restore', title: 'Restore Backup', component: RestoreScreen, access: 'data.restore', keywords: ['restore', 'recover', 'bahibak'] },
    { id: 'data.export', title: 'Export Data', component: ExportScreen, access: 'data.export', keywords: ['excel', 'csv', 'export masters', 'export vouchers', 'ca'] },
    { id: 'data.import', title: 'Import from Excel', component: ImportScreen, access: 'data.import', keywords: ['excel', 'csv', 'import', 'template', 'bulk', 'upload'] },
    { id: 'data.tally', title: 'Migrate from Tally', component: TallyScreen, access: 'data.import', keywords: ['tally', 'tallyprime', 'tally erp 9', 'xml', 'migration'] },
    { id: 'data.tallyExport', title: 'Export to Tally', component: TallyExportScreen, access: 'data.export', keywords: ['tally', 'tallyprime', 'tally xml', 'export to tally', 'auditor', 'ca', 'import data'] },
    { id: 'data.verify', title: 'Check Books', component: VerifyScreen, access: 'data.backup', keywords: ['verify', 'integrity', 'repair', 'check data', 'audit'] },
  ],
  menu: [
    { section: 'data', label: 'Backup', screen: 'data.backup', order: 10, description: 'Make a copy of this company and see earlier backups' },
    { section: 'data', label: 'Restore Backup', screen: 'data.restore', order: 20, description: 'Bring back a company from a backup file' },
    { section: 'data', label: 'Import from Excel', screen: 'data.import', order: 30, description: 'Ledgers, items, opening balances and invoices from Excel or CSV' },
    { section: 'data', label: 'Migrate from Tally', screen: 'data.tally', order: 40, description: 'Masters and vouchers from a Tally XML export' },
    { section: 'data', label: 'Export Data', screen: 'data.export', order: 50, description: 'Masters and vouchers to Excel or CSV' },
    { section: 'data', label: 'Export to Tally', screen: 'data.tallyExport', order: 55, description: 'Masters and vouchers as a TallyPrime import (XML) file' },
    { section: 'data', label: 'Check Books', screen: 'data.verify', order: 60, description: 'Make sure every voucher balances and the data is intact' },
  ],
};
