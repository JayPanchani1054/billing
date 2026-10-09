import { startRuntime, sum, P } from './harness.ts';
import { createCompany, createMasters, post } from './scenario.ts';
const e = startRuntime('2026-06-30');
const j = (x: unknown) => JSON.stringify(x);
try {
const w = await createCompany(e);
await createMasters(w);
await e.call('company.features.save', { einvoice: true, ewayBill: true });
const L = w.L, I = w.I, VT = w.VT;
const mk = async (key: string, input: any) => { const d: any = await e.call('accounts.ledger.save', input); L[key] = d.id; };
await mk('freightOut', { name: 'Freight Outward Recovered', groupId: w.G.INDIRECT_INCOMES, gstApplicable: true, gstRate: 18, hsnSac: '996511', gstSupplyType: 'services' });
await mk('discount', { name: 'Trade Discount Allowed', groupId: w.G.INDIRECT_EXPENSES });
await mk('tcs', { name: 'TCS Collected', groupId: w.G.DUTIES_TAXES, taxType: 'TCS' }).catch(x=>console.log(String(x).slice(0,200)));
const A = await post(w, 'A', { voucherTypeId: VT.sales, date: '2026-06-10', mode: 'item_invoice', partyLedgerId: L.mumbai, items: [{ itemId: I.utensil, qty: 30, rate: 1777.77, discountPct: 5 }], ledgers: [{ ledgerId: L.freightOut, amount: P(333.33) }, { ledgerId: L.discount, amount: -P(100) }],
  dispatch: { vehicleNo: 'MH12AB1234', distanceKm: 150, mode: 'road', transporterName: 'Speedy' } });
const v: any = await e.call('vouchers.get', { id: A.id });
console.log('voucher totals', j(A.totals), 'entries', j(v.entries.map((x:any)=>[x.ledgerName,x.amount])));
const pd: any = await e.call('print.voucherData', { id: A.id });
console.log('print totals', j(pd.totals), pd.amountInWords, '|', pd.taxInWords, j(pd.taxByRate), j(pd.charges), j(pd.warnings));
const ej: any = await e.call('gst.einvoice.json', { voucherIds: [A.id] });
const doc = ej.json[0];
console.log('einv', j(doc?.ValDtls), j(doc?.ItemList?.map((i:any)=>[i.PrdDesc, i.Qty, i.UnitPrice, i.TotAmt, i.Discount, i.AssAmt, i.GstRt, i.CgstAmt, i.TotItemVal])), j(ej.rejected), j(ej.warnings));
const ew: any = await e.raw('gst.ewaybill.json', { voucherIds: [A.id] });
console.log('ewb', j(ew).slice(0, 1500));
// interest
await e.call('accounts.ledger.save', { id: L.mumbai, interestEnabled: true, interestRate: 18 }).catch(x=>console.log('int', String(x).slice(0,300)));
} finally { await e.close(); }
