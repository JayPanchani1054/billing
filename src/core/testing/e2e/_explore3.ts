import { startRuntime, sum, P } from './harness.ts';
import { createCompany, createMasters, post } from './scenario.ts';
import { makeGstin, testPan } from '../fixtures.ts';
const e = startRuntime('2026-06-30');
const j = (x: unknown) => JSON.stringify(x);
const FY = { from: '2026-04-01', to: '2026-06-30' };
try {
const w = await createCompany(e);
await createMasters(w);
const L = w.L, I = w.I, VT = w.VT;
const mk = async (key: string, input: any) => { const d: any = await e.call('accounts.ledger.save', input); L[key] = d.id; };
await mk('freightOut', { name: 'Freight Outward Recovered', groupId: w.G.INDIRECT_INCOMES, gstApplicable: true, gstRate: 18, hsnSac: '996511', gstSupplyType: 'services' });
await mk('discount', { name: 'Trade Discount Allowed', groupId: w.G.INDIRECT_EXPENSES });
await mk('consulting', { name: 'Consulting Income', groupId: w.G.SALES_ACCOUNTS, gstApplicable: true, gstRate: 18, hsnSac: '998311', gstSupplyType: 'services' });
await mk('unregSupp', { name: 'Local Unregistered Vendor', groupId: w.G.SUNDRY_CREDITORS, registrationType: 'unregistered', stateCode: '27' });
await mk('importer', { name: 'Shenzhen Electric Co', groupId: w.G.SUNDRY_CREDITORS, registrationType: 'overseas', country: 'China' });
await mk('customs', { name: 'Customs Duty', groupId: w.G.DIRECT_EXPENSES });
const it: any = await e.call('inventory.item.save', { name: 'Fresh Vegetables', unitId: 3, gstApplicable: true, hsnSac: '0702', taxability: 'nil_rated', openings: [{ godownId: 1, qty: 100, rate: 30 }] });
I.veg = it.item.id;
const res: any[] = [];
// A: sale with freight (GST) + discount (non-GST) + round off
res.push(await post(w, 'A', { voucherTypeId: VT.sales, date: '2026-04-10', mode: 'item_invoice', partyLedgerId: L.mumbai, items: [{ itemId: I.utensil, qty: 3, rate: 777.77 }], ledgers: [{ ledgerId: L.freightOut, amount: P(333.33) }, { ledgerId: L.discount, amount: -P(100) }] }));
// B: outward debit note to customer (price revision)
const s1 = await post(w, 'S1', { voucherTypeId: VT.sales, date: '2026-04-11', mode: 'item_invoice', partyLedgerId: L.blr, items: [{ itemId: I.mixer, qty: 2, rate: 3000 }] });
res.push(await post(w, 'B', { voucherTypeId: VT.debit_note, date: '2026-04-20', mode: 'item_invoice', partyLedgerId: L.blr, items: [{ itemId: I.mixer, qty: 2, rate: 100 }], originalInvoiceNo: s1.number!, originalInvoiceDate: '2026-04-11', noteReason: 'Price revision' }).catch((x:any)=>({err: String(x).slice(0,400)})));
// C: B2CL invoice + credit note
const b2cl = await post(w, 'B2CL', { voucherTypeId: VT.sales, date: '2026-05-05', mode: 'item_invoice', partyLedgerId: L.delhiCust, items: [{ itemId: I.mixer, qty: 40, rate: 3000 }] });
res.push(await post(w, 'C', { voucherTypeId: VT.credit_note, date: '2026-05-20', mode: 'item_invoice', partyLedgerId: L.delhiCust, items: [{ itemId: I.mixer, qty: 2, rate: 3000 }], originalInvoiceNo: b2cl.number!, originalInvoiceDate: '2026-05-05' }));
// D: services accounting invoice B2B
res.push(await post(w, 'D', { voucherTypeId: VT.sales, date: '2026-05-06', mode: 'accounting_invoice', partyLedgerId: L.blr, ledgers: [{ ledgerId: L.consulting, amount: P(50000) }] }));
// E: nil-rated sale to registered B2B intra + B2C
res.push(await post(w, 'E', { voucherTypeId: VT.sales, date: '2026-05-07', mode: 'item_invoice', partyLedgerId: L.mumbai, items: [{ itemId: I.veg, qty: 10, rate: 40 }] }));
// F: unregistered purchase
res.push(await post(w, 'F', { voucherTypeId: VT.purchase, date: '2026-05-08', mode: 'item_invoice', partyLedgerId: L.unregSupp, items: [{ itemId: I.utensil, qty: 2, rate: 400 }], referenceNo: 'LV-1' }));
// G: import of goods
res.push(await post(w, 'G', { voucherTypeId: VT.purchase, date: '2026-06-02', mode: 'item_invoice', partyLedgerId: L.importer, items: [{ itemId: I.mixer, qty: 10, rate: 2000 }], referenceNo: 'SZ-88' }));
// H: export CN (sales return on LUT export)
const ex = await post(w, 'EX', { voucherTypeId: VT.sales, date: '2026-06-05', mode: 'item_invoice', partyLedgerId: L.dubai, items: [{ itemId: I.rice, qty: 10, rate: 2000 }], exportDetails: { shippingBillNo: '1', shippingBillDate: '2026-06-06', portCode: 'INNSA1' } });
res.push(await post(w, 'H', { voucherTypeId: VT.credit_note, date: '2026-06-15', mode: 'item_invoice', partyLedgerId: L.dubai, items: [{ itemId: I.rice, qty: 1, rate: 2000 }], originalInvoiceNo: ex.number!, originalInvoiceDate: '2026-06-05' }));
// I: cash sale CN (B2CS netting)
const cs = await post(w, 'CS', { voucherTypeId: VT.sales, date: '2026-06-10', mode: 'item_invoice', partyLedgerId: L.CASH, items: [{ itemId: I.utensil, qty: 2, rate: 800 }] });
res.push(await post(w, 'I', { voucherTypeId: VT.credit_note, date: '2026-06-12', mode: 'item_invoice', partyLedgerId: L.CASH, items: [{ itemId: I.utensil, qty: 1, rate: 800 }], originalInvoiceNo: cs.number!, originalInvoiceDate: '2026-06-10' }).catch((x:any)=>({err: String(x).slice(0,400)})));
for (const r of res) console.log(j(r).slice(0, 300));
const tb: any = await e.call('reports.trialBalance', { ...FY, mode: 'ledgers' });
const cl = (k: string) => tb.rows.find((r: any) => r.key === `l:${L[k]}`)?.closing ?? 0;
const g1: any = await e.call('gst.gstr1.summary', FY);
for (const s of g1.sections) if (s.count) console.log('g1', s.id, s.count, s.taxable, s.igst, s.cgst, s.sgst, s.invoiceValue);
console.log('g1 totals', j(g1.totals), j(g1.nil), j(g1.b2cs), j(g1.issues.map((i:any)=>i.code+':'+i.message)));
const g3: any = await e.call('gst.gstr3b.summary', FY);
console.log('3b', j(g3.supplies.map((s:any)=>[s.key,s.taxable,s.igst,s.cgst,s.sgst])), j(g3.itc.available.map((s:any)=>[s.ty,s.igst,s.cgst,s.sgst])), j(g3.itc.net), j(g3.inward), j(g3.interState));
console.log('ledgers out', cl('OUTPUT_IGST'), cl('OUTPUT_CGST'), cl('OUTPUT_SGST'), 'in', cl('INPUT_IGST'), cl('INPUT_CGST'), cl('INPUT_SGST'), 'rcm', cl('RCM_IGST'), cl('RCM_CGST'), 'roundoff', cl('ROUND_OFF'), 'freight', cl('freightOut'), 'disc', cl('discount'));
const g9: any = await e.call('gst.gstr9.summary', { fy: '2026-27' });
console.log('g9 t4', j(g9.table4.map((r:any)=>[r.key,r.taxable,r.igst,r.cgst])), 't5', j(g9.table5.map((r:any)=>[r.key,r.taxable])), 't6', j(g9.table6.map((r:any)=>[r.key,r.igst,r.cgst])));
const d: any = await e.call('dashboard.summary', { asOf: '2026-06-30', ...FY });
console.log('dash gst', j(d.gst));
} finally { await e.close(); }
