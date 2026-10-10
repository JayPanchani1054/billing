/**
 * Plain-language catalogue of company features (F11) and their dependencies — pure data + rules
 * (tested in featureCatalog.test.ts). Mirrors core normalizeFeatures() so the UI never offers a
 * combination the server would silently change.
 */
import type { CompanyFeatures } from '../../../shared/settings.ts';

export type FeatureKey = keyof CompanyFeatures;

export interface FeatureInfo {
  key: FeatureKey;
  label: string;
  description: string;
  group: 'accounting' | 'inventory' | 'taxation' | 'security';
  /** Feature that must be on for this one to be available. */
  requires?: FeatureKey;
  /**
   * Changed on another screen, never by the F11 save (the server refuses it there). Security needs the
   * Owner's password, so it is turned on/off under Security Settings (security.enable / security.disable).
   */
  managedOn?: { screen: string; screenLabel: string; note: string };
}

export const FEATURE_GROUP_LABELS: Readonly<Record<FeatureInfo['group'], string>> = {
  accounting: 'Accounting',
  inventory: 'Inventory',
  taxation: 'Taxation',
  security: 'Security',
};

export const FEATURE_CATALOG: readonly FeatureInfo[] = [
  // Accounting
  { key: 'billWise', group: 'accounting', label: 'Bill-wise details', description: 'Track each invoice separately, so you can see which bills a customer or supplier still has to pay and how overdue they are.' },
  { key: 'costCentres', group: 'accounting', label: 'Cost centres', description: 'Split income and expenses by branch, project or department.' },
  { key: 'interest', group: 'accounting', label: 'Interest calculation', description: 'Work out interest on late payments for selected parties.' },
  { key: 'multiCurrency', group: 'accounting', label: 'Multiple currencies', description: 'Record transactions in foreign currencies, for exports and imports.' },
  { key: 'chequePrinting', group: 'accounting', label: 'Cheque printing', description: 'Print cheques straight from payment entries.' },
  // Inventory
  { key: 'inventory', group: 'inventory', label: 'Maintain stock', description: 'Keep stock items, quantities and stock reports.' },
  { key: 'integrateInventory', group: 'inventory', requires: 'inventory', label: 'Stock value in accounts', description: 'Show closing stock in the Balance Sheet and Profit & Loss from your stock records.' },
  { key: 'multipleGodowns', group: 'inventory', requires: 'inventory', label: 'Multiple godowns', description: 'Keep stock in more than one warehouse, shop or location.' },
  { key: 'batches', group: 'inventory', requires: 'inventory', label: 'Batches', description: 'Track stock by batch or lot number.' },
  { key: 'expiryDates', group: 'inventory', requires: 'batches', label: 'Expiry dates', description: 'Record manufacturing and expiry dates for batches — useful for medicines and food.' },
  { key: 'orderProcessing', group: 'inventory', label: 'Sales and purchase orders', description: 'Record orders and see what is still pending delivery or billing.' },
  { key: 'trackingNumbers', group: 'inventory', requires: 'inventory', label: 'Delivery and receipt notes', description: 'Record goods sent or received before the invoice and link them to it later.' },
  { key: 'rejectionNotes', group: 'inventory', requires: 'inventory', label: 'Rejection notes', description: 'Record goods returned to or by a party without a credit or debit note.' },
  { key: 'actualAndBilledQty', group: 'inventory', requires: 'inventory', label: 'Actual and billed quantity', description: 'Bill a different quantity from what was actually shipped, for free items or wastage.' },
  { key: 'priceLevels', group: 'inventory', requires: 'inventory', label: 'Price levels', description: 'Keep separate price lists, for example wholesale and retail.' },
  { key: 'discountColumn', group: 'inventory', label: 'Discount column on invoices', description: 'Show a discount % column on invoice lines.' },
  { key: 'manufacturing', group: 'inventory', requires: 'inventory', label: 'Bill of materials and manufacturing', description: 'Keep bills of materials for the goods you make and record production in a Manufacturing Journal that works out the cost of the finished goods.' },
  { key: 'jobWork', group: 'inventory', requires: 'multipleGodowns', label: 'Job work', description: 'Send material to job workers or process material for principals: job work orders, Material Out / In challans, pending job work with the one-year / three-year return limits, and ITC-04.' },
  // Taxation
  { key: 'gst', group: 'taxation', label: 'GST', description: 'Charge and track GST on sales and purchases, and prepare GST returns. Turning it on creates the GST tax ledgers.' },
  { key: 'einvoice', group: 'taxation', requires: 'gst', label: 'e-Invoicing', description: 'Prepare e-invoice (IRN) data, needed once your turnover crosses the e-invoicing limit.' },
  { key: 'ewayBill', group: 'taxation', requires: 'gst', label: 'e-Way Bill', description: 'Prepare e-way bill details for moving goods worth more than ₹50,000.' },
  {
    key: 'tds',
    group: 'taxation',
    label: 'TDS',
    description:
      'Deduct tax at source on contracts, professional fees, rent, commission and other payments as you enter purchases, journals and payments; track TDS payable, challans, interest and 26Q / 27Q data.',
  },
  {
    key: 'tcs',
    group: 'taxation',
    label: 'TCS',
    description: 'Collect tax at source on sales of scrap, minerals, forest produce or motor vehicles above ₹10 lakh: the tax is added to the invoice; 27EQ data.',
  },
  // Security
  {
    key: 'security',
    group: 'security',
    label: 'Password protection',
    description: 'Ask for a username and password to open this company. Needs an Owner user with a password.',
    managedOn: {
      screen: 'security.settings',
      screenLabel: 'Security Settings',
      note: 'Turned on or off under Security Settings, which asks for the Owner password.',
    },
  },
];

