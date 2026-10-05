/**
 * GST Unique Quantity Codes (UQC) as accepted by GSTR-1 (HSN summary) and the e-invoice / e-way bill
 * schemas. Services are reported with 'NA' in the GSTR-1 HSN summary.
 */
import type { UqcEntry } from '../types/gst.ts';

export const UQC_LIST: readonly UqcEntry[] = [
  { code: 'BAG', description: 'Bags' },
  { code: 'BAL', description: 'Bale' },
  { code: 'BDL', description: 'Bundles' },
  { code: 'BKL', description: 'Buckles' },
  { code: 'BOU', description: 'Billion of Units' },
  { code: 'BOX', description: 'Box' },
  { code: 'BTL', description: 'Bottles' },
  { code: 'BUN', description: 'Bunches' },
  { code: 'CAN', description: 'Cans' },
  { code: 'CBM', description: 'Cubic Meters' },
  { code: 'CCM', description: 'Cubic Centimeters' },
  { code: 'CMS', description: 'Centimeters' },
  { code: 'CTN', description: 'Cartons' },
  { code: 'DOZ', description: 'Dozens' },
  { code: 'DRM', description: 'Drums' },
  { code: 'GGK', description: 'Great Gross' },
  { code: 'GMS', description: 'Grammes' },
  { code: 'GRS', description: 'Gross' },
  { code: 'GYD', description: 'Gross Yards' },
  { code: 'KGS', description: 'Kilograms' },
  { code: 'KLR', description: 'Kilolitre' },
  { code: 'KME', description: 'Kilometre' },
  { code: 'LTR', description: 'Litres' },
  { code: 'MLT', description: 'Millilitre' },
  { code: 'MTR', description: 'Meters' },
  { code: 'MTS', description: 'Metric Ton' },
  { code: 'NOS', description: 'Numbers' },
  { code: 'OTH', description: 'Others' },
  { code: 'PAC', description: 'Packs' },
  { code: 'PCS', description: 'Pieces' },
  { code: 'PRS', description: 'Pairs' },
  { code: 'QTL', description: 'Quintal' },
  { code: 'ROL', description: 'Rolls' },
  { code: 'SET', description: 'Sets' },
  { code: 'SQF', description: 'Square Feet' },
  { code: 'SQM', description: 'Square Meters' },
  { code: 'SQY', description: 'Square Yards' },
  { code: 'TBS', description: 'Tablets' },
  { code: 'TGM', description: 'Ten Gross' },
  { code: 'THD', description: 'Thousands' },
  { code: 'TON', description: 'Tonnes' },
  { code: 'TUB', description: 'Tubes' },
  { code: 'UGS', description: 'US Gallons' },
  { code: 'UNT', description: 'Units' },
  { code: 'YDS', description: 'Yards' },
];

/** UQC used for services (SAC lines) in the GSTR-1 HSN summary. */
export const SERVICES_UQC = 'NA';
/** Fallback UQC for goods whose unit has no better match. */
export const DEFAULT_GOODS_UQC = 'OTH';

const BY_CODE: ReadonlyMap<string, UqcEntry> = new Map(UQC_LIST.map((u) => [u.code, u]));

export function isValidUqc(code: string | null | undefined): boolean {
  return BY_CODE.has((code ?? '').trim().toUpperCase());
}

export function uqcDescription(code: string | null | undefined): string {
  return BY_CODE.get((code ?? '').trim().toUpperCase())?.description ?? '';
}

/** Options for a UQC picker: 'KGS - Kilograms'. */
export function uqcOptions(): Array<{ value: string; label: string }> {
  return UQC_LIST.map((u) => ({ value: u.code, label: `${u.code} - ${u.description}` }));
}

