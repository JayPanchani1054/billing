/**
 * Contract test: the voucher screen's pure model driven against the REAL posting engine on an
 * in-memory company (src/core/modules/vouchers testkit: a Maharashtra GST trader).
 *
 *  - client live totals (computeInvoiceTotals on masters shaped exactly as the pickers deliver them)
 *    equal the server's preview, to the paisa;
 *  - what the form sends is accepted, and an alteration round-trips: vouchers.get().input → form →
 *    VoucherInput is the saved input, and saving it again changes nothing in the books;
 *  - server field errors and warnings land on the right grid cells, and the warnings protocol asks
 *    only about `confirm` warnings.
 *
 * Test-only: this file imports core services at runtime. Renderer source files never do (they use
 * `import type` from src/core and talk to main over the API bridge).
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { AppError } from '../../../../core/lib/errors.ts';
import { getLedger } from '../../../../core/modules/accounts/ledgers.ts';
import { itemPicker } from '../../../../core/modules/inventory/items.ts';
import { entryContext, getVoucher, partyContext } from '../../../../core/modules/vouchers/queries.ts';
import { previewVoucher, saveVoucher } from '../../../../core/modules/vouchers/service.ts';
import { entryMap, setupKit } from '../../../../core/modules/vouchers/testkit.ts';
import type { VoucherBaseType } from '../../../../shared/constants.ts';
import type { VoucherInput } from '../../../../shared/types/vouchers.ts';
import { ACCOUNT_ROW, buildVoucherInput, formFromInput } from './buildInput.ts';
import { cellId, confirmationRequest, headerId, mapFieldErrors, warningsByRow } from './errorPaths.ts';
import { formReducer, isBlankItem, isBlankLedger, newForm } from './formState.ts';
import type { ItemRow, LedgerRow, VoucherForm } from './formState.ts';
import { defaultDirection } from './kinds.ts';
import { toClientItemInfo, toClientLedgerTax } from './masters.ts';
import { computeInvoiceTotals } from './totals.ts';
import type { ClientLedgerTax, TotalsEnv } from './totals.ts';

const k = setupKit();
after(() => k.t.close());
const { t, L, I, vt } = k;
const DATE = '2026-04-15';

/** The env the entry screen builds from entryContext + partyContext + the picker / ledger masters. */
function envFor(baseType: VoucherBaseType, partyId: number | null, date = DATE): TotalsEnv {
  const ctx = entryContext(t.ctx, vt[baseType], date);
  const party = partyId === null ? null : partyContext(t.ctx, partyId, date);
  const items = new Map(itemPicker(t.db, { asOf: date }, t.today).map((r) => [r.id, toClientItemInfo(r)]));
  const ledgerCache = new Map<number, ClientLedgerTax>();
  const env: TotalsEnv = {
    direction: party?.gstDirection ?? defaultDirection(baseType),
    gstOn: ctx.company.gstEnabled,
    companyStateCode: ctx.company.stateCode ?? '',
    companyRegistration: ctx.company.gstRegistrationType,
    party: party ? { registrationType: party.registrationType, stateCode: party.stateCode, gstin: party.gstin } : null,
    roundOff: ctx.config.roundOff,
    items,
    ledgerTax: (id) => {
      if (!ledgerCache.has(id)) ledgerCache.set(id, toClientLedgerTax(getLedger(t.db, id, t.today)));
      return ledgerCache.get(id);
    },
    defaultLedgerId: ctx.defaultLedgerId,
  };
  if (ctx.config.gst.b2clThresholdPaise !== 1_00_000_00) env.b2clThresholdPaise = ctx.config.gst.b2clThresholdPaise;
  return env;
}

/** Fill the trailing blank item row / ledger row, the way the grid does. */
function addItem(f: VoucherForm, patch: Partial<Omit<ItemRow, 'key'>>): VoucherForm {
  const blank = f.items.filter(isBlankItem).at(-1);
  assert.ok(blank);
  return formReducer(f, { type: 'item', key: blank.key, patch });
}
function addLedger(f: VoucherForm, ledgerId: number, amount: number, extra: Partial<Omit<LedgerRow, 'key'>> = {}): VoucherForm {
  const blank = f.ledgers.filter(isBlankLedger).at(-1);
  assert.ok(blank);
  return formReducer(f, { type: 'ledger', key: blank.key, patch: { ledgerId, amount, ...extra } });
}

function sameTotals(f: VoucherForm, baseType: VoucherBaseType, partyId: number) {
  const client = computeInvoiceTotals(f, envFor(baseType, partyId, f.date));
  const server = previewVoucher(t.ctx, buildVoucherInput(f).input);
  assert.ok(server.computation);
  return { client, server };
}

