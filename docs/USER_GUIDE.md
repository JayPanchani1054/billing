# Bahi ERP — User Guide

A practical guide for business owners and accountants, one section per feature. Keys are shown as
they appear on screen (for example **Ctrl+A** to accept); every screen is also reachable from the
Gateway menu and from Go To (**Alt+G**).

## Quotations, recurring vouchers, bills pending, budgets and scenarios

### Quotations and proforma invoices

A **quotation** is your price offer; a **proforma invoice** asks the customer for an advance before you
supply. Neither touches your books, stock or GST returns, and each has its **own number series** — so
your GST invoice numbers stay consecutive (CGST Rule 46).

- **Create:** Gateway › Transactions › *Quotation* or *Proforma Invoice* (or F10, or Go To). Enter the
  party and items as on a sales invoice — GST is worked out for printing — and a **Valid until** date.
- **Print:** Alt+P. The title reads *Quotation* or *Proforma Invoice*; a proforma always says
  **"This is not a tax invoice"** and prints your bank details / UPI QR for the advance.
- **Track:** Gateway › Reports › *Quotation Register* shows every document with its status — *Open*,
  *Accepted*, *Rejected*, *Expired* (open past its validity), *Converted* or *Cancelled* — the value by
  status and your conversion rate. Ctrl+1 / Ctrl+2 switch between quotations and proforma invoices.
- **Record the customer's answer:** Alt+S → Accepted, or Rejected with a reason (price, delivery time …).
- **Convert with one key:** on the register or the opened document, **Alt+V** makes a Sales Invoice and
  **Alt+O** a Sales Order (quotations only; needs Order processing in F11). The new voucher opens filled
  in; check it and save. The quotation then shows *Converted* with a link to the invoice — it cannot be
  converted twice (cancel or delete the invoice first if you need to).
- **Duplicate (Alt+2)** a quotation to re-quote: the copy is dated today and keeps the same validity
  length (a 15-day offer stays a 15-day offer).

### Recurring vouchers (rent, retainers, AMC, EMIs)

