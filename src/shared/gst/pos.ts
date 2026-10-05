/**
 * Place of supply (IGST Act ss.10–13, simplified to what an invoice needs) and the
 * inter-state / intra-state decision that selects IGST vs CGST + SGST/UTGST.
 */
import type { PlaceOfSupplyInput, PlaceOfSupplyResult, RegistrationType, TaxMode } from '../types/gst.ts';
import { getState, isUtgstState, normalizeStateCode, POS_OTHER_COUNTRIES, stateLabel } from './states.ts';

const known = (code: string | null | undefined): string => {
  const c = normalizeStateCode(code);
  return c && getState(c) ? c : '';
};

/**
 * Determine the place of supply for a document.
 *
 *  1. An explicit place of supply on the voucher always wins (when it is a known code).
 *  2. Outward to an overseas party → '96' (Other Countries).
 *  3. Inward (we are the recipient) → our own state: goods are delivered to us and services are
 *     received at our registered location, so the supplier's invoice carries our state as POS.
 *     Imports follow the same rule (location of the importer); they are inter-state regardless
 *     (see isInterState). If our state is unknown, fall back to the supplier's state.
 *  4. Outward goods → consignee (ship-to) state, else the buyer's state.
 *  5. Outward services → the recipient's state.
 *  6. No usable party state (e.g. walk-in B2C) → the company's state (location of supplier).
 */
export function determinePlaceOfSupply(input: PlaceOfSupplyInput): PlaceOfSupplyResult {
  const explicit = known(input.explicit);
  if (explicit) return { code: explicit, reason: `Place of supply entered on the voucher (${stateLabel(explicit)})` };

  const company = known(input.companyStateCode);
  const party = known(input.partyStateCode);
  const consignee = known(input.consigneeStateCode);

  if (input.direction === 'outward' && input.partyRegistration === 'overseas') {
    return { code: POS_OTHER_COUNTRIES, reason: 'Export: recipient is outside India' };
  }

  if (input.direction === 'inward') {
    if (company) {
      return {
        code: company,
        reason:
          input.partyRegistration === 'overseas'
            ? `Import: place of supply is the importer's location (${stateLabel(company)})`
            : `Purchase received at our location (${stateLabel(company)})`,
      };
    }
    if (party) return { code: party, reason: `Company state not set; using the supplier's state (${stateLabel(party)})` };
    return { code: '', reason: 'Place of supply could not be determined: set the company and party states' };
  }

  if (input.supplyKind === 'goods' && consignee) {
    return { code: consignee, reason: `Goods delivered to the consignee's state (${stateLabel(consignee)})` };
  }
  if (party) {
    return {
      code: party,
      reason:
        input.supplyKind === 'goods'
          ? `Goods delivered to the buyer's state (${stateLabel(party)})`
          : `Services: recipient's location (${stateLabel(party)})`,
    };
  }
  if (company) {
    return { code: company, reason: `Party state not set; assumed the company's state (${stateLabel(company)})` };
  }
  return { code: '', reason: 'Place of supply could not be determined: set the company and party states' };
}

/**
 * Inter-state supply? SEZ supplies (party or our company is an SEZ unit/developer) and exports/imports
 * are always inter-state (IGST Act ss.7(1)–(5)); otherwise compare the supplier's state with the
 * place of supply.
 */
export function isInterState(
  supplierState: string | null | undefined,
  pos: string | null | undefined,
  partyRegistration?: RegistrationType,
  opts: { companyIsSez?: boolean } = {},
): boolean {
  if (partyRegistration === 'sez' || partyRegistration === 'overseas' || opts.companyIsSez) return true;
  const p = normalizeStateCode(pos);
  if (p === POS_OTHER_COUNTRIES) return true;
  // An unknown state ('') never equals a known one, so a half-known pair is treated as inter-state.
  return normalizeStateCode(supplierState) !== p;
}

/**
 * Duty heads for a supply: IGST when inter-state, CGST + UTGST in UTs without legislature,
 * CGST + SGST otherwise; 'none' when GST is not charged on the document at all.
 */
export function taxModeFor(interState: boolean, placeOfSupply: string | null | undefined, chargesGst = true): TaxMode {
  if (!chargesGst) return 'none';
  if (interState) return 'igst';
  return isUtgstState(placeOfSupply) ? 'cgst_utgst' : 'cgst_sgst';
}
