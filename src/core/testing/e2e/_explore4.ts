import { startRuntime, sum, P } from './harness.ts';
import { createCompany, createMasters, postYear, alterAndDelete, bankQuarter } from './scenario.ts';
const e = startRuntime('2027-03-31');
const j = (x: unknown) => JSON.stringify(x);
try {
const w = await createCompany(e);
await createMasters(w);
await postYear(w);
await alterAndDelete(w);
await bankQuarter(w);
const Q = [['2026-04-01','2026-06-30'],['2026-07-01','2026-09-30'],['2026-10-01','2026-12-31'],['2027-01-01','2027-03-31']];
let np = 0, prevClose: number | null = null;
for (const [from, to] of Q) {
  const pl: any = await e.call('reports.profitLoss', { from, to });
  const ss: any = await e.call('stock.summary', { from, to });
  const bs: any = await e.call('reports.balanceSheet', { asOf: to });
  console.log(from, to, 'PL open', pl.figures.openingStock, 'close', pl.figures.closingStock, 'SS open', ss.totals.openingValue, 'close', ss.totals.closingValue, 'BS stock', bs.closingStock, 'prevClose', prevClose, 'np', pl.figures.netProfit, 'bs cur', bs.profitLoss.currentPeriod);
  np += pl.figures.netProfit; prevClose = pl.figures.closingStock;
}
const y: any = await e.call('reports.profitLoss', { from: '2026-04-01', to: '2027-03-31' });
console.log('Σ quarters', np, 'year', y.figures.netProfit);
// monthly
let npm = 0;
for (let m = 0; m < 12; m++) {
  const from = `${['2026-04','2026-05','2026-06','2026-07','2026-08','2026-09','2026-10','2026-11','2026-12','2027-01','2027-02','2027-03'][m]}-01`;
  const d = new Date(Date.UTC(+from.slice(0,4), +from.slice(5,7), 0)).toISOString().slice(0,10);
  const pl: any = await e.call('reports.profitLoss', { from, to: d });
  npm += pl.figures.netProfit;
}
console.log('Σ months', npm);
const val1: any = await e.call('inventory.valuation', { from: '2026-04-01', to: '2026-06-30' });
const val2: any = await e.call('inventory.valuation', { from: '2026-06-30', to: '2026-06-30' });
const val3: any = await e.call('inventory.valuation', { from: '2026-01-01', to: '2026-06-30' }).catch((x:any)=>String(x));
console.log('valuation Jun30 by from', val1.totals.closingValue, val2.totals.closingValue, j(val3.totals ?? val3).slice(0,200));
} finally { await e.close(); }