describe('live totals = the posting engine (vouchers.preview), to the paisa', () => {
  it('intra-state item invoice with an apportioned freight, a non-GST discount and round-off', () => {
    let f = newForm({ voucherTypeId: vt.sales, baseType: 'sales', mode: 'item_invoice', date: DATE, partyLedgerId: L.acme });
    f = addItem(f, { itemId: I.rice, qty: 10, rate: 50 });
    f = addItem(f, { itemId: I.mixer, qty: 3, rate: 150, discountPct: 10 });
    f = addLedger(f, L.freight, 10000);
    f = addLedger(f, L.discount, -2550);
    const { client, server } = sameTotals(f, 'sales', L.acme);
    // Hand check. Goods: rice 10 × ₹50 = ₹500.00; mixer 3 × ₹150 × 0.9 = ₹405.00 → ₹905.00.
    // Freight ₹100 apportioned by value: rice 10000 × 500/905 = 5524.86 → 5525 (largest remainder), mixer 4475.
    // Taxable: rice 55525 @5% → CGST 1388.125 → 1388 + SGST 1388 = 2776; mixer 44975 @18% → 4047.75 → 4048 × 2 = 8096.
    // 100500 + 10872 = 111372; non-GST discount after tax −2550 → 108822; nearest ₹1 → 108800 (round off −22).
    assert.deepEqual(
      { taxable: client.taxable, tax: client.tax, roundOff: client.roundOff, grandTotal: client.grandTotal },
      { taxable: 100500, tax: 10872, roundOff: -22, grandTotal: 108800 },
    );
    assert.equal(client.taxable, server.totals.taxable);
    assert.equal(client.tax, server.totals.tax);
    assert.equal(client.roundOff, server.totals.roundOff);
    assert.equal(client.grandTotal, server.totals.grandTotal);
    assert.equal(client.computation?.nature, server.gstNature);
    assert.equal(client.computation?.interState, false);
  });

  it('inter-state accounting invoice with a GST service line and a rate / HSN override', () => {
    let f = newForm({ voucherTypeId: vt.sales, baseType: 'sales', mode: 'accounting_invoice', date: DATE, partyLedgerId: L.blr });
    f = addLedger(f, L.consult, 250000);
    f = addLedger(f, L.rent, 33333, { gstRate: 12, hsnSac: '997212' });
    const { client, server } = sameTotals(f, 'sales', L.blr);
    assert.equal(client.computation?.interState, true);
    assert.equal(client.taxable, server.totals.taxable);
    assert.equal(client.tax, server.totals.tax);
    assert.equal(client.grandTotal, server.totals.grandTotal);
  });

  it('a purchase with an item and a GST service charge', () => {
    let f = newForm({ voucherTypeId: vt.purchase, baseType: 'purchase', mode: 'item_invoice', date: DATE, partyLedgerId: L.supplier });
    f = formReducer(f, { type: 'patch', patch: { referenceNo: 'SS/101', referenceDate: DATE } });
    f = addItem(f, { itemId: I.mixer, qty: 7, rate: 133.33 });
    f = addLedger(f, L.gtaFreight, 45050);
    const { client, server } = sameTotals(f, 'purchase', L.supplier);
    assert.equal(client.taxable, server.totals.taxable);
    assert.equal(client.tax, server.totals.tax);
    assert.equal(client.grandTotal, server.totals.grandTotal);
  });
});

// ───────────────────────────── Alteration round trip ─────────────────────────────

/** Save the form, read it back as the alteration screen does, rebuild the input from the form. */
function roundTrip(f: VoucherForm, baseType: VoucherBaseType) {
  const built = buildVoucherInput(f);
  const saved = saveVoucher(t.ctx, { ...built.input, acknowledgeWarnings: true });
  const detail = getVoucher(t.db, saved.id);
  const form = formFromInput(detail.input, { baseType, alter: true });
  const again = buildVoucherInput(form).input;
  return { saved, detail, form, again };
}

const strip = (i: VoucherInput): VoucherInput => JSON.parse(JSON.stringify(i)) as VoucherInput;

