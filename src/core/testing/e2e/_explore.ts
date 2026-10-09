import { startRuntime, sum } from './harness.ts';
import { createCompany, createMasters, postYear, alterAndDelete, bankQuarter } from './scenario.ts';
const e = startRuntime('2027-03-31');
const FY = { from: '2026-04-01', to: '2027-03-31' };
const j = (x: unknown) => JSON.stringify(x);
try {
const w = await createCompany(e);
await createMasters(w);
await postYear(w);
await alterAndDelete(w);
await bankQuarter(w);
const tb: any = await e.call('reports.trialBalance', { ...FY, mode: 'ledgers' });
const cl = (id: number) => tb.rows.find((r: any) => r.key === `l:${id}`)?.closing ?? 0;
// cash flow
const cf: any = await e.call('reports.cashFlow', FY);
console.log('cashflow', cf.opening, cf.closing, cf.totals, 'cash+bank closing', cl(w.L.CASH) + cl(w.L.bank), 'opening', 5000000+80000000);
console.log('cf months net sum', sum(cf.months, (m: any) => m.net), 'groups net sum', sum(cf.groups, (g: any) => g.net));
const ff: any = await e.call('reports.fundsFlow', FY);
console.log('fundsflow', ff.totalSources, ff.totalApplications, j(ff.workingCapital), ff.difference);
const ra: any = await e.call('reports.ratios', FY);
console.log('ratios', j(ra.principal.map((r: any) => [r.key, r.value])), j(ra.ratios.map((r: any) => [r.key, r.value])));
// registers
for (const bt of ['sales', 'purchase', 'credit_note', 'debit_note']) {
  const rg: any = await e.call('reports.register', { ...FY, baseType: bt });
  console.log('register', bt, j(rg.totals ?? Object.keys(rg)));
}
const gr: any = await e.call('gst.register', { ...FY, kind: 'sales' });
console.log('gst.register sales', j(gr.totals));
const gp: any = await e.call('gst.register', { ...FY, kind: 'purchase' });
console.log('gst.register purchase', j(gp.totals));
const hs: any = await e.call('gst.hsnSummary', { ...FY, direction: 'outward' });
console.log('hsn out', j(hs.totals));
const hi: any = await e.call('gst.hsnSummary', { ...FY, direction: 'inward' });
console.log('hsn in', j(hi.totals), j(hi.rows.map((r:any)=>[r.hsn, r.taxable, r.igst, r.cgst, r.supplyType])));
const itc: any = await e.call('gst.itc', FY);
console.log('itc', j(itc.totals));
const ex: any = await e.call('gst.exceptions', FY);
console.log('gst exceptions', j(ex.counts), j(ex.issues.map((i: any) => i.code + ':' + i.message)).slice(0, 2000));
const pr: any = await e.call('stock.profitability', FY);
console.log('profitability', j(pr.totals ?? Object.keys(pr)));
const gs: any = await e.call('stock.godownSummary', { asOf: FY.to, ...FY });
console.log('godown', j(gs.totals ?? Object.keys(gs)), j((gs.rows ?? gs.godowns ?? []).map((r:any)=>[r.name, r.closing?.value ?? r.value])));
const age: any = await e.call('stock.ageing', { asOf: FY.to });
console.log('stock ageing', j(age.totals ?? Object.keys(age)));
const oa: any = await e.call('outstanding.ageing', { side: 'receivable', asOf: FY.to });
console.log('ageing rec', j(oa.totals ?? Object.keys(oa)));
const d: any = await e.call('dashboard.summary', { asOf: FY.to, ...FY });
console.log('trend', sum(d.trend, (m: any) => m.sales), sum(d.trend, (m: any) => m.purchases), j(d.topCustomers.map((c:any)=>[c.name,c.amount])), j(d.topItems.map((c:any)=>[c.name,c.qty,c.amount])));
const ex2: any = await e.call('reports.exceptions', FY);
console.log('report exceptions', j(ex2).slice(0, 1500));
const ms: any = await e.call('reports.monthlySummary', { ...FY, ledgerId: w.L.SALES });
console.log('monthly sales', j(ms).slice(0, 600));
const st: any = await e.call('reports.statistics', FY);
console.log('stats', j(st).slice(0, 1500));
} finally { await e.close(); }
