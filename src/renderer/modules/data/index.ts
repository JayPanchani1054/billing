/**
 * Data module: backup & restore, export centre, Excel/CSV import, XML data import / export and the data check.
 * The Company Select screen's "Restore a backup…" dialog is RestoreBackupDialog (RestoreFlow.tsx).
 */
import { lazyScreen } from '../../app/lazyScreen.tsx';
import type { ModuleDef } from '../../app/registry.ts';
import { RestoreScreen } from './RestoreFlow.tsx';
import './data.css';

// Screens load on first open (app/lazyScreen.tsx, docs/ARCHITECTURE.md §9a); everything else here stays eager.
const BackupScreen = lazyScreen(() => import('./BackupScreen.tsx').then((m) => m.BackupScreen));
const ExportScreen = lazyScreen(() => import('./ExportScreen.tsx').then((m) => m.ExportScreen));
const ImportScreen = lazyScreen(() => import('./ImportScreen.tsx').then((m) => m.ImportScreen));
const XmlExportScreen = lazyScreen(() => import('./XmlExportScreen.tsx').then((m) => m.XmlExportScreen));
const XmlImportScreen = lazyScreen(() => import('./XmlImportScreen.tsx').then((m) => m.XmlImportScreen));
const VerifyScreen = lazyScreen(() => import('./VerifyScreen.tsx').then((m) => m.VerifyScreen));

export { RestoreBackupDialog } from './RestoreFlow.tsx';

export const dataModule: ModuleDef = {
  id: 'data',
  screens: [
    { id: 'data.backup', title: 'Backup', component: BackupScreen, access: 'data.backup', keywords: ['backup', 'copy', 'save data', 'usb', 'safe'] },
    { id: 'data.restore', title: 'Restore Backup', component: RestoreScreen, access: 'data.restore', keywords: ['restore', 'recover', 'pvqbak'] },
    { id: 'data.export', title: 'Export Data', component: ExportScreen, access: 'data.export', keywords: ['excel', 'csv', 'export masters', 'export vouchers', 'ca'] },
    { id: 'data.import', title: 'Import from Excel', component: ImportScreen, access: 'data.import', keywords: ['excel', 'csv', 'import', 'template', 'bulk', 'upload'] },
    { id: 'data.xmlImport', title: 'XML Data Import', component: XmlImportScreen, access: 'data.import', keywords: ['xml', 'import xml', 'migration', 'another accounting program', 'previous software'] },
    { id: 'data.xmlExport', title: 'XML Data Export', component: XmlExportScreen, access: 'data.export', keywords: ['xml', 'export xml', 'another accounting program', 'auditor', 'ca', 'import data'] },
    { id: 'data.verify', title: 'Check Books', component: VerifyScreen, access: 'data.backup', keywords: ['verify', 'integrity', 'repair', 'check data', 'audit'] },
  ],
  menu: [
    { section: 'data', label: 'Backup', screen: 'data.backup', order: 10, description: 'Make a copy of this company and see earlier backups' },
    { section: 'data', label: 'Restore Backup', screen: 'data.restore', order: 20, description: 'Bring back a company from a backup file' },
    { section: 'data', label: 'Import from Excel', screen: 'data.import', order: 30, description: 'Ledgers, items, opening balances and invoices from Excel or CSV' },
    { section: 'data', label: 'XML Data Import', screen: 'data.xmlImport', order: 40, description: 'Masters and vouchers from another accounting program (XML)' },
    { section: 'data', label: 'Export Data', screen: 'data.export', order: 50, description: 'Masters and vouchers to Excel or CSV' },
    { section: 'data', label: 'XML Data Export', screen: 'data.xmlExport', order: 55, description: 'Masters and vouchers for another accounting program (XML)' },
    { section: 'data', label: 'Check Books', screen: 'data.verify', order: 60, description: 'Make sure every voucher balances and the data is intact' },
  ],
};