1. Open a saved voucher (e.g. this month's rent journal or a retainer invoice) and press **Alt+R**
   (*Make recurring*), or go to Gateway › Masters › *Recurring Vouchers* › Alt+C and pick the voucher.
2. Choose how often: monthly, quarterly, half-yearly, yearly or every N days; the day of the month
   (*Last day of the month* for month-end entries — the 31st falls on 30-Apr and 28/29-Feb); the first
   posting date and, if it ends, the last. If the voucher has one amount you can change it here.
3. Write `{period}` in the narration to get "Rent for May 2026" in each posting (`{date}` and `{fy}` work too).

Bahi never posts behind your back. When you open the company, a notice says **"N recurring vouchers are
due"** (it is also on the dashboard). Press *Review & post*, or Gateway › Transactions › *Due Recurring
Vouchers*:

- Everything due up to the working date (F2) is ticked. **Space** unticks a line, **Alt+O** changes the
  amount for this posting only, **Alt+S** skips it (with a reason), **Enter** opens it in voucher entry
  to change anything before saving.
- **Ctrl+A** posts the ticked vouchers. Each becomes an ordinary voucher with its own number, in the Day
  Book and the edit log. A month can never be posted twice; if you delete a posted voucher, that month
  becomes due again.
- Pause a template (Alt+S on the list) when the arrangement stops for a while.
- Changing a template's day of the month or end date is always safe. If you change *how often* it runs
  (say quarterly to monthly, or every 7 days from another date), Bahi asks you to start the new schedule
  on or after the date the old one would have posted next — so a month, quarter or week already posted
  is never billed again.

### Sales Bills Pending and Purchase Bills Pending

Gateway › Inventory Reports › *Sales Bills Pending* lists delivery notes (and rejections in) whose goods
have gone out but are not fully invoiced; *Purchase Bills Pending* lists receipt notes (and rejections
out) whose supplier bills you have not entered. You see the quantity, what is billed, what is pending,
the value and the age of each line, and the total by age (0–7, 8–30, 31–90, over 90 days).

- Ctrl+4 / Ctrl+5 group the list by party or by item; Enter on a group shows its lines.
- **Alt+I** (*Invoice now* / *Enter bill*) opens the invoice already filled with the pending quantities
  and linked to the note — stock is not moved twice.
- Why it matters: for a taxable sale of goods the invoice is due before or at the time the goods leave
  (CGST Act s.31). A delivery challan is meant for job work, goods on approval and similar movements
  (CGST Rule 55). The dashboard warns about delivery notes unbilled for more than 7 days (7 days is
  Bahi's reminder, not a legal limit; rejections waiting for a credit note are not counted).

### Pre-closing an order

When a customer cancels the rest of an order (or a supplier will not deliver it), don't alter the order —
**pre-close** it: Alt+L on *Pending Sales/Purchase Orders* or on the opened order. Choose the quantity
per item (the whole balance by default), the date and the reason. The balance leaves the pending-order
reports and the "From orders" list from that date; the order itself is unchanged. The order's view shows
what was closed, by whom and why, with **Reopen order** to undo it.

### Reversing journals and scenarios

A **Reversing Journal** (F10 › Reversing Journal) is a provisional entry — for example a month-end
provision for an unbilled expense. It never changes your books. Give it an **Applicable up to** date:
it counts in provisional reports only up to that date.

A **scenario** (Gateway › Masters › *Scenarios*) says which provisional vouchers to add to the reports:
memorandum vouchers, reversing journals and optional vouchers of the voucher types you tick — with or
without the actual books — and which regular voucher types to leave out (e.g. "before year-end
journals"). On the **Trial Balance, Profit & Loss and Balance Sheet press Alt+S** and choose the
scenario; the report title shows it, and the totals still balance. Group summaries you drill into follow
the scenario; ledger statements, outstanding and GST returns always show the books.

### Budgets and budget variance

Gateway › Masters › *Budgets* › Alt+C: name, period (usually the financial year) and lines. Each line is a
group, ledger or cost centre with an amount, **Dr or Cr** (type `d` / `c`): an expense or asset budget
is Dr, an income or liability budget Cr. Choose **On nett transactions** for what should be spent or
earned in the period, or **On closing balance** for where a balance should stand (e.g. debtors at
year-end).

- Gateway › Reports › *Budget Variance* (or Alt+V on the budget list) shows each line's budget, actual,
  variance and variance %, marked *Over budget* or *Within budget*. Enter drills to the ledger, group or
  cost centres. Ctrl+2 reports a part of the year (Alt+F2): nett budgets are scaled by days (a quarter
  of an annual budget for a quarter); closing-balance targets stay as they are. Alt+S runs it under a
  scenario.
- On the Trial Balance, P&L and Balance Sheet, **Alt+B** adds a budget column next to the amounts
  (the Trial Balance also shows the variance: a nett budget against the period's debits less credits, a
  closing-balance budget against the closing balance).
- The report's total counts each amount once: a ledger budgeted inside a budgeted group (and cost-centre
  lines next to group / ledger lines) is shown but not added again. Drilling into a group under a
  scenario keeps the scenario.

## TDS and TCS (tax deducted / collected at source)

*For businesses that deduct TDS on payments (contractors, professionals, rent, commission, interest,
purchases above ₹50 lakh for buyers with turnover above ₹10 crore) or collect TCS on sales (scrap,
minerals, forest produce, motor vehicles above ₹10 lakh).*

**1. Turn it on.** Press **F11** › Taxation › **TDS** and/or **TCS**. A **TDS / TCS** section appears on
the Gateway. Nothing about TDS/TCS is shown while both are off.

**2. Setup** (TDS / TCS › TDS / TCS Setup). Enter your **TAN**, the deductor category and the person
responsible. If your turnover exceeded ₹10 crore last year, turn on **Deduct TDS on purchase of goods
(s.194Q)**. Tax is rounded to the rupee unless you turn that off.

**3. Natures of payment / goods.** The common sections come ready with their rates and thresholds for
FY 2025-26 (194C, 194H, 194I, 194J, 194A, 194Q, 194R, 194T, 195, 206C(1), 206C(1F)). When the law
changes, open the nature and **add a rate row from the new date** (Alt+R) — do not overwrite the old
one, so older vouchers keep their rate. From 1 April 2026 the Income-tax Act 2025 applies: the app
keeps the familiar 1961 section codes and assumes the rates carried on unchanged — check with your
tax adviser and add dated rows if they changed. The rate for payments to non-residents (195) is a
placeholder; set the right rate for each remittance.

**4. Tell the app who and what.** TDS / TCS › **Ledger TDS / TCS Details**:
- *Parties* (Ctrl+1): every supplier / customer is a deductee unless you turn **TDS / TCS applies to
  this party** off (an exempt party — e.g. a transporter who gave the s.194C(6) declaration). Enter the
  **PAN** (checked as you type — without
  a valid PAN a higher rate applies — usually 20% for TDS, 5% for 194Q, and twice the rate (at least 5%) for TCS), the **deductee type** (company, individual/HUF, firm,
  others; suggested from the PAN), and any **lower / nil deduction certificate** (number, rate, dates,
  amount limit). For a customer who deducts TDS from you, enter its **TAN**.
  Partners (194T) and lenders (194A): open their capital / loan ledger here and set the deductee type.
- *Expenses & assets* (Ctrl+2): mark e.g. *Contract Charges* as TDS applicable under 194C.
- *Sales & income* (Ctrl+3): mark e.g. *Sale of Scrap* as TCS applicable.
You can also reach these from a ledger master (Other settings › Open TDS / TCS details).

**5. Enter vouchers as usual.** On a purchase bill, journal or payment the right-hand column shows the
TDS worked out — section, base, rate and why (e.g. "the year's total ₹1,20,000 crossed ₹1,00,000:
earlier credits taken in now"). The supplier is credited with the bill less TDS, and *TDS Payable –
194C* is credited. On a sale with TCS the tax is added to the invoice. Press **Alt+U** to change an
amount (you must give a reason — it is recorded and listed under Exceptions) or, for an **advance
payment**, to choose the nature to deduct under. When the bill for that advance comes, the part already
taxed as the advance is set off — TDS is deducted only on the rest. If you type the *TDS Payable* line
yourself, the app takes your amount instead of adding its own. A purchase return or sales return does
not reverse TDS / TCS: alter the original bill instead.

**6. Pay the tax.** TDS / TCS › **TDS / TCS Outstanding** shows, month by month and section by
section, what was deducted and not yet deposited, the due date (7th of the next month; 30 April for
March TDS), days late and the interest (1.5% a month or part for late TDS deposit, 1% for TCS). Highlight
a month and press **Alt+C**: the challan form opens with the unpaid tax and the interest filled in.
Enter the BSR code, challan serial number and deposit date from the challan and press **Ctrl+A**. A
Payment voucher is created and the month is cleared. **Challan Register** lists every challan.

**7. Quarterly statements.** TDS / TCS › **Quarterly Return**: pick 26Q (residents), 27Q
(non-residents) or 27EQ (TCS), the year and the quarter. Ctrl+1 shows the deductee rows (with
PANNOTAVBL where a PAN is missing), Ctrl+2 the challans; warnings tell you what is not yet deposited.
**Alt+S** saves two CSV files with every field the return preparation utility asks for — copy them in,
or send them to your tax practitioner. They are not the final FVU file: validate with the current FVU
before filing. After filing, press **Alt+R** and enter the filing date and token: the late fee u/s
234E (₹200 a day, up to the tax) stops counting. The Outstanding screen also lists each statement with
its due date and late fee.

**8. Check before you file.** TDS / TCS › **Exceptions** lists vouchers with no PAN or an invalid PAN,
amounts deducted below the threshold, thresholds crossed but not deducted (with the interest that may
be due), and short deductions. Enter opens the voucher.

**9. TDS your customers deduct.** Create the *TDS Receivable* ledger (TDS / TCS Setup › Alt+R) and
debit it in Receipt vouchers (Dr Bank, Dr TDS Receivable, Cr Customer). In **TDS Receivable vs 26AS**
press **Alt+I** to import a CSV prepared from Form 26AS / AIS (columns: TAN of deductor, Name of
deductor, Section, Transaction date, Amount paid/credited, Tax deducted). Each customer shows the TDS
in your books against 26AS; differences are the ones to follow up.

Reports open with Enter down to the voucher, and export (Alt+E) or print (Alt+P) like every other
report. The Gateway reminds you when a deposit is overdue or due within a week.

## Manufacturing and job work

Turn these on in **F11 › Features › Inventory**: *Bill of materials and manufacturing* for making goods,
and *Job work* (it needs *Multiple godowns*) for sending material to job workers or processing a
principal's material. Turning them on adds the voucher types **Manufacturing Journal**, **Material Out**
and **Material In** (you may rename them, or set "Use as" on your own Stock Journal types under
Masters › Voucher Types).

### Bills of materials (BOM)

A BOM lists what goes into an item you make. Gateway › Masters › *Bills of Materials* (Alt+C to create).

- Choose the **finished item**, give the BOM a name (an item can have several — *Standard*, *Export
  pack* …) and say what quantity the lines are for, e.g. "components are for 10 Nos".
- Add **components** with their quantity (and a default godown if you keep stock in several places).
- Add **by-products** and **scrap** with how they are valued: a rate per unit, a percentage of the cost
  of production, or no value. Their value is taken off the cost of the finished goods.
- One BOM per item is the **default**; mark old ones inactive rather than deleting them.
- Every change is kept as a **revision** (Alt+H shows each one). Vouchers remember the revision they used.
- The form shows the **estimated cost** of the BOM at today's cost of the components, next to the item's
  standard cost.

### Manufacturing Journal

Gateway › Transactions › *Manufacturing Journal* (or F10 / Go To).

1. Enter the date, the **finished item** and the **quantity** made. The item's default BOM is chosen and
   the **components** and **scrap** fill in, scaled to your quantity (change the BOM in its field).
2. Correct any quantity actually used — once you change a component by hand the BOM no longer refills
   it; **Alt+B** fills it from the BOM again.
3. Add **additional costs** (labour, power, overheads) as an amount or as a % of the components'
   cost, naming the expense ledger.
4. The panel shows the cost as you type: **components consumed** (valued by each item's costing
   method — average, FIFO … — as on the voucher date) **+ additional costs − by-products/scrap = cost of
   the finished goods**, and the **rate per unit**. **Ctrl+A** saves.

**Ctrl+L** makes the journal optional (a memo that moves no stock) and **Ctrl+T** post-dated, as on
other vouchers; altering an optional journal keeps it optional until you press Ctrl+L again.

The journal moves stock only. Additional costs raise the value of the finished goods but **are not
posted to the expense ledgers** (as in Tally) — record the actual expense with a Payment or Journal
voucher as usual. If a purchase is entered later with an earlier date, the cost of the finished goods is
recomputed automatically in every report. *Inventory reports › Production Register* lists what was made,
at what cost, against the BOM's estimate today.

### Godowns for job work

In the godown form (Masters › Godowns), *Whose stock* says what a location holds:

- **Our stock with third party** — your goods at a job worker or agent. Still your stock: valued and
  in your Balance Sheet.
- **Third-party stock with us** — a principal's goods you process. Quantities are tracked but they are
  **never valued and never part of your closing stock**.

Link the godown to the job worker's (or principal's) ledger; challans then pick the right godown when
you choose the party.

### Sending goods to a job worker (you are the principal)

- **Job Work Orders** (optional; Transactions › *Job Work Orders*): what the job worker will
  make, the material to send (Alt+B fills it from the BOM), process, job charges and due date. From an
  order, **Alt+O** opens a Material Out and **Alt+I** a Material In against it; the order shows what has
  gone and come back.
- **Material Out** (the delivery challan for job work, CGST rule 55): choose the job worker and their
  godown, then the material, your godown it leaves from, the **type of goods** (inputs, capital goods,
  or moulds/dies/jigs/fixtures/tools) and the **challan rate** (the value shown on the challan and in
  ITC-04). Alt+P prints "Delivery Challan (Job Work)".
- **Material In**: the finished goods received, the components the job worker used up, any scrap, any
  material returned unprocessed, and the job charges as an additional cost — the finished goods are
  valued like a Manufacturing Journal. Type the **job worker's challan no.** (the challan they sent
  the goods back with) in its field: ITC-04 table 5A reports it.
- **Moving goods from one job worker to another**: a Material Out to the second job worker's godown
  with the first job worker's godown as the line's *From godown*. The goods keep the date of your
  original challan for the one-year / three-year rule (moving them on does not restart the clock), and
  ITC-04 reports the move in table 5B, not as a new table 4 challan.
- **Purchases delivered straight to the job worker** (enter the job worker's godown on the purchase
  line) are listed under the job worker in Pending Job Work and ITC-04, not under the supplier.

### The one-year / three-year rule (CGST s.143)

Inputs sent for job work must come back (or be supplied from the job worker's premises) within **one
year**, capital goods within **three years** of the day they were sent; moulds, dies, jigs, fixtures and
tools have no limit. Goods not back in time are treated as **supplied by you on the day they were sent**
— GST is payable with interest.

*Inventory reports › Pending Job Work* lists every challan still (partly) with a job worker, its
return-by date and status (*Overdue*, *Due in n days*, *No time limit*); the Gateway and the dashboard
warn you about overdue and soon-due goods. If the Commissioner has extended the time, enter the new date
in the challan line's *Return extended to* field. Ctrl+2 shows principals' goods lying with you.

### ITC-04

Gateway › GST › *ITC-04*. Choose the period — **half-yearly** (Apr–Sep, Oct–Mar) if your previous year's
aggregate turnover was above ₹5 crore (switch on *AATO above ₹5 crore*), otherwise **annual** — and
review **Table 4** (goods sent, Ctrl+1) and **Tables 5A–5C** (received back with the original challan,
sent on to another job worker, sold from the job worker's premises, Ctrl+2). Alt+E exports each table to
CSV or Excel in the form's column order, to key into the GST portal's ITC-04 offline tool; Bahi does not
create the portal's upload file. Check the due date on the portal — it is often extended — and fill in
losses and wastes yourself where they apply.

### If you are the job worker

Mark the principal's godown *Third-party stock with us*. Record goods received with **Material In**,
your processing with a **Manufacturing Journal** in that godown (needs *Bill of materials and
manufacturing* on), and goods sent back with **Material
Out**. None of this changes your stock value or Balance Sheet; your job charges are billed with an
ordinary sales invoice.

When the components of a Manufacturing Journal come from the principal's godown, the finished goods,
by-products and scrap go into that godown too (leave their godown blank). Bahi refuses to put them in
one of your own godowns — they belong to the principal, and in your godown they would appear in your
stock at a value out of nothing. A purchase, sale or ordinary stock journal that moves stock into or out
of a principal's godown asks you to confirm first, because that stock is never valued.

## GST: set-off, challans, advances, imports, amendments and composition returns

Everything here needs GST turned on (F11) and lives under **GST** on the Gateway. Reading needs the
"View GST" permission; marking returns filed, posting the set-off or a challan and saving return files
need "File GST returns". The figures come from your books — always compare them with the GST portal
before you file, because the portal is the legal record.

### GST details on a voucher (Alt+J)

Some GST entries are not ordinary invoice lines. While entering a voucher press **Alt+J** (GST
details); the voucher shows a "GST: …" badge once something is set, and the details are kept when you
alter the voucher later.

- **Receipt — advance against a future supply.** Tick it, choose *Services* and the GST rate (the place
  of supply defaults to the customer's state). The receipt then posts the tax on the advance (debit "GST
  on Advances Received", credit Output CGST / SGST or IGST). For *Goods* no tax is due on advances
  (Notification 66/2017-CT), so nothing extra is posted. Allocate the receipt bill-wise as an *Advance*.
  Once an invoice or refund has used the advance, the receipt keeps its rate, place of supply and at
  least the amount used: to change those, first alter (or delete) the invoice or refund.
- **Sales invoice — advance adjusted.** When the invoice settles the advance bill-wise (*Against* the
  advance), the tax on the advance is reversed automatically. You can also enter the amounts per
  advance under Alt+J.
- **Payment — refund of an advance.** Choose *Refund of an advance* and the amount refunded for the
  receipt; the tax on that part is reversed (GSTR-1 Table 11B).
- **Payment — GST challan.** Choose *GST challan (PMT-06)* and type the CPIN, CIN, BRN and the amount
  per head (tax, interest, penalty, fee, others). Debit "GST Electronic Cash Ledger" and credit the bank.
  The easier way is GST Set-off › **Alt+C** (below), which builds this voucher for you.
- **Purchase — bill of entry (imports).** For goods bought from an overseas supplier or an SEZ unit,
  tick *Import of goods* and enter the BOE number, date, port code (six characters, e.g. INNSA1),
  assessable value, customs duty and the IGST paid at customs. The IGST is taken as input credit
  (GSTR-3B 4(A)(1)); for a composition dealer, or for goods whose credit is blocked (for example a car
  marked "ineligible"), it becomes part of the cost. Enter blocked and other goods on separate purchases.
- **Journal — stat adjustment.** Choose the kind of adjustment, then enter the journal lines:
  - *Reversal of ITC* (Rule 42 / 43 common credit, Rule 38, s.17(5), Rule 37 supplier not paid within
    180 days, Rule 37A supplier did not file GSTR-3B, others): credit the Input tax ledgers and debit
    an expense such as "ITC Reversed (GST)". Shown in GSTR-3B 4(B)(1) or 4(B)(2).
  - *Reclaim of ITC* (after you pay the supplier, or the supplier files): debit the Input tax ledgers.
    Shown in 4(A)(5) and 4(D)(1).
  - *Reverse charge liability* (for example import of services): credit the "… Payable (Reverse
    Charge)" ledgers and debit the Input tax ledgers with the credit you may take; enter the taxable
    value for 3.1(d).

### GST Set-off and challans

GST › **GST Set-off** shows, for the return period (Alt+F2), how your input tax credit pays the tax in
the order the law requires (IGST credit first; CGST credit never for SGST and vice versa; cess only for
cess), the cash still needed per head (tax, interest, penalty, fee, others), what is already in your
electronic cash ledger and what is still to deposit.

1. Create the challan on the GST portal and pay it.
2. Press **Alt+C** and record it: voucher date, the bank you paid from, CPIN, CIN, BRN, challan date.
   The amounts are prefilled with what is still to deposit. This posts a Payment voucher.
3. After filing GSTR-3B (or CMP-08), press **Ctrl+A** to post the set-off: one journal that squares off
   your Output, Input, reverse-charge, interest / late fee and cash-ledger accounts for the period.
   To change it, alter or delete that journal (Alt+V opens it) and post again. If you post it before
   recording the challan, the screen warns you and the cash ledger shows a negative balance until you do.

GST › **Electronic Cash Ledger** and **Electronic Credit Ledger** show the balances per head as kept in
your books (opening, deposited / accrued, utilised, reversed, closing) with every voucher behind them
(Enter opens it). Compare them with the ledgers on the portal.

### Advances (GSTR-1 Table 11)

GST › **Advances (GST)** lists, for the period, advances received (11A) and adjusted or refunded (11B)
by place of supply and rate, with the vouchers (Ctrl+1), and the advances not yet invoiced or refunded
(Ctrl+2). As the GSTR-1 instructions require, an advance received and invoiced (or refunded) in the same
return period is in neither table; only what is still unadjusted at the end of the period goes to 11A. The GSTR-1 table 11 tile opens this screen; the net tax is included in GSTR-3B 3.1(a).

### Bills of entry (imports of goods)

GST › **Bills of Entry** lists the bills of entry recorded on import purchases. Download your GSTR-2B
JSON (or the ZIP the portal gives for a large return) and press **Alt+O** to compare: each BOE is shown as matched, mismatched (with the
IGST difference), missing in your books or missing in GSTR-2B. Claim credit only for bills of entry
that appear in GSTR-2B.

### Filing status and GSTR-1 amendments

After filing a return on the portal, open it in Bahi and press **Alt+F** (Mark filed) — enter the
filing date and the ARN. GST › **Return Filing Status** lists every return marked filed (Alt+U unmarks
one entered by mistake).

Once GSTR-1 of a month is marked filed, its invoices are protected:

- if you alter one, Bahi asks you to confirm and records the change as an **amendment** reported in your
  next GSTR-1 (table 9A for invoices, 9C for credit / debit notes, 10 for small B2C sales) — the filed
  month keeps the figures you filed;
- an invoice entered later but dated in that month is reported in the next GSTR-1 as well;
- such an invoice cannot be deleted or cancelled: issue a credit note instead.

GST › **GSTR-1 Amendments** (or Alt+M on GSTR-1) lists them with the original and amended values. The
GSTR-1 JSON includes the amendments of invoices and notes to registered buyers; enter the others on the
portal from this list.

### Composition dealers: CMP-08 and GSTR-4

If your company is registered under composition (Company › GST details), your sales are Bills of Supply
without tax ("Composition taxable person, not eligible to collect tax on supplies"), supplier GST is a
cost, and the GST menu shows **CMP-08**, **GSTR-4** and **Composition Rates** instead of GSTR-1 / 3B. The
dashboard shows when each is due (CMP-08 by the 18th after each quarter, GSTR-4 by 30 April after the
year); the government sometimes extends these dates, so check the portal.

- **Composition Rates**: choose your category (manufacturer, trader, restaurant, service provider
  under s.10(2A)) and check the rates — 1% for manufacturers and traders (traders on taxable turnover),
  5% for restaurants, 6% for service providers, each half CGST and half SGST. If a rate changes, add a
  new rate with its effective date (Alt+C); older documents keep the old rate.
- **CMP-08** (quarterly): table 3 — your turnover and the composition tax on it, plus tax on purchases
  under reverse charge (including import of services), interest (Alt+I) — and table 4, the tax paid.
  Pay through GST Set-off (Alt+S): record the challan, then post the set-off. Save the figures as CSV /
  JSON (Alt+K / Alt+J) — the portal has no CMP-08 upload, so type them in — and mark it filed (Alt+F).
- **GSTR-4** (annual): purchases (4A registered, 4B registered under reverse charge, 4C unregistered, 4D
  import of services), your four CMP-08s (table 5; Enter opens a quarter), rate-wise supplies (table 6)
  and the tax paid (table 8). The file it saves is Bahi's own CSV / JSON to help you fill the return; it
  is not the portal's offline-tool file. TDS / TCS credit (table 7) is not kept — take it from the portal.

### e-Invoice and e-way bills: why there is a JSON round trip

Bahi works offline and does not hold the API credentials of a GST Suvidha Provider, so it does not talk
to the IRP or the e-way bill system directly. Instead:

1. GST › e-Invoice (or e-Way Bills): select the invoices and press **Alt+J** to save the JSON file.
2. Upload it on the IRP (e-invoice portal › bulk upload) or the e-way bill portal (bulk generation).
3. Download the response file the portal gives you (IRN, acknowledgement, signed QR code / EWB numbers).
4. Back in Bahi: e-Invoice › **Alt+I** imports the IRP response (the IRN and QR code then print on the
   invoice); e-Way Bills › **Alt+N** records the e-way bill number and validity.

Cancel an IRN on the portal within 24 hours and then mark it cancelled in Bahi (Alt+K).