describe('alteration: vouchers.get().input → form → VoucherInput is the saved voucher', () => {
  it('item invoice: billed qty, alt qty, discount, description and an additional ledger with a GST override', () => {
    let f = newForm({ voucherTypeId: vt.sales, baseType: 'sales', mode: 'item_invoice', date: DATE, partyLedgerId: L.acme });
    f = addItem(f, { itemId: I.rice, qty: 4, billedQty: 3, altQty: 2, rate: 52.5, discountPct: 5, description: 'Basmati' });
    f = addLedger(f, L.freight, 15000);
    // An additional ledger the grid shows without GST columns, carrying an override (e.g. from a Tally import).
    f = addLedger(f, L.rent, 20000, { gstRate: 18, hsnSac: '997212' });
    f = formReducer(f, { type: 'patch', patch: { narration: 'Round trip', referenceNo: 'PO-77' } });
    // The override takes part in the live totals in item mode too, exactly as on the server.
    const { client, server } = sameTotals(f, 'sales', L.acme);
    assert.equal(client.tax, server.totals.tax);
    assert.equal(client.grandTotal, server.totals.grandTotal);

    const { saved, detail, form, again } = roundTrip(f, 'sales');
    assert.equal(form.id, saved.id);
    assert.equal(form.expectedUpdatedAt, detail.updatedAt);
    assert.deepEqual(strip(again), strip(detail.input));
    assert.deepEqual(again.ledgers?.[1], { ledgerId: L.rent, amount: 20000, gst: { rate: 18, hsnSac: '997212' } });
    // Saving the untouched alteration changes nothing in the books.
    const before = entryMap(k, saved.id);
    const out = saveVoucher(t.ctx, { ...again, acknowledgeWarnings: true });
    assert.equal(out.id, saved.id);
    assert.deepEqual(entryMap(k, saved.id), before);
  });

  it('accounting invoice line keeps GST override fields the grid has no column for (cess, taxability)', () => {
    const input: VoucherInput = {
      voucherTypeId: vt.sales,
      date: DATE,
      mode: 'accounting_invoice',
      partyLedgerId: L.acme,
      ledgers: [{ ledgerId: L.consult, amount: 100000, gst: { rate: 28, cessRate: 12, hsnSac: '998311' } }],
    };
    const saved = saveVoucher(t.ctx, { ...input, acknowledgeWarnings: true });
    const detail = getVoucher(t.db, saved.id);
    const form = formFromInput(detail.input, { baseType: 'sales', alter: true });
    const row = form.ledgers.find((r) => !isBlankLedger(r));
    assert.deepEqual([row?.gstRate, row?.hsnSac, row?.gstExtra], [28, '998311', { cessRate: 12 }]);
    const again = buildVoucherInput(form).input;
    assert.deepEqual(again.ledgers, [{ ledgerId: L.consult, amount: 100000, gst: { cessRate: 12, rate: 28, hsnSac: '998311' } }]);
    // The live totals use the cess too: ₹1,000 @28% = 280.00 + cess 12% = 120.00 → ₹1,400.00.
    const client = computeInvoiceTotals(form, envFor('sales', L.acme));
    assert.equal(client.tax, 40000);
    assert.equal(client.grandTotal, detail.totals.amount);
  });

  it('single-entry payment with bank details and a bill-wise line opens single and round-trips', () => {
    let f = newForm({ voucherTypeId: vt.payment, baseType: 'payment', mode: 'ledger', date: DATE, accountLedgerId: L.bank });
    f = formReducer(f, { type: 'patch', patch: { accountInstrument: { type: 'cheque', number: '000451', date: DATE } } });
    f = addLedger(f, L.supplier, 500000, { bills: [{ refType: 'on_account', amount: 500000 }] });
    f = addLedger(f, L.rent, 120000, { narration: 'April rent' });
    const { detail, form, again } = roundTrip(f, 'payment');
    assert.equal(form.layout, 'single');
    assert.equal(form.accountLedgerId, L.bank);
    assert.deepEqual(strip(again), strip(detail.input));
    // Account Cr ₹6,200 = Dr 5,000 + 1,200.
    assert.deepEqual(again.ledgers?.map((l) => [l.ledgerId, l.amount]), [
      [L.bank, -620000],
      [L.supplier, 500000],
      [L.rent, 120000],
    ]);
  });

  it('a payment whose bank line carries a narration stays in Dr/Cr so the narration is not lost', () => {
    const input: VoucherInput = {
      voucherTypeId: vt.payment,
      date: DATE,
      mode: 'ledger',
      ledgers: [
        { ledgerId: L.rent, amount: 90000 },
        { ledgerId: L.bank, amount: -90000, narration: 'NEFT ref 8812' },
      ],
    };
    const saved = saveVoucher(t.ctx, { ...input, acknowledgeWarnings: true });
    const detail = getVoucher(t.db, saved.id);
    const form = formFromInput(detail.input, { baseType: 'payment', alter: true });
    assert.equal(form.layout, 'double');
    assert.deepEqual(strip(buildVoucherInput(form).input), strip(detail.input));
  });

  it('stock journal: source then destination, both round-trip', () => {
    let f = newForm({ voucherTypeId: vt.stock_journal, baseType: 'stock_journal', mode: 'inventory', date: DATE });
    const src = f.items.find((r) => r.isConsumption && isBlankItem(r));
    assert.ok(src);
    f = formReducer(f, { type: 'item', key: src.key, patch: { itemId: I.rice, qty: 5, rate: 50 } });
    const dst = f.items.find((r) => !r.isConsumption && isBlankItem(r));
    assert.ok(dst);
    f = formReducer(f, { type: 'item', key: dst.key, patch: { itemId: I.mixer, qty: 1, rate: 250 } });
    const { detail, again } = roundTrip(f, 'stock_journal');
    assert.deepEqual(strip(again), strip(detail.input));
    assert.deepEqual(detail.inventory.map((l) => [l.itemId, l.qty]), [
      [I.rice, -5],
      [I.mixer, 1],
    ]);
  });
});

