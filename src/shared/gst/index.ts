/**
 * Public API of the shared GST library. Import from here:
 *   import { computeInvoice, validateGstin, stateOptions } from '../../shared/gst/index.ts';
 */
export type {
  ApportionMethod,
  CompanyRegistrationType,
  ComputedLine,
  DocumentKind,
  GstinKind,
  GstinValidation,
  GstNature,
  GstState,
  HsnRow,
  InvoiceComputation,
  InvoiceContext,
  InvoiceLineInput,
  InvoiceRoundOff,
  InvoiceTotals,
  PlaceOfSupplyInput,
  PlaceOfSupplyResult,
  RegistrationType,
  SupplyDirection,
  SupplyKind,
  Taxability,
  TaxBucket,
  TaxMode,
  UqcEntry,
} from '../types/gst.ts';
export { GST_NATURES, REGISTRATION_TYPES, TAXABILITIES } from '../types/gst.ts';

export {
  findState,
  getState,
  GST_STATES,
  isKnownStateCode,
  isUtgstState,
  normalizeStateCode,
  POS_OTHER_COUNTRIES,
  STATE_CENTRE_JURISDICTION,
  STATE_OTHER_TERRITORY,
  stateLabel,
  stateName,
  stateOptions,
} from './states.ts';
export type { StateOption } from './states.ts';

export { gstinCheckChar, gstinStateCode, isValidGstin, normalizeGstin, panFromGstin, validateGstin } from './gstin.ts';

export { DEFAULT_GOODS_UQC, isValidUqc, SERVICES_UQC, suggestUqc, UQC_LIST, uqcDescription, uqcOptions } from './uqc.ts';

export {
  GST_CORE_RATES_2025,
  GST_RATES,
  GST_RATIONALISATION_DATE,
  GST_RETIRED_SLABS_2025,
  isRetiredSlabOn,
  isStandardRate,
  isValidCessRate,
  isValidRate,
  rateOptions,
  splitRate,
} from './rates.ts';

export { determinePlaceOfSupply, isInterState, taxModeFor } from './pos.ts';

export {
  B2CL_THRESHOLD_BEFORE_2024_08_PAISE,
  B2CL_THRESHOLD_REVISED_ON,
  b2clThresholdOn,
  classifySupply,
  GST_NATURE_LABELS,
  isOutwardNature,
  isRegisteredParty,
  isZeroRatedNature,
} from './classify.ts';
export type { ClassifyContext, ClassifyTotals } from './classify.ts';

export { computeInvoice, MAX_INVOICE_PAISE, MAX_LINE_PAISE, taxableFromInclusive, taxAt } from './engine.ts';
