# mfg — Bill of Materials, Manufacturing Journal, job work (ITC-04), third-party godowns

Closes the Tally-parity gaps "no BOM / manufacturing journal" and "no job work / ITC-04; third-party
godowns valued as own stock". Two F11 features (Inventory group): **Bill of materials and
manufacturing** (`features.manufacturing`) and **Job work** (`features.jobWork`, needs Multiple godowns).

| Side | Files |
|---|---|
| Core | `bom.ts` (BOM master), `journal.ts` (compose a classed stock journal), `hook.ts` (voucher hook), `journalQueries.ts` (entry context, get / duplicate, Production Register), `orders.ts` (Job Work Orders), `jobwork.ts` (FIFO of challans, pending job work, s.143 alerts, ITC-04), `voucherTypes.ts` (classed types), `usage.ts` (item delete check), `schemas.ts`, `routes.ts` |
| Shared | `shared/mfg/costing.ts` (THE costing rule), `shared/mfg/bom.ts` (BOM explosion), `shared/mfg/jobwork.ts` (s.143 / rule 45 rules as effective-dated data), `shared/types/mfg.ts` (DTOs) |
| Schema | `db/migrations/210_mfg.ts` (version 210; block 210–219) |
| Renderer | `renderer/modules/mfg/**` (see its README) |
| Touch points (additive) | `inventory/valuation.ts` (costing basis, principal's stock excluded), `inventory/masters.ts` + `inventory/routes.ts` (godown kind / party), `inventory/items.ts` (delete check), `vouchers/hooks.ts` (hook registration), `accounts/voucherTypes.ts` (`config.stockJournalClass`), `company/service.ts` + `db/seed.ts` (types created on F11), renderer `accounts/VoucherTypeScreens.tsx` ("Use as"), `inventory/Godowns.tsx` ("Whose stock"), `vouchers/entry/VoucherEntryScreen.tsx` (hand-over) |

## Schema (migration 210)

- `godowns.third_party_kind` — `'none'` own premises · `'ours_with_party'` **our** stock at a job worker /
  agent (valued, in the Balance Sheet) · `'party_with_us'` a **principal's** stock with us (quantities
  only: never valued, never in closing stock). Existing `is_third_party = 1` godowns became
  `'ours_with_party'` — exactly how they were valued before, so no figure changes on upgrade.
  `godowns.party_ledger_id` — the job worker / principal.
- `boms`, `bom_lines`, `bom_revisions` — several named BOMs per finished item (one default), lines of kind
  component / by_product / scrap per `output_qty` of the item, default godown per line, by-product value
  basis (`nil`, `rate` ₹/unit, `percent` of the production cost); every save is a numbered revision with a
  JSON snapshot (plus the edit log).
