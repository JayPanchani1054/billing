/**
 * Company module: company details, features (F11), configuration (F12), period lock, password,
 * about and shortcuts screens. The pre-workspace screens (data folder, company list, create
 * wizard, login, forced password change) are exported from ./gate.ts and rendered by the shell.
 *
 * Screen params:
 *   'company.config' (F12)  { tab?: 'invoice' | 'gst' | 'guards' | 'display' | 'backup' }  opens that tab
 *                            (e.g. nav.push('company.config', { tab: 'backup' }) from Backup › Backup settings).
 *                            Invoice printing itself is edited on 'print.settings'; F12 › Invoices summarises it.
 */
import type { ModuleDef } from '../../app/registry.ts';
import { AboutScreen, ShortcutsScreen } from './AboutScreen.tsx';
import { ChangePasswordScreen } from './ChangePassword.tsx';
import { CompanyProfileScreen } from './CompanyProfileScreen.tsx';
import { ConfigScreen } from './ConfigScreen.tsx';
import { FeaturesScreen } from './FeaturesScreen.tsx';
import { PeriodLockScreen } from './PeriodLockScreen.tsx';

export const companyModule: ModuleDef = {
  id: 'company',
  screens: [
    { id: 'company.profile', title: 'Company Details', component: CompanyProfileScreen, access: 'company.view', keywords: ['alter company', 'profile', 'address', 'gstin', 'pan', 'logo'] },
    { id: 'company.features', title: 'Features', component: FeaturesScreen, keywords: ['f11', 'enable', 'inventory', 'gst', 'batches', 'godowns'] },
    { id: 'company.config', title: 'Configuration', component: ConfigScreen, keywords: ['f12', 'settings', 'invoice', 'printing', 'backup', 'round off'] },
    { id: 'company.periodLock', title: 'Lock Books', component: PeriodLockScreen, access: 'period.lock', presentation: 'dialog', keywords: ['period lock', 'freeze', 'close books'] },
    { id: 'company.changePassword', title: 'Change Password', component: ChangePasswordScreen, presentation: 'dialog' },
    { id: 'company.about', title: 'About Pevqori', component: AboutScreen, goto: true, keywords: ['version', 'help'] },
    { id: 'company.shortcuts', title: 'Keyboard Shortcuts', component: ShortcutsScreen, keywords: ['keys', 'hotkeys', 'help'] },
  ],
  menu: [
    { section: 'company', label: 'Company Details', screen: 'company.profile', order: 10, access: 'company.view', description: 'Name, address, GSTIN, books and logo', keywords: ['alter company'] },
    { section: 'company', label: 'Features', screen: 'company.features', hotkey: 'F11', order: 20, description: 'Turn stock, orders, GST and more on or off' },
    { section: 'company', label: 'Configuration', screen: 'company.config', hotkey: 'F12', order: 30, description: 'Round-off, GST settings, checks, display and backups' },
    { section: 'company', label: 'Lock Books', screen: 'company.periodLock', order: 40, access: 'period.lock', description: 'Stop changes to entries up to a date' },
    { section: 'utilities', label: 'Keyboard Shortcuts', screen: 'company.shortcuts', order: 900, description: 'Every key in one list' },
    { section: 'utilities', label: 'About Pevqori', screen: 'company.about', order: 910, description: 'Version and data folder' },
  ],
};
