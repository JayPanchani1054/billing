/**
 * Vouchers module routes. The route table with input/output types is documented in README.md.
 */
import { VOUCHER_BASE_TYPES } from '../../../shared/constants.ts';
import { REGISTRATION_TYPES, TAXABILITIES } from '../../../shared/gst/index.ts';
import {
  BILL_REF_TYPES,
  INSTRUMENT_TYPES,
  VOUCHER_MODES,
  type TrackingKind,
  type VoucherInput,
  type VoucherListInput,
} from '../../../shared/types/vouchers.ts';
import { companyRoute, type RouteMap } from '../../api/route.ts';
import { v, type Schema } from '../../lib/validate.ts';
import { pendingBills } from './bills.ts';
import { entryContext, getVoucher, listVouchers, MAX_LIST_LIMIT, partyContext, trackingRefs } from './queries.ts';
import {
  cancelVoucher,
  deleteVoucher,
  duplicateVoucher,
  nextVoucherNumber,
  previewVoucher,
  saveVoucher,
  setVoucherOptional,
} from './service.ts';

const optText = (max: number): Schema<string | undefined> => v.string({ max }).optional();
const stateCode = v.string({ max: 2, pattern: /^(\d{2})?$/, patternMessage: 'State code must be two digits' }).optional();

const BillAllocationSchema = v.object({
  refType: v.enum(BILL_REF_TYPES),
  billName: optText(100),
  amount: v.paise({ min: 0 }),
  creditDays: v.int({ min: 0, max: 3650 }).optional(),
  dueDate: v.date().optional(),
});

const CostAllocationSchema = v.object({ costCentreId: v.id(), amount: v.paise({ min: 0 }) });

const InstrumentSchema = v.object({
  type: v.enum(INSTRUMENT_TYPES),
  number: optText(50),
  date: v.date().optional(),
  bankName: optText(100),
  favouring: optText(200),
});

const LedgerGstSchema = v.object({
  rate: v.number({ min: 0, max: 100 }).optional(),
  cessRate: v.number({ min: 0, max: 400 }).optional(),
  hsnSac: optText(10),
  taxability: v.enum(TAXABILITIES).optional(),
  supplyKind: v.enum(['goods', 'services'] as const).optional(),
});

const LedgerLineSchema = v.object({
  ledgerId: v.id(),
  amount: v.paise(),
  narration: optText(1000),
  billAllocations: v.array(BillAllocationSchema, { max: 1000 }).optional(),
  costAllocations: v.array(CostAllocationSchema, { max: 500 }).optional(),
  instrument: InstrumentSchema.optional(),
  gst: LedgerGstSchema.optional(),
});

const ItemLineSchema = v.object({
  itemId: v.id(),
  godownId: v.id().optional(),
  batchName: optText(100),
  mfgDate: v.date().optional(),
  expiryDate: v.date().optional(),
  qty: v.number({ min: 0, max: 1e12 }),
  altQty: v.number({ min: 0, max: 1e12 }).optional(),
  billedQty: v.number({ min: 0, max: 1e12 }).optional(),
  rate: v.number({ min: 0, max: 1e12 }).default(0),
  rateInclusiveOfTax: v.boolean().optional(),
  discountPct: v.number({ min: 0, max: 100 }).optional(),
  amount: v.paise({ min: 0 }).optional(),
  ledgerId: v.id().optional(),
  description: optText(1000),
  gstRateOverride: v.number({ min: 0, max: 100 }).optional(),
  trackingRef: optText(100),
  orderRef: optText(100),
  isConsumption: v.boolean().optional(),
});

const PartySchema = v.object({
  name: optText(200),
  address: optText(1000),
  stateCode,
  gstin: optText(15),
  registrationType: v.enum(REGISTRATION_TYPES).optional(),
  pincode: optText(10),
});

const ConsigneeSchema = v.object({
  name: optText(200),
  address: optText(1000),
  stateCode,
  gstin: optText(15),
  pincode: optText(10),
});

const DispatchSchema = v.object({
  docNo: optText(50),
  through: optText(100),
  destination: optText(100),
  vehicleNo: optText(20),
  transporterId: optText(20),
  transporterName: optText(100),
  mode: optText(20),
  distanceKm: v.number({ min: 0, max: 10_000 }).optional(),
  lrNo: optText(50),
  lrDate: v.date().optional(),
});

const OrderDetailsSchema = v.object({
  orderNo: optText(50),
  orderDate: v.date().optional(),
  terms: optText(2000),
  otherRefs: optText(200),
  buyersOrderNo: optText(50),
  deliveryNoteNo: optText(50),
});

const ExportDetailsSchema = v.object({
  shippingBillNo: optText(50),
  shippingBillDate: v.date().optional(),
  portCode: optText(10),
  withPayment: v.boolean().optional(),
  currency: optText(3),
  exchangeRate: v.number({ min: 0 }).optional(),
});

