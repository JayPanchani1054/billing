/**
 * Company features (F11) and configuration (F12). Stored as JSON in the `settings` table under
 * the keys 'features' and 'config'. Always read through the company module helpers, which
 * deep-merge stored values over these defaults (so new keys get sane defaults automatically).
 */

export interface CompanyFeatures {
  // Accounting
  billWise: boolean;
  costCentres: boolean;
  interest: boolean;
  multiCurrency: boolean;
  chequePrinting: boolean;
  // Inventory
  inventory: boolean;
  /** Closing stock in P&L/Balance Sheet comes from inventory valuation. */
  integrateInventory: boolean;
  multipleGodowns: boolean;
  batches: boolean;
  expiryDates: boolean;
  orderProcessing: boolean;
  /** Delivery notes / receipt notes with tracking numbers. */
  trackingNumbers: boolean;
  rejectionNotes: boolean;
  actualAndBilledQty: boolean;
  priceLevels: boolean;
  discountColumn: boolean;
  /** Bill of Materials and Manufacturing Journal (mfg module). */
  manufacturing: boolean;
  /** Job work: third-party godowns, Material In/Out, job work orders, ITC-04 (mfg module; needs multiple godowns). */
  jobWork: boolean;
  // Taxation
  gst: boolean;
  einvoice: boolean;
  ewayBill: boolean;
  tds: boolean;
  tcs: boolean;
  // Security
  security: boolean;
}

export const DEFAULT_FEATURES: CompanyFeatures = {
  billWise: true,
  costCentres: false,
  interest: false,
  multiCurrency: false,
  chequePrinting: false,
  inventory: true,
  integrateInventory: true,
  multipleGodowns: false,
  batches: false,
  expiryDates: false,
  orderProcessing: false,
  trackingNumbers: false,
  rejectionNotes: false,
  actualAndBilledQty: false,
  priceLevels: false,
  discountColumn: true,
  manufacturing: false,
  jobWork: false,
  gst: true,
  einvoice: false,
  ewayBill: false,
  tds: false,
  tcs: false,
  security: false,
};

export type RoundOffMethod = 'nearest' | 'up' | 'down';
export type GuardPolicy = 'allow' | 'warn' | 'block';
export type InvoiceTemplate = 'classic' | 'modern' | 'compact';

export interface CompanyConfig {
  roundOff: { enabled: boolean; method: RoundOffMethod; /** paise, 100 = nearest rupee */ unit: number };
  invoice: {
    printAfterSave: boolean;
    template: InvoiceTemplate;
    copies: Array<'original' | 'duplicate' | 'triplicate'>;
    showHsnSummary: boolean;
    showBankDetails: boolean;
    bankLedgerId: number | null;
    showUpiQr: boolean;
    upiId: string;
    declaration: string;
    terms: string;
    signatoryLabel: string;
    /** Print item-wise tax columns (CGST/SGST/IGST) on the invoice. */
    itemwiseTax: boolean;
  };
  gst: {
    lutNumber: string;
    lutValidFrom: string | null;
    lutValidTo: string | null;
    /** Annual aggregate turnover tier drives HSN digits in GSTR-1: ≤5 Cr → 4, >5 Cr → 6. */
    hsnDigits: 4 | 6 | 8;
    b2clThresholdPaise: number;
    ewayThresholdPaise: number;
    /** Return filing frequency (affects GSTR-1 period options). */
    filingFrequency: 'monthly' | 'quarterly';
  };
  guards: {
    negativeStock: GuardPolicy;
    negativeCash: GuardPolicy;
    creditLimit: GuardPolicy;
    /** Warn/block when a purchase reference number repeats for the same supplier. */
    duplicateSupplierInvoice: GuardPolicy;
  };
  /** Vouchers dated on or before this date cannot be created, altered or deleted. */
  lockedUpTo: string | null;
  backup: { auto: boolean; keepLast: number; folder: string | null };
  display: { showZeroBalances: boolean; dateFormat: 'DD-MM-YYYY' | 'DD-MMM-YYYY' };
}

export const DEFAULT_CONFIG: CompanyConfig = {
  roundOff: { enabled: true, method: 'nearest', unit: 100 },
  invoice: {
    printAfterSave: false,
    template: 'modern',
    copies: ['original'],
    showHsnSummary: true,
    showBankDetails: true,
    bankLedgerId: null,
    showUpiQr: false,
    upiId: '',
    declaration:
      'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.',
    terms: '',
    signatoryLabel: 'Authorised Signatory',
    itemwiseTax: false,
  },
  gst: {
    lutNumber: '',
    lutValidFrom: null,
    lutValidTo: null,
    hsnDigits: 4,
    b2clThresholdPaise: 1_00_000_00,
    ewayThresholdPaise: 50_000_00,
    filingFrequency: 'monthly',
  },
  guards: { negativeStock: 'warn', negativeCash: 'warn', creditLimit: 'warn', duplicateSupplierInvoice: 'warn' },
  lockedUpTo: null,
  backup: { auto: true, keepLast: 10, folder: null },
  display: { showZeroBalances: false, dateFormat: 'DD-MMM-YYYY' },
};

/** Deep-merge `stored` over `defaults` (objects merged recursively, arrays/primitives replaced). */
export function mergeDefaults<T>(defaults: T, stored: unknown): T {
  if (stored === null || stored === undefined || typeof stored !== 'object' || Array.isArray(stored)) return defaults;
  if (typeof defaults !== 'object' || defaults === null || Array.isArray(defaults)) return defaults;
  const out: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
  for (const [k, val] of Object.entries(stored as Record<string, unknown>)) {
    if (!(k in out)) continue;
    const d = out[k];
    out[k] = d !== null && typeof d === 'object' && !Array.isArray(d) ? mergeDefaults(d, val) : val === undefined ? d : val;
  }
  return out as T;
}