- `stock_journal_details` / `stock_journal_lines` / `stock_journal_costs` — derived rows of a classed
  stock journal, rebuilt in the voucher's save transaction (like `gst_lines`); `details` denormalises
  `date`, `affects_stock`, `is_post_dated`. Lines carry the role, the costing basis and the job work data
  (goods type, challan value, Commissioner's extension).
- `job_work_orders`, `job_work_order_lines` — planning documents (no stock, no books).

## Voucher types and posting

Stock journal voucher types get a class in `voucher_types.config.stockJournalClass`
(`manufacturing` | `material_out` | `material_in`). Turning a feature on (F11, or a new company) creates
**Manufacturing Journal**, **Material Out** (print title "Delivery Challan (Job Work)", CGST rule 55(1)(c))
and **Material In** under the predefined Stock Journal — ordinary types the user may rename, renumber,
deactivate or copy (Masters › Voucher Types › Use as). Each type created from F11 has its own edit-log
`create` entry (`voucher_type`), besides the F11 settings entry. The class is fixed once vouchers of the type exist.

A classed journal is saved through `vouchers.save` / `vouchers.preview` with a `stockJournal` block
(`StockJournalExtInput`: roles, BOM, job work godown, order, process, additional costs). The vouchers
module's hook (`vouchers/hooks.ts`) calls `hook.ts`:

1. **compose** — `journal.ts` validates the block (feature on, roles allowed by the class and the kind of
   the job work godown, one product, components present, BOM of the product, party = the godown's
   party, order of the same party and direction …) and derives the ordinary stock journal item lines
   (consumption = source, production = destination). The vouchers module posts them exactly like any
   stock journal — **no ledger entries** (Tally behaviour: additional costs only add to the value of the
   finished goods; book the expense itself with a Payment / Journal).
2. **adjust** — confirm-level warnings (godown of another party, closed order, by-products worth more than
   the cost, extension date not after the challan).
3. **write / clear** — the derived rows, in the same transaction; cancel / delete / optional / alter keep
   them in step (tests in `journal.test.ts`).

Altering a classed journal **without** its `stockJournal` block (the plain Stock Journal screen, used when
the mfg screen cannot be opened — e.g. the feature was turned off) is refused with a field error on
`stockJournal` that names the screen to use (and, when off, the F11 feature to turn on): saving it as a
plain stock journal would silently drop its production / job work details (final wave, `gaps.test.ts`).
A plain stock journal (no details) is altered on the plain screen as before.

### Costing (one rule, `shared/mfg/costing.ts`)

```
C  = Σ consumed components at the item's costing method, at their place in the stock replay (voucher date)
A  = Σ additional costs (amount, or % of C)
P  = C + A
by-products / scrap: fixed (qty × rate) or percent (P × pct)
finished goods = max(0, P − by-products) split by quantity (largest remainder, exact to the paisa)
transfers to / from a job worker keep their own cost
```

The **stock valuation engine** (`inventory/valuation.ts`) applies this rule while replaying movements, so
the Stock Summary, stock item vouchers, godown summary, P&L / Balance Sheet closing stock and the
Production Register all show the same figures — and a back-dated purchase re-values the finished goods
everywhere (costs are not frozen at entry). The preview estimate uses the same function
(`estimateIssueCosts`).

## Job work

- **Principal** (godown `ours_with_party`): Material Out = transfer from our godown to the job worker's
  godown (still our stock; challan rate → taxable value for ITC-04; goods type inputs / capital goods /
  moulds-dies-jigs-fixtures-tools). Material In = finished goods received (product line), components
  consumed **at** the job worker's godown, by-products / scrap, unprocessed material returned
  (transfer), job charges as an additional cost.
- **Job worker** (godown `party_with_us`): Material In `receipt` = a principal's goods received; Material
  Out `issue` = goods sent back. These quantities are tracked per godown but never valued and never in
  our Balance Sheet; a Manufacturing Journal may process them in that godown. When any component of a
  Manufacturing Journal is in a principal's godown, its product / by-products / scrap default to that
  godown and are refused in one of our own godowns (they are the principal's; in our godown they would
  enter at current cost out of nothing). Any other voucher moving stock into / out of a `party_with_us`
  godown gets a confirm-level `mfg` warning (`hook.ts › warnPrincipalGodown`).
- **Pending job work** (`mfg.jobWork.pending`): FIFO per (godown, item) of what reached the third-party
  godown against what left it, challan line by challan line, with the s.143 return date and status
  (overdue / due within `warnDays` / ok / no limit). Opening stock in such godowns is listed as
  "unexplained" (no challan date). The job worker / principal of a movement is the **godown's party**
  (a purchase delivered straight to the job worker, s.143(1)(b), or a sale from his premises has the
  supplier / buyer as its voucher party), else — for a Material In / Out — the voucher's party. Goods
  **moved on from one job worker to another** keep the original challan number, date, goods type and
  extension: the new lot inherits the FIFO lots the transfer took, so the s.143 period still runs from
  the day the principal first sent them out.
- **s.143 rules** (`shared/mfg/jobwork.ts`, data with `effectiveFrom`): inputs 1 year, capital goods 3
  years from the day sent; moulds and dies, jigs and fixtures, tools — no limit; not back in time →
  deemed supplied by the principal on the day sent (s.143(3)/(4)). A Commissioner's extension (up to 1 /
  2 more years) is recorded per challan line (`extendedTo`). Due date = same calendar date N months later.