// ───────────────────────────── Errors and warnings on screen ─────────────────────────────

describe('server errors and warnings are placed on the right cells', () => {
  it('a GST tax ledger as an invoice line: VALIDATION on ledgers[i].ledgerId → that row’s ledger cell', () => {
    let f = newForm({ voucherTypeId: vt.sales, baseType: 'sales', mode: 'item_invoice', date: DATE, partyLedgerId: L.acme });
    f = addItem(f, { itemId: I.rice, qty: 1, rate: 50 });
    f = addLedger(f, L.freight, 1000);
    f = addLedger(f, L.OUTPUT_CGST, 500);
    const built = buildVoucherInput(f);
    const err = (() => {
      try {
        saveVoucher(t.ctx, { ...built.input, acknowledgeWarnings: true });
      } catch (e) {
        return e;
      }
      return null;
    })();
    assert.ok(err instanceof AppError);
    assert.equal(err.code, 'VALIDATION');
    const issues = err.details as Array<{ path: string; message: string }>;
    const mapped = mapFieldErrors(Object.fromEntries(issues.map((i) => [i.path, i.message])), built);
    const taxRow = f.ledgers.filter((r) => !isBlankLedger(r))[1];
    assert.equal(mapped.first?.id, cellId('ledgers', taxRow.key, 'ledger'));
    assert.match(mapped.cells[cellId('ledgers', taxRow.key, 'ledger')], /GST tax ledger/);
  });

  it('missing party: VALIDATION on partyLedgerId → the party field', () => {
    let f = newForm({ voucherTypeId: vt.sales, baseType: 'sales', mode: 'item_invoice', date: DATE });
    f = addItem(f, { itemId: I.rice, qty: 1, rate: 50 });
    const built = buildVoucherInput(f);
    try {
      previewVoucher(t.ctx, built.input);
      assert.fail('expected a VALIDATION error');
    } catch (e) {
      assert.ok(e instanceof AppError && e.code === 'VALIDATION');
      const issues = e.details as Array<{ path: string; message: string }>;
      assert.equal(mapFieldErrors(Object.fromEntries(issues.map((i) => [i.path, i.message])), built).first?.id, headerId('party'));
    }
  });

  it('warnings protocol: only confirm warnings are asked about; line warnings mark their row', () => {
    let f = newForm({ voucherTypeId: vt.sales, baseType: 'sales', mode: 'item_invoice', date: DATE, partyLedgerId: L.acme });
    f = addItem(f, { itemId: I.rice, qty: 1, rate: 50 });
    f = addItem(f, { itemId: I.noRate, qty: 1, rate: 10 }); // no GST rate anywhere → gst_missing_rate (confirm) on items[1]
    const built = buildVoucherInput(f);
    try {
      saveVoucher(t.ctx, built.input);
      assert.fail('expected a confirmation request');
    } catch (e) {
      assert.ok(e instanceof AppError && e.code === 'BUSINESS_RULE');
      const req = confirmationRequest(e.details);
      assert.ok(req);
      assert.ok(req.confirm.some((m) => /no GST rate/.test(m)));
      for (const w of req.info) assert.ok(!req.confirm.includes(w.message), 'info warnings are never asked about');
      const byRow = warningsByRow(req.all, built);
      const noRateRow = f.items.filter((r) => !isBlankItem(r))[1];
      assert.ok(byRow.rows[noRateRow.key]?.some((w) => w.code === 'gst_missing_rate'));
    }
    // Accepting the warnings saves it.
    const out = saveVoucher(t.ctx, { ...built.input, acknowledgeWarnings: true });
    assert.ok(out.id > 0);
  });

  it('single-entry Account line errors point at the Account field', () => {
    let f = newForm({ voucherTypeId: vt.payment, baseType: 'payment', mode: 'ledger', date: DATE, accountLedgerId: L.cash });
    f = addLedger(f, L.rent, 1000);
    const built = buildVoucherInput(f);
    assert.equal(built.ledgerKeys[0], ACCOUNT_ROW);
    assert.equal(mapFieldErrors({ 'ledgers[0].ledgerId': 'x' }, built).first?.id, headerId('account'));
  });
});
