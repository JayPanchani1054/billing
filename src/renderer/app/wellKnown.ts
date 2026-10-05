/**
 * Screen ids the shell links to (Gateway quick actions, checklist, Go To targets, voucher hotkeys).
 * Feature modules should register these exact ids. Until a module registers its screen, opening it
 * shows a calm "This screen isn't available yet" toast.
 */
export const WELL_KNOWN_SCREENS = {
  /** Gateway right panel, rendered inline with params { embedded: true }. */
  dashboard: 'dashboard.home',
  /** Ledger create/alter. Params { id?, initialName?, forResult? }; on create pop({ id, name }). */
  ledgerForm: 'accounts.ledger.form',
  ledgerList: 'accounts.ledger.list',
  /** Stock item create/alter. Params { id?, initialName?, forResult? }. */
  itemForm: 'inventory.item.form',
  /** Voucher entry. Params { baseType, id? } (F4–F10 hotkeys push this). */
  voucherEntry: 'vouchers.entry',
  dayBook: 'vouchers.daybook',
  balanceSheet: 'reports.balanceSheet',
  profitLoss: 'reports.profitLoss',
  trialBalance: 'reports.trialBalance',
  /** Ledger account report. Params { ledgerId } (Go To ledger results open this when registered). */
  ledgerReport: 'reports.ledger',
  companyProfile: 'company.profile',
  companyFeatures: 'company.features',
  companyConfig: 'company.config',
} as const;
