/**
 * Test scenario of the mfg module (used by *.test.ts only). Company: GST, Maharashtra (27), books from
 * 01-Apr-2025, working date 30-Jun-2026, with Manufacturing, Job work and Multiple godowns on.
 *
 *   items      Steel Sheet  Kg   Average Cost  opening 100 kg @ ₹50   (₹5,000.00)
 *              Paint        Ltr  FIFO          opening 10 L  @ ₹200   (₹2,000.00)
 *              Chair        Nos  Average Cost  (finished goods, 18%, HSN 9401)
 *              Scrap Metal  Kg   Average Cost
 *              Press Die    Nos  (sent to the job worker as a tool)
 *              Fabric       Mtr  (a principal's material processed by us)
 *   ledgers    Labour Charges (Direct Expenses), Job Work Charges (Direct Expenses)
 *              Ravi Fabricators — job worker, Karnataka GSTIN (inter-state)
 *              Mehta Textiles — principal (Maharashtra)
 *              Supreme Steel — supplier
 *   godowns    Main Location; "Ravi Fabricators (JW)" ours_with_party (party Ravi);
 *              "Mehta Goods" party_with_us (party Mehta)
 */
import type { VoucherInput, VoucherSaveResult } from '../../../shared/types/vouchers.ts';
import { createTestCompany, makeGstin, testPan, type TestCompany } from '../../testing/fixtures.ts';
import { saveGodown } from '../inventory/masters.ts';
import { saveVoucher } from '../vouchers/service.ts';

export interface MfgKit {
  t: TestCompany;
  I: { steel: number; paint: number; chair: number; scrap: number; die: number; fabric: number };
  L: { labour: number; jobCharges: number; ravi: number; mehta: number; supreme: number };
  G: { main: number; ravi: number; mehta: number };
  VT: { manufacturing: number; materialOut: number; materialIn: number; stockJournal: number; purchase: number };
}

export function mfgKit(): MfgKit {
  const t = createTestCompany({
    today: '2026-06-30',
    booksFrom: '2025-04-01',
    features: { manufacturing: true, jobWork: true, multipleGodowns: true },
  });
  const I = {
    steel: t.addStockItem({ name: 'Steel Sheet', unit: 'Kg', gstRate: 18, hsnSac: '7208', openingQty: 100, openingRate: 50 }),
    paint: t.addStockItem({ name: 'Paint', unit: 'Ltr', gstRate: 18, hsnSac: '3208', openingQty: 10, openingRate: 200, costingMethod: 'fifo' }),
    chair: t.addStockItem({ name: 'Chair', gstRate: 18, hsnSac: '9401' }),
    scrap: t.addStockItem({ name: 'Scrap Metal', unit: 'Kg', gstRate: 18, hsnSac: '7204' }),
    die: t.addStockItem({ name: 'Press Die', gstRate: 18, hsnSac: '8207', openingQty: 1, openingRate: 25000 }),
    fabric: t.addStockItem({ name: 'Fabric', unit: 'Mtr', gstRate: 5, hsnSac: '5208' }),
  };
  const L = {
    labour: t.addLedger({ name: 'Labour Charges', group: 'DIRECT_EXPENSES' }),
    jobCharges: t.addLedger({ name: 'Job Work Charges', group: 'DIRECT_EXPENSES' }),
    ravi: t.addLedger({ name: 'Ravi Fabricators', group: 'SUNDRY_CREDITORS', gstin: makeGstin('29', testPan(11)) }),
    mehta: t.addLedger({ name: 'Mehta Textiles', group: 'SUNDRY_DEBTORS', gstin: makeGstin('27', testPan(12)) }),
    supreme: t.addLedger({ name: 'Supreme Steel', group: 'SUNDRY_CREDITORS', gstin: makeGstin('27', testPan(13)) }),
  };
  const G = {
    main: t.ids.mainGodownId,
    ravi: saveGodown(t.ctx, { name: 'Ravi Fabricators (JW)', thirdPartyKind: 'ours_with_party', partyLedgerId: L.ravi }).id,
    mehta: saveGodown(t.ctx, { name: 'Mehta Goods', thirdPartyKind: 'party_with_us', partyLedgerId: L.mehta }).id,
  };
  const vt = (name: string): number => {
    const id = t.db.value<number>('SELECT id FROM voucher_types WHERE name = :name', { name });
    if (id === undefined) throw new Error(`voucher type ${name} missing`);
    return id;
  };
  const VT = {
    manufacturing: vt('Manufacturing Journal'),
    materialOut: vt('Material Out'),
    materialIn: vt('Material In'),
    stockJournal: t.ids.voucherTypes.stock_journal,
    purchase: t.ids.voucherTypes.purchase,
  };
  return { t, I, L, G, VT };
}

export function post(k: Pick<MfgKit, 't'>, input: VoucherInput): VoucherSaveResult {
  return saveVoucher(k.t.ctx, { acknowledgeWarnings: true, ...input });
}

export function purchase(k: MfgKit, date: string, lines: Array<{ itemId: number; qty: number; rate: number; godownId?: number }>, party?: number): VoucherSaveResult {
  return post(k, {
    voucherTypeId: k.VT.purchase,
    date,
    mode: 'item_invoice',
    partyLedgerId: party ?? k.L.supreme,
    referenceNo: `P-${date}-${lines.length}`,
    items: lines,
  });
}