- **ITC-04** (`mfg.itc04.report`): table 4 (sent: GSTIN or state of an unregistered job worker, challan,
  goods type, HSN, UQC, quantity, taxable value, tax rates by intra / inter-state), tables 5A (received
  back, with the original challan by FIFO and the finished goods received; the document number is the
  voucher's reference no. — the job worker's own challan — when entered, else our number), 5B (sent on to another job
  worker), 5C (sold from the job worker's premises — a sale / delivery note from that godown). Frequency
  by rule 45(3): quarterly until 30-Sep-2021; from 01-Oct-2021 half-yearly when the previous year's AATO
  exceeds ₹5 crore, else annual; due on the 25th after the period. The HSN / rates of the table-4 lines
  come from one dated resolver for the period's items (`inventory/gst.ts › createDatedGstResolver`):
  the report runs the same ~11 statements for 4 or 4,000 challan lines (it ran two GST look-ups per
  line before the final wave; vouchers/perf-hooks.test.ts).
- **Orders** (`orders.ts`): Job Work Out / In Orders (JWO-n / JWI-n), material exploded from the BOM when
  not entered; progress from the linked Material In / Out vouchers; a linked order cannot be deleted.

## Routes

| Route | Access | Notes |
|---|---|---|
| `mfg.bom.list` / `get` / `revisions` | masters.view | |
| `mfg.bom.save` | masters.view (service: masters.create / masters.alter) | audited `bom` create/alter; CONFLICT on stale `expectedUpdatedAt` |
| `mfg.bom.delete` | masters.delete | refused while a voucher / order uses it (mark inactive) |
| `mfg.bom.cost` | reports.view | estimate at current cost as on `asOf` vs item standard cost |
| `mfg.journal.types` / `context` / `get` / `duplicate` | vouchers.view | entry screen support |
| `mfg.production.register` | reports.view | engine values + BOM estimate today |
| `mfg.jobWorkOrder.list` / `get` / `nextNumber` | vouchers.view | |
| `mfg.jobWorkOrder.save` | vouchers.view (service: vouchers.create / vouchers.alter) | audited `job_work_order` |
| `mfg.jobWorkOrder.delete` | vouchers.delete | audited |
| `mfg.jobWork.pending` / `alerts` | reports.view | |
| `mfg.itc04.periods` / `report` | gst.view | |

Journals themselves: `vouchers.save` / `vouchers.preview` / `vouchers.delete` / `vouchers.cancel` (the
vouchers module's permissions, period lock and audit apply unchanged).

## Legal assumptions and uncertainties (as of 09-Oct-2026)

- s.143 time limits and the tools exclusion, the deemed-supply rule and the Commissioner's extension are
  settled law; they are data rows (`RETURN_LIMIT_RULES`) a later amendment can supersede.
- ITC-04 frequency and the 25th due date follow rule 45(3) as amended w.e.f. 01-Oct-2021. Due dates are
  often extended by notification — **UNCERTAIN for any given period; check the portal**.
- ITC-04 output is a clean CSV / Excel of the form's columns for keying into the GST offline tool. Bahi
  does **not** generate the portal's JSON upload schema (not reproduced here without certainty).
- Moulds / dies / jigs / fixtures / tools are listed as "Inputs" in table 4's goods-type column (the form
  has only Inputs / Capital Goods); check with your adviser if your tool is a capital good.
- Losses and wastes in table 5A are left at 0 for the user to fill in the offline tool.
- The challan prints no tax (job work is not a supply); rule 55 content (consignee GSTIN / state, HSN,
  quantity, taxable value) comes from the voucher.

## Tests

`bom.test.ts`, `journal.test.ts` (hand-verified costing incl. FIFO paint, scrap, percent overhead;
back-dated re-valuation; alter / optional / cancel / delete; rules; dispatcher e2e), `jobwork.test.ts`
(principal and job-worker sides, Balance Sheet stock, pending + s.143, ITC-04 4/5A, orders, period lock),
`setup.test.ts` (migration upgrade, F11 types, class rules, godown kinds), `print.test.ts` (Material Out
challan), `e2e.test.ts` (godown → BOM → order → Material Out → Material In → pending → alerts → ITC-04 →
edit log, all through the dispatcher), `shared/mfg/costing.test.ts` (costing rule, explosion, s.143 dates,
ITC-04 periods), `review.test.ts` (adversarial review regressions: a principal's goods processed into
our own godown, ordinary vouchers touching a principal's godown, job worker attribution of a direct
purchase, s.143 date kept across a job-worker-to-job-worker move and 5B, 5A job worker's challan no. and
unique row keys, optional / reference read back, Production Register with several journals), `gaps.test.ts`
(final wave: a principal's goods out of our quantities and batches; a classed journal altered without its
details is refused).

## Known gaps

- Tally XML import still skips Tally's Job Work / Material In / Out vouchers (`data/tallyImport.ts`); they
  can be re-entered here.
- Additional costs never post to their ledgers (Tally behaviour); the expense is booked separately.
- The "AATO above ₹5 crore" switch of the ITC-04 screen is remembered per computer (browser storage), not
  stored in the company.
- No multi-level BOM explosion (sub-assemblies are made with their own Manufacturing Journal first).
- The Material Out print lists both sides of the stock journal (from our godown / to the job worker's).
- (Resolved, final wave.) Whole-company quantities outside the valuation engine (`inventory/stock.ts`:
  `stockByItem`, `stockOnHand`, `batchesFor` without a godown — item list closing quantity, reorder
  status, dashboard low stock) now leave a principal's goods in `party_with_us` godowns out, like the
  values; asking for that godown still shows them (`gaps.test.ts`).
- ITC-04 lists moulds / dies / jigs / fixtures / tools under "Inputs" in table 4's goods-type column
  (the form has Inputs / Capital goods only) — UNCERTAIN; check with your adviser.
- (Resolved, final wave.) A classed voucher can no longer be altered from the generic stock journal grid
  (it would lose its derived rows): the save is refused with directions (see "Voucher types and posting").
- (Resolved, final wave.) Duplicating a classed journal from the general voucher screen
  (`vouchers.duplicate`) now clears each challan line's return-date extension, like the mfg screen.
