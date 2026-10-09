import { startRuntime, sum, P } from './harness.ts';
import { createCompany, createMasters, post } from './scenario.ts';
const e = startRuntime('2026-06-30');
const j = (x: unknown) => JSON.stringify(x);
try {
const w = await createCompany(e);
await createMasters(w);
const L = w.L, I = w.I, VT = w.VT;
const s1 = await post(w, 'S1', { voucherTypeId: VT.sales, date: '2026-04-11', mode: 'item_invoice', partyLedgerId: L.blr, items: [{ itemId: I.mixer, qty: 2, rate: 3000 }] });
const before: any = await e.call('inventory.stockOnHand', { itemId: I.mixer, asOf: '2026-06-30' });
const dn = await post(w, 'DN', { voucherTypeId: VT.debit_note, date: '2026-04-20', mode: 'item_invoice', partyLedgerId: L.blr, items: [{ itemId: I.mixer, qty: 2, rate: 100 }], originalInvoiceNo: s1.number!, originalInvoiceDate: '2026-04-11', noteReason: 'Price revision' });
const after: any = await e.call('inventory.stockOnHand', { itemId: I.mixer, asOf: '2026-06-30' });
console.log('mixer stock before DN', before.qty, 'after', after.qty);
const dv: any = await e.call('vouchers.get', { id: dn.id });
console.log('DN entries', j(dv.entries.map((x:any)=>[x.ledgerName,x.amount])), 'inv', j(dv.inventory.map((x:any)=>[x.itemName,x.qty,x.amount])), dv.gstNature);
const pr: any = await e.call('stock.profitability', { from: '2026-04-01', to: '2026-06-30' });
console.log('profitability', j(pr.totals), j(pr.rows?.map((r:any)=>[r.name, r.qty ?? r.soldQty, r.sales ?? r.netSales, r.cost])));
const pl: any = await e.call('reports.profitLoss', { from: '2026-04-01', to: '2026-06-30' });
console.log('PL', j(pl.figures));
const d: any = await e.call('dashboard.summary', { asOf: '2026-06-30', from: '2026-04-01', to: '2026-06-30' });
console.log('top items', j(d.topItems), j(d.topCustomers));
// period lock & banking
await e.call('company.periodLock.set', { date: '2026-04-30' });
const r = await e.raw('vouchers.save', { voucherTypeId: VT.receipt, date: '2026-04-25', mode: 'ledger', ledgers: [{ ledgerId: L.bank, amount: P(100) }, { ledgerId: L.blr, amount: -P(100) }] });
console.log('locked save', j(r).slice(0, 200));
const csv = 'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\r\n20/04/26,CHRG-SMS,,20/04/26,59.00,,799941.00\r\n';
const bytes = new TextEncoder().encode(csv);
const pv: any = await e.call('banking.statement.preview', { ledgerId: L.bank, fileName: 'a.csv', bytes });
const im: any = await e.call('banking.statement.import', { ledgerId: L.bank, fileName: 'a.csv', bytes, mapping: pv.mapping });
const lines: any = await e.call('banking.statement.lines', { ledgerId: L.bank, from: '2026-04-01', to: '2026-06-30' });
const cr = await e.raw('banking.createVoucher', { lineId: lines.rows[0].id, kind: 'payment', contraLedgerId: L.bankCharges });
console.log('createVoucher in locked period', j(cr).slice(0, 300));
const g3 = await e.raw('gst.gstr3b.saveAdjustments', { period: '042026', values: { interest: { cgst: 100 } } });
console.log('3B adj locked', j(g3).slice(0, 200));
const pdel = await e.raw('vouchers.delete', { id: s1.id });
console.log('delete locked', j(pdel).slice(0,200));
const sbd = await e.raw('banking.setBankDates', { entries: [] });
console.log(j(sbd).slice(0,200));
} finally { await e.close(); }