export const VoucherInputSchema = v.object({
  id: v.id().optional(),
  voucherTypeId: v.id(),
  date: v.date(),
  effectiveDate: v.date().optional(),
  number: optText(50),
  referenceNo: optText(50),
  referenceDate: v.date().optional(),
  narration: optText(4000),
  isOptional: v.boolean().optional(),
  isPostDated: v.boolean().optional(),
  mode: v.enum(VOUCHER_MODES),
  partyLedgerId: v.id().optional(),
  party: PartySchema.optional(),
  consignee: ConsigneeSchema.optional(),
  dispatch: DispatchSchema.optional(),
  orderDetails: OrderDetailsSchema.optional(),
  exportDetails: ExportDetailsSchema.optional(),
  placeOfSupply: v.string({ pattern: /^(\d{2})?$/, patternMessage: 'Place of supply must be a two-digit state code' }).optional(),
  reverseCharge: v.boolean().optional(),
  priceLevelId: v.id().optional(),
  originalInvoiceNo: optText(50),
  originalInvoiceDate: v.date().optional(),
  noteReason: optText(200),
  partyBillAllocations: v.array(BillAllocationSchema, { max: 1000 }).optional(),
  items: v.array(ItemLineSchema, { max: 5000 }).optional(),
  ledgers: v.array(LedgerLineSchema, { max: 2000 }).optional(),
  acknowledgeWarnings: v.boolean().optional(),
  expectedUpdatedAt: optText(40),
}) as unknown as Schema<VoucherInput>;

const ListSchema = v.object({
  from: v.date(),
  to: v.date(),
  voucherTypeIds: v.array(v.id(), { max: 200 }).optional(),
  baseTypes: v.array(v.enum(VOUCHER_BASE_TYPES), { max: 50 }).optional(),
  partyLedgerId: v.id().optional(),
  ledgerId: v.id().optional(),
  search: optText(100),
  includeOptional: v.boolean().optional(),
  includeCancelled: v.boolean().optional(),
  onlyPostDated: v.boolean().optional(),
  sort: v.enum(['date_asc', 'date_desc'] as const).optional(),
  limit: v.int({ min: 1, max: MAX_LIST_LIMIT }).optional(),
  offset: v.int({ min: 0 }).optional(),
}) as unknown as Schema<VoucherListInput>;

const TRACKING_KINDS: readonly TrackingKind[] = ['delivery', 'receipt', 'sales_order', 'purchase_order'];

export const vouchersRoutes = {
  'vouchers.entryContext': companyRoute({
    access: 'vouchers.view',
    input: v.object({ voucherTypeId: v.id(), date: v.date() }),
    handler: (ctx, input) => entryContext(ctx, input.voucherTypeId, input.date),
  }),
  'vouchers.partyContext': companyRoute({
    access: 'vouchers.view',
    input: v.object({ ledgerId: v.id(), date: v.date(), excludeVoucherId: v.id().optional() }),
    handler: (ctx, input) => partyContext(ctx, input.ledgerId, input.date, input.excludeVoucherId),
  }),
  'vouchers.pendingBills': companyRoute({
    access: 'vouchers.view',
    input: v.object({ ledgerId: v.id(), asOf: v.date(), excludeVoucherId: v.id().optional() }),
    handler: (ctx, input) => pendingBills(ctx.db, input.ledgerId, input.asOf, ctx.clock.today(), input.excludeVoucherId),
  }),
  'vouchers.preview': companyRoute({
    access: 'vouchers.view',
    input: VoucherInputSchema,
    handler: (ctx, input) => previewVoucher(ctx, input),
  }),
  // Create needs vouchers.create, alter needs vouchers.alter (+ vouchers.backdate before today): checked in
  // saveVoucher, so a custom role that may alter but not create can still alter.
  'vouchers.save': companyRoute({
    access: 'vouchers.view',
    input: VoucherInputSchema,
    handler: (ctx, input) => saveVoucher(ctx, input),
  }),
  'vouchers.get': companyRoute({
    access: 'vouchers.view',
    input: v.object({ id: v.id() }),
    handler: (ctx, input) => getVoucher(ctx.db, input.id),
  }),
  'vouchers.list': companyRoute({
    access: 'vouchers.view',
    input: ListSchema,
    transactional: false,
    handler: (ctx, input) => listVouchers(ctx.db, input),
  }),
  'vouchers.delete': companyRoute({
    access: 'vouchers.delete',
    input: v.object({ id: v.id(), reason: optText(500), expectedUpdatedAt: optText(40) }),
    handler: (ctx, input) => deleteVoucher(ctx, input.id, input.reason, input.expectedUpdatedAt),
  }),
  'vouchers.cancel': companyRoute({
    access: 'vouchers.alter',
    input: v.object({ id: v.id(), reason: v.string({ min: 1, max: 500 }), expectedUpdatedAt: optText(40) }),
    handler: (ctx, input) => cancelVoucher(ctx, input.id, input.reason, input.expectedUpdatedAt),
  }),
  'vouchers.duplicate': companyRoute({
    access: 'vouchers.view',
    input: v.object({ id: v.id() }),
    handler: (ctx, input) => duplicateVoucher(ctx, input.id),
  }),
  'vouchers.nextNumber': companyRoute({
    access: 'vouchers.view',
    input: v.object({ voucherTypeId: v.id(), date: v.date() }),
    handler: (ctx, input) => nextVoucherNumber(ctx, input.voucherTypeId, input.date),
  }),
  'vouchers.setOptional': companyRoute({
    access: 'vouchers.alter',
    input: v.object({ id: v.id(), optional: v.boolean(), acknowledgeWarnings: v.boolean().optional(), expectedUpdatedAt: optText(40) }),
    handler: (ctx, input) => setVoucherOptional(ctx, input.id, input.optional, input.acknowledgeWarnings === true, input.expectedUpdatedAt),
  }),
  'vouchers.trackingRefs': companyRoute({
    access: 'vouchers.view',
    input: v.object({ partyLedgerId: v.id(), kind: v.enum(TRACKING_KINDS), excludeVoucherId: v.id().optional() }),
    handler: (ctx, input) => trackingRefs(ctx.db, input.partyLedgerId, input.kind, input.excludeVoucherId),
  }),
} satisfies RouteMap;
