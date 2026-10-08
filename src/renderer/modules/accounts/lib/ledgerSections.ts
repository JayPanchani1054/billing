/**
 * Which parts of the ledger form apply to a ledger, from its group's classification and the
 * company's F11 features. Mirrors the core placement rules (src/core/modules/accounts/ledgerRules.ts:
 * bank fields only under Bank Accounts / Bank OD, tax fields only under Duties & Taxes, GST rate
 * details only for income / expense / fixed-asset ledgers, ITC and reverse charge only inward).
 * Pure — tested in ledgerSections.test.ts.
 */
import type { CompanyFeatures } from '../../../../shared/settings.ts';
import type { LedgerClass } from '../../../../shared/types/accounts.ts';

export interface LedgerSections {
  /** Customer / supplier: mailing details, contact, PAN, credit control, GST registration. */
  party: boolean;
  /** Bill-wise switch (+ opening bills grid). */
  billWise: boolean;
  /** Interest calculation (F11 interest, parties). */
  interest: boolean;
  /** Bank account details (Bank Accounts / Bank OD A/c). */
  bank: boolean;
  /** Tax type, duty head, direction (Duties & Taxes). */
  tax: boolean;
  /** GST rate details (sales / purchase / income / expense / fixed assets), only when the company uses GST. */
  gstDetails: boolean;
  /**
   * The group allows GST rate details at all (core gstDetailsAllowed), whether or not the company
   * uses GST right now. Values are cleared only when this is false.
   */
  gstAllowed: boolean;
  /** The group allows ITC eligibility / reverse charge (purchase / expense / fixed assets). */
  gstInwardAllowed: boolean;
  /** ITC eligibility and reverse charge (purchase / expense / fixed assets). */
  gstInward: boolean;
  /** "Include in assessable value" / "appropriate by" — charges such as freight (income/expense but not sales/purchase). */
  gstCharges: boolean;
  /** Cost centres applicable (F11 cost centres, income/expense ledgers). */
  costCentres: boolean;
  /** "Inventory values are affected" (F11 inventory, income/expense ledgers). */
  inventoryValues: boolean;
  /** TDS applicable (F11 TDS; expense and party ledgers). */
  tds: boolean;
  /** Currency of the ledger (F11 multi-currency). */
  currency: boolean;
  /**
   * The opening balance may be entered. False for a Stock-in-Hand ledger when inventory is
   * integrated with accounts (opening stock comes from the stock items).
   */
  openingBalance: boolean;
}

export interface SectionContext {
  features: Pick<CompanyFeatures, 'billWise' | 'interest' | 'costCentres' | 'inventory' | 'integrateInventory' | 'tds' | 'multiCurrency' | 'gst'>;
  /** The ledger's group is (under) Stock-in-Hand. */
  stockInHand?: boolean;
  /** The ledger currently keeps bills (show the bill-wise switch even for a non-party ledger). */
  billWiseOn?: boolean;
  /** GST is on in the company (company.gstEnabled). Defaults to features.gst. */
  gstEnabled?: boolean;
}

export const NO_SECTIONS: LedgerSections = {
  party: false,
  billWise: false,
  interest: false,
  bank: false,
  tax: false,
  gstDetails: false,
  gstAllowed: false,
  gstInwardAllowed: false,
  gstInward: false,
  gstCharges: false,
  costCentres: false,
  inventoryValues: false,
  tds: false,
  currency: false,
  openingBalance: true,
};

export function ledgerSections(cls: LedgerClass | null, ctx: SectionContext): LedgerSections {
  if (!cls) return { ...NO_SECTIONS, currency: ctx.features.multiCurrency };
  const f = ctx.features;
  const gst = ctx.gstEnabled ?? f.gst;
  const fixedAsset = cls.primaryCode === 'FIXED_ASSETS';
  const pl = cls.isIncome || cls.isExpense;
  const gstAllowed = pl || fixedAsset;
  const gstInwardAllowed = cls.isExpense || fixedAsset;
  const gstDetails = gst && gstAllowed;
  return {
    party: cls.isParty,
    billWise: (f.billWise && cls.isParty) || ctx.billWiseOn === true,
    interest: f.interest && cls.isParty,
    bank: cls.isBank,
    tax: cls.isDutyTax,
    gstDetails,
    gstAllowed,
    gstInwardAllowed,
    gstInward: gstDetails && gstInwardAllowed,
    gstCharges: gstDetails && pl && !cls.isSales && !cls.isPurchase,
    costCentres: f.costCentres && pl,
    inventoryValues: f.inventory && pl,
    tds: f.tds && (cls.isExpense || cls.isParty),
    currency: f.multiCurrency,
    openingBalance: !(f.inventory && f.integrateInventory && ctx.stockInHand === true),
  };
}

/** Side an empty opening balance starts on: Dr for assets/expenses, Cr for liabilities/income. */
export function defaultOpeningSide(cls: LedgerClass | null): 'dr' | 'cr' {
  if (!cls) return 'dr';
  return cls.nature === 'liabilities' || cls.nature === 'income' ? 'cr' : 'dr';
}

/** Section titles in display order (for the form's jump list and the status-bar hint). */
export function visibleSectionTitles(s: LedgerSections): string[] {
  const out = ['Basic details'];
  if (s.openingBalance) out.push('Opening balance');
  if (s.party) out.push('Party details', 'GST registration');
  if (s.bank) out.push('Bank details');
  if (s.tax) out.push('Tax ledger');
  if (s.gstDetails) out.push('GST details');
  if (s.costCentres || s.inventoryValues || s.tds) out.push('Other settings');
  return out;
}