/** Common unit spellings (lower-case, without dots/spaces) → UQC. */
const ALIASES: Readonly<Record<string, string>> = {
  // count
  no: 'NOS', nos: 'NOS', number: 'NOS', numbers: 'NOS', num: 'NOS', ea: 'NOS', each: 'NOS',
  pc: 'PCS', pcs: 'PCS', piece: 'PCS', pieces: 'PCS',
  unit: 'UNT', units: 'UNT', u: 'UNT',
  pair: 'PRS', pairs: 'PRS', pr: 'PRS', prs: 'PRS',
  set: 'SET', sets: 'SET',
  dozen: 'DOZ', dozens: 'DOZ', doz: 'DOZ', dz: 'DOZ', dzn: 'DOZ',
  gross: 'GRS', grs: 'GRS', greatgross: 'GGK', tengross: 'TGM',
  thousand: 'THD', thousands: 'THD', thd: 'THD',
  tab: 'TBS', tabs: 'TBS', tablet: 'TBS', tablets: 'TBS',
  // packaging
  bag: 'BAG', bags: 'BAG', bale: 'BAL', bales: 'BAL', bundle: 'BDL', bundles: 'BDL', bdl: 'BDL',
  buckle: 'BKL', buckles: 'BKL', box: 'BOX', boxes: 'BOX', bottle: 'BTL', bottles: 'BTL', btl: 'BTL',
  bunch: 'BUN', bunches: 'BUN', can: 'CAN', cans: 'CAN', tin: 'CAN', tins: 'CAN',
  carton: 'CTN', cartons: 'CTN', ctn: 'CTN', cs: 'CTN', case: 'CTN', cases: 'CTN',
  drum: 'DRM', drums: 'DRM', pack: 'PAC', packs: 'PAC', pkt: 'PAC', pkts: 'PAC', packet: 'PAC', packets: 'PAC', pac: 'PAC',
  roll: 'ROL', rolls: 'ROL', rol: 'ROL', tube: 'TUB', tubes: 'TUB',
  // weight
  kg: 'KGS', kgs: 'KGS', kilo: 'KGS', kilos: 'KGS', kilogram: 'KGS', kilograms: 'KGS',
  g: 'GMS', gm: 'GMS', gms: 'GMS', gram: 'GMS', grams: 'GMS', gramme: 'GMS', grammes: 'GMS', gr: 'GMS',
  qtl: 'QTL', quintal: 'QTL', quintals: 'QTL',
  t: 'TON', ton: 'TON', tons: 'TON', tonne: 'TON', tonnes: 'TON',
  mt: 'MTS', mts: 'MTS', metricton: 'MTS', metrictonne: 'MTS',
  // volume
  l: 'LTR', lt: 'LTR', ltr: 'LTR', ltrs: 'LTR', litre: 'LTR', litres: 'LTR', liter: 'LTR', liters: 'LTR',
  ml: 'MLT', mlt: 'MLT', millilitre: 'MLT', milliliter: 'MLT',
  kl: 'KLR', klr: 'KLR', kilolitre: 'KLR', kiloliter: 'KLR',
  cbm: 'CBM', cum: 'CBM', m3: 'CBM', cubicmeter: 'CBM', cubicmetre: 'CBM',
  cc: 'CCM', ccm: 'CCM', cm3: 'CCM',
  gal: 'UGS', gallon: 'UGS', gallons: 'UGS', ugs: 'UGS',
  // length & area
  m: 'MTR', mtr: 'MTR', mtrs: 'MTR', meter: 'MTR', meters: 'MTR', metre: 'MTR', metres: 'MTR',
  cm: 'CMS', cms: 'CMS', centimeter: 'CMS', centimetre: 'CMS',
  km: 'KME', kms: 'KME', kilometer: 'KME', kilometre: 'KME',
  yd: 'YDS', yds: 'YDS', yard: 'YDS', yards: 'YDS', grossyard: 'GYD', grossyards: 'GYD',
  sqft: 'SQF', sft: 'SQF', ft2: 'SQF', squarefeet: 'SQF', squarefoot: 'SQF',
  sqm: 'SQM', sqmtr: 'SQM', m2: 'SQM', squaremeter: 'SQM', squaremetre: 'SQM',
  sqyd: 'SQY', sqyds: 'SQY', squareyard: 'SQY', squareyards: 'SQY',
  // time & misc (no UQC exists)
  hr: 'OTH', hrs: 'OTH', hour: 'OTH', hours: 'OTH', day: 'OTH', days: 'OTH', month: 'OTH', months: 'OTH',
};

/**
 * Suggest a UQC for a unit symbol or name ('Kg' → 'KGS', 'Pcs' → 'PCS', 'sq. ft' → 'SQF').
 * Exact UQC codes are returned as-is; anything unrecognised maps to 'OTH'.
 */
export function suggestUqc(unitSymbol: string | null | undefined): string {
  const raw = (unitSymbol ?? '').trim();
  if (!raw) return DEFAULT_GOODS_UQC;
  const upper = raw.toUpperCase();
  if (BY_CODE.has(upper)) return upper;
  const key = raw.toLowerCase().replace(/[\s.\-_/]+/g, '');
  return ALIASES[key] ?? DEFAULT_GOODS_UQC;
}