const BY_KEY: ReadonlyMap<FeatureKey, FeatureInfo> = new Map(FEATURE_CATALOG.map((f) => [f.key, f]));

export function featureInfo(key: FeatureKey): FeatureInfo | undefined {
  return BY_KEY.get(key);
}

export function featureLabel(key: FeatureKey): string {
  return BY_KEY.get(key)?.label ?? key;
}

/** Is the feature's prerequisite chain satisfied? */
export function isFeatureAvailable(key: FeatureKey, features: Readonly<CompanyFeatures>): boolean {
  let req = BY_KEY.get(key)?.requires;
  let guard = 0;
  while (req && guard++ < 8) {
    if (!features[req]) return false;
    req = BY_KEY.get(req)?.requires;
  }
  return true;
}

/** Why a toggle is unavailable ("Turn on Batches first"), or null when it can be changed. */
export function featureBlockedReason(key: FeatureKey, features: Readonly<CompanyFeatures>): string | null {
  const req = BY_KEY.get(key)?.requires;
  if (!req) return null;
  if (!isFeatureAvailable(req, features)) return featureBlockedReason(req, features);
  return features[req] ? null : `Turn on ${featureLabel(req)} first.`;
}

/** Same dependency rules as the server (core/modules/company/service.ts normalizeFeatures). */
export function normalizeFeatureToggles(f: Readonly<CompanyFeatures>): CompanyFeatures {
  const out: CompanyFeatures = { ...f };
  for (const info of FEATURE_CATALOG) {
    if (info.requires && !isFeatureAvailable(info.key, out)) out[info.key] = false;
  }
  return out;
}

/** Where a feature is changed when it is not changed on the F11 screen (null = F11 changes it). */
export function featureManagedOn(key: FeatureKey): FeatureInfo['managedOn'] | null {
  return BY_KEY.get(key)?.managedOn ?? null;
}

/** Keys whose value differs between two feature sets (features managed on another screen never count). */
export function changedFeatures(a: Readonly<CompanyFeatures>, b: Readonly<CompanyFeatures>): FeatureKey[] {
  return (Object.keys(a) as FeatureKey[]).filter((k) => a[k] !== b[k] && !featureManagedOn(k));
}
