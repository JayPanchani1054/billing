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
  converted twice (cancel or delete the invoice first if you need to). The invoice can never be dated
  (or later altered to a date) before its quotation, nor the quotation moved after its invoice.
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
the scenario; ledger statements, outstanding and GST returns always show the books. Budget variance
under a scenario follows it for cost centres too.

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
yourself, the app takes your amount instead of adding its own.

A **debit note** to a supplier against a bill with TDS (bill-wise *Against* the bill, or its invoice
number in *Original invoice*) reverses the TDS in proportion — a note for 10% of the bill reverses 10%
of its TDS, never more than is left — and a **credit note** to a customer reverses TCS the same way.
If you booked a bill **without** TDS and deduct it later by a journal (Dr the supplier against the bill,
Cr *TDS Payable – 194C*), Bahi records it as the TDS on that bill: it shows in Outstanding, the
statement and every report. 194T (payments by a firm to its partners) is deducted only when the
deductor category in TDS / TCS Setup is *Firm*. On a bill from a foreign supplier kept in dollars, TDS
u/s 195 is worked out on the rupee value; the supplier is owed the net in dollars, and paying that net
settles the bill.

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
its due date and late fee. Once a statement is recorded as filed, its quarter is protected: saving a
voucher that changes the TDS / TCS or challan reported in it asks you to confirm (file a correction
statement on TRACES afterwards), and such a voucher cannot be deleted or cancelled. If you recorded
the filing by mistake, open the statement, press Alt+R and choose **Not filed**.

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
  **never valued and never part of your closing stock** — nor of your item quantities, reorder status
  or the dashboard's low-stock list (open that godown in the godown summary to see them).

A Manufacturing Journal, Material Out or Material In is altered on its own screen. If that screen cannot
open (e.g. the feature was turned off in F11), saving it from the plain Stock Journal screen is refused
with a message saying what to turn on — so its job work and costing details are never lost.

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
   Credit you entered in GSTR-3B as *credit not in the books* is never taken from your Input ledgers:
   the journal credits it to **GST Credit Not in Books** (give that ledger an opening balance for the
   credit the portal held when you started).

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

Once **GSTR-3B** of a month is marked filed, that month is protected too: altering a purchase, an ITC
reversal or reverse-charge journal, a bill of entry or any voucher with GST of that month asks you to
confirm; the change (and a voucher entered later but dated in that month, or one deleted or cancelled)
is listed in GST › **Changes after GSTR-3B Filing** and reported in your **next** GSTR-3B — more credit
in 4(A), less credit as a reversal in 4(B)(2), tax in 3.1 — while the filed month keeps the figures you
filed.

GST › **Rule 37 (180 Days)** lists purchase bills not paid within 180 days of their date (as on the date
you choose): the input tax credit to reverse for the unpaid part, the GSTR-3B month it belongs to, and —
once you pay — the credit to reclaim. **Alt+R** posts the reversal journal, **Alt+L** the reclaim (both
GST stat adjustments, in 4(B)(2) / 4(A)(5) + 4(D)(1)). Interest u/s 50 is not worked out: enter it in
GSTR-3B under *Your entries*. A supplier kept without bill-wise details cannot be traced; the screen
lists such bills to check by hand.

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
  new rate with its effective date (Alt+C); older documents keep the old rate. Once the books are locked
  (F12), a rate (or the category) that would change the tax of a locked quarter cannot be added,
  altered or deleted — add the new rate from a date after the lock.
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

## Multiple currencies (exports, imports, foreign bank accounts)

Use this if you bill overseas customers in dollars, pay foreign suppliers in euros, or keep an EEFC
account. Your books stay in rupees — every voucher still balances in rupees — but customers, suppliers
and bank accounts that you deal with in a foreign currency are *also* kept in that currency.

### Setting it up

1. **F11 › Features › Multiple currencies** — turn it on. A ledger called **Forex Gain/Loss** (under
   Indirect Expenses) is created for exchange differences.
2. **Masters › Currencies** — create the currency (for example `$`, US Dollar, ISO code `USD`, 2
   decimals). **Alt+R** enters a rate of exchange for a date: *standard*, *selling* and *buying* rates in
   rupees for one unit. Enter the rates you actually use (your bank's rate, or for exports of goods the
   rate notified by CBIC for customs). Bahi does not download rates.
3. Open the customer / supplier / bank ledger and set its **Currency**. From then on it is entered in
   that currency. (Once vouchers record a ledger in a currency, its currency cannot be changed — create a
   new ledger instead.)
4. Opening balances: enter the rupee opening balance in the ledger as usual, then **Masters › Opening
   Balance in Currency** (or Alt+O in Forex Outstanding / Ledger in Foreign Currency) to give the same balance — and each
   opening bill — in the currency. **Alt+R** there fills every amount at one rate. Like the rupee
   openings, these cannot be changed once the books are locked (F12 › Period lock) up to the books
   beginning or later — unlock the period first.
5. Optional: **Masters › Multi-currency Settings** — choose other ledgers for realised and unrealised
   differences, and which rate (standard / selling / buying) is used at the year end.

### Export invoices

Create the sales invoice (F8) for the overseas customer as usual. Because the customer is kept in
dollars, Bahi fills in the **rate of exchange** from your rates (the buying rate of the invoice date)
or asks for it when there is none; **Alt+Y** shows or changes it. Type rates and amounts **in dollars**; the rupee value is what
posts, and GST is worked out in rupees. In **Ctrl+I › More details › Export** choose *under LUT* (no
IGST) or *with payment of IGST*, and fill the shipping bill number, date and port code when you have
them. The side panel shows the invoice value in dollars, the rate and the rupee value.

The printed invoice is your normal GST invoice in rupees (with the "supply meant for export…" line)
plus a table of every line in dollars next to the rupees, the rate, GST in rupees (and its dollar
equivalent), the total in both currencies and the dollar total in words. GSTR-1 shows the export in
rupees (EXPWP / EXPWOP), as the portal wants.

Import purchases work the same way with a supplier kept in a foreign currency (selling rate by
default). Amounts are typed with the currency's own decimals: none for yen, three for Kuwaiti dinars,
four where the currency has four.

### Receipts and payments — exchange gain or loss

When the customer pays, enter the receipt (F6) with the customer's line **in dollars** and the rate the
bank gave you (Bahi asks for both when you leave the customer's line; **Alt+Y** reopens it). Choose the
bills it settles in the same dialog, in dollars. If the rate differs from the rate the invoice was
booked at, Bahi works out the **realised exchange gain or loss** and posts it to Forex Gain/Loss *in the
same receipt* — the bill is cleared in both currencies. Example: an invoice of $1,000 at ₹83 (₹83,000);
$600 received at ₹84 = ₹50,400; the bill carried ₹49,800 for that $600, so ₹600 is an exchange gain.

Moving money between your EEFC account and a rupee account is an ordinary contra: the EEFC line in
dollars at the bank's rate.

### Reports

- **Reports › Forex Outstanding** — every party in a foreign currency with its pending bills: amount
  in the currency, the rate it was booked at, the rupees in your books, today's (period-end) closing
  rate, what it is worth at that rate and the difference. Ctrl+1/2/3 all / receivables / payables;
  Enter opens the ledger or the bill's voucher.
- **Reports › Ledger in Foreign Currency** — a ledger's vouchers with amounts, rates and running
  balances in both currencies. From the normal ledger report, **Alt+R** switches to it; from a party's
  outstanding, **Alt+Y** shows its bills in the currency.
- A voucher opened from any report shows a **Foreign currency** panel with the amounts, rates and any
  exchange difference it posted.

### Year end (or quarter end): revaluation

Accounting Standards (AS 11 / Ind AS 21) ask you to restate money owed in a foreign currency at the
**closing rate**. Enter the closing rate in Currencies (or type it on the screen), then open **Reports
› Forex Revaluation** for the period end (Alt+F2). It lists each balance, what it is carried at, what it
is worth at the closing rate and the adjustment. **Ctrl+A** posts the **Forex adjustment** journal
(you can change its date and narration first — not earlier than the revaluation date). Every currency
with a balance needs its closing rate before you can post. Only money items are restated: parties,
bank accounts, loans and deposits; sales, purchase, expense ledgers and fixed assets, investments or
stock kept in a currency stay at the rate they were booked at. Bahi warns you before posting a second
revaluation for the same date. If you reverse revaluations on the first day of the next year, duplicate the journal
(Alt+2 on the voucher) and swap the sides.

Things Bahi does not do: download exchange rates, treat long-term foreign-currency loans under AS 11
para 46A, or hedge accounting — record those with a journal and ask your CA.

## Printing, sharing, cheques and bank payments

### Paper sizes and thermal receipts

Company › **Invoice Printing** sets the template and paper for everything you print: **Modern** and
**Classic** print on A4, A5 (portrait or landscape), Letter or Legal; **Compact** is a till receipt
for 80 mm or 58 mm thermal rolls — item, quantity × rate and amount on narrow lines, a tax summary,
and a page exactly as long as the receipt. A voucher type can have its own template (Masters ›
Voucher Types), and every print preview lets you change it for that print: **Alt+T** template,
**Alt+S** paper, **Ctrl+1/2/3** original / duplicate / triplicate.

### MRP on invoices

Give stock items their MRP (per unit, inclusive of all taxes), then turn on **Show MRP** in Invoice
Printing (or *MRP column* on a voucher type). Sales invoices, quotations, orders and challans print an
MRP column marked "inclusive of all taxes", and invoices add **"You saved ₹…"** — the MRP value less
what the customer actually paid. If a line is billed above its MRP, the preview warns you before
printing: packaged goods must not be sold above MRP.

### Sharing an invoice or statement by e-mail or WhatsApp

On a saved voucher, its print preview, a Statement of Account or an outstanding report press
**Alt+W**. The party's e-mail and mobile come from its ledger (fill in *E-mail* and *Mobile* there
once); the subject and message come from the texts in Invoice Printing › Sharing, which you can
change (placeholders such as {document}, {number}, {amount}, {party}).

- **E-mail**: Bahi saves the PDF in the company's *exports\shared* folder and opens a ready e-mail
  in your mail program (Outlook, Windows Mail) with the PDF attached — check it and press Send. If
  no mail program is set up, your default mail link opens instead and the PDF is shown in its folder
  to attach. (If *exports* or *shared* in the company folder is a shortcut / link to another place,
  Bahi refuses to use it — delete it and Bahi creates the folder again.)
- **WhatsApp**: WhatsApp (app or web) opens a chat with the party's number and your message, and
  the PDF is shown in its folder — drag it into the chat. (WhatsApp does not let any program attach
  a file for you.)

Sharing needs the *Export* permission, and every share is recorded in the edit log.

### Payee bank details

Masters › **Payee Bank Details** keeps each supplier's (or employee's, or landlord's) bank account:
beneficiary name as the bank has it, account number (typed twice, so a wrong digit is caught), IFSC
(11 characters: 4 letters for the bank, a zero, 6 letters or digits for the branch; the bank code is
shown as you type), bank, branch, account type, the **name to write on cheques** if it differs, and how you
usually pay them. Confirm a new or changed account with the payee before paying — fraudsters often
send "changed bank details" letters. Go To finds them too: type the party's name.

### Cheque books and cheque printing

Turn on **F11 › Cheque printing**, then:

1. **Masters › Cheque Books** (Alt+C): choose the bank and type the first and last leaf number
   printed on the book (for example 000501 to 000525). Payments and Contras paid **by cheque**
   (Alt+K on the bank line → Cheque) now get the next unused leaf automatically when saved; you can
   still type a number yourself.
2. **Masters › Cheque Layouts**: start from the *CTS-2010 standard leaf* preset (202 × 92 mm). Press
   **Alt+K** to print the **calibration sheet** on plain paper, hold it against a real cheque in front
   of a light and move the boxes (millimetres from the leaf's top-left corner) until the date boxes,
   payee line and amount boxes fall in place — or use *Shift right / down* when everything is off by
   the same amount. **Alt+T** prints a sample cheque on plain paper to check. Nothing may be printed
   in the bottom 16 mm (the MICR code line); Bahi refuses positions whose text would reach it —
   including the "Authorised Signatory" line, which prints 10 mm below "For <your company>".
3. **Masters › Cheque Printing Settings**: give each bank its layout, whether cheques are crossed
   **A/c Payee** by default, and the signatory text (Authorised Signatory, Partner, Director…).
4. To print: open the payment and press **Alt+K** (Print cheque), or Banking › **Print Cheques**,
   tick several payments of the period (Space, Alt+A all) and press Ctrl+A. Check the preview —
   date as DDMMYYYY in the boxes, the payee, the amount in words in lakh / crore ending with "Only",
   the figures as **\*\*1,23,456.78/-** so nothing can be added — then **Alt+P**. Space leaves a
   cheque out; Alt+X switches its A/c Payee crossing (self cheques for cash withdrawals are never
   crossed). Printing is recorded in the edit log and the register; a reprint is warned.

Feed the leaf as your printer needs: a cheque printer or a printer that takes custom paper prints the
leaf on its own; an ordinary A4 printer can use the *On an A4 sheet* placements.

### Cheque leaf register

Banking › **Cheque Leaf Register** shows every leaf of a bank's books as on a date: **issued**
(post-dated ones marked PDC), **cleared** (the bank date you entered in Bank Reconciliation — Alt+R
opens it), **stale** (not cleared three months after the cheque date — banks will not pay it; issue
a fresh cheque), **cancelled** and **unused**. Ctrl+1…6 switch the view. A spoilt or lost leaf:
**Alt+X**, with the reason, so it is never used; Alt+U re-opens one cancelled by mistake (neither works
for a date in a locked period). Cancelling
a payment cancels its leaf; deleting a payment frees it unless it was printed. Enter opens the
payment. Change the *as on* date to see the register on an earlier day (a cheque cleared later shows
as issued then); the "Issued, not cleared" total is the same figure as "cheques issued but not
presented" in Bank Reconciliation on that date (optional payments and cheques dated later are listed
but not counted).

### Bulk e-payment file (NEFT / RTGS / IMPS)

Banking › **E-payment File** lists the period's payments by bank transfer (bank line NEFT / RTGS /
IMPS, or no instrument). Tick the ones to pay (Space; Alt+A ticks all that are ready), optionally set
the value date, and press **Ctrl+A** to save a CSV to upload in your bank's net banking (bulk / file
upload). A payment that cannot go in the file says why: no bank details for the payee (Alt+M opens
them), several payees in one voucher, RTGS under ₹2,00,000, IMPS over ₹5,00,000. Payments already
in an earlier file are marked, and Bahi asks before you put them in another (paying twice). If you
cancel the Save dialog, nothing is marked. Optional (memorandum) payments are never listed.

The file is Bahi's own documented layout (beneficiary name, account, IFSC, amount, mode, value date,
remarks and more). Banks' upload formats differ: most let you map the columns of a CSV once; if yours
needs a fixed template, rearrange the columns in Excel the first time and save it as your template.
Careful: Excel drops the leading zeros of account numbers such as 001122334455 when it opens a CSV —
import the account column as *Text*, or upload the file exactly as Bahi saved it.

## Tally export, attachments, voucher numbering and aliases

### Export to Tally (for your CA or auditor)

Most chartered accountants finalise accounts in TallyPrime. **Gateway › Data › Export to Tally** (or
Go To, "Export to Tally") writes your books as a file TallyPrime can import:

1. Tick **Masters** (groups, ledgers with GST, address, bank and bill-wise opening details, units,
   godowns, stock groups and items with opening stock, cost centres, voucher types, aliases) and / or
   **Vouchers of the period**, and enter the period. **Ctrl+A** exports; you choose where to save.
2. Masters alone come as one `.xml` file. With vouchers you get a `.zip` holding `1-Masters.xml` and
   `2-Vouchers.xml` — extract it first (right-click › Extract All); Tally cannot read a ZIP.
3. In TallyPrime, open (or create) the company with the books-beginning date the screen shows under
   **Opening balances as on** and the same GST details, then **Gateway of Tally › Import › Masters**
   with `1-Masters.xml`, then **Import › Transactions** with `2-Vouchers.xml`.
4. Compare the Trial Balance and Stock Summary in Tally with Bahi for the same period (**Alt+B** on the
   export screen opens Bahi's Trial Balance).

**Opening balances.** If you export the vouchers of, say, 2026-27 while your books here began earlier,
the masters carry the balances as on 1-Apr-2026 — every ledger's balance on that day (last year's
profit in the Profit & Loss A/c), the bills still pending (an amount received or paid without a bill
becomes one opening bill called "On Account") and the stock in each godown and batch at its value — so
your CA's Tally company can simply begin on that date. Masters exported on their own, or with vouchers
from your first day, carry the opening balances you entered.

Vouchers go exactly as recorded — the same tax, round-off, numbers, bill references, cost centres,
cheque details and stock lines; nothing is recalculated. The one exception is a Manufacturing Journal or
Material In / Out: its stock lines go at the cost Bahi's stock reports show today, so if a purchase
entered later (back-dated) changed the cost of what was produced, Tally gets the corrected value and
the closing stock agrees. GST on advances received (Alt+J on a receipt), its adjustment on the
invoice and a refund of it come back as advances when the file is imported into Bahi again. Freight or packing that you include in the
goods' taxable value stays on its own ledger, and the freight ledger is marked so that Tally includes
it in the assessable value too. Not exported: quotations, proforma invoices
and physical stock vouchers (the screen tells you how many were left out), e-invoice / e-way bill
details, an export's shipping bill number / date / port code (enter them again in Tally),
attachments, and foreign-currency amounts (exported in rupees). SEZ, deemed-export and UIN
parties arrive in Tally as Regular — set their party type there. For a credit or debit note the
original invoice number and date go in Tally's Reference No. and Date.

The export has been tested by importing it back into an empty Bahi company (same trial balance, stock
summary, GST returns and pending bills); it has not yet been tried against every TallyPrime release,
so the first time import it into a **copy** of the Tally company and check.

### Attaching bills, challans and other papers

Keep the purchase bill scan with the purchase, the signed delivery challan with the sale, the bank
advice with the payment, the agreement with the party's ledger:

- On a voucher, open it (Day Book › **Enter** or **Alt+Enter**) and press **Alt+F**; on a ledger or
  stock item form press **Alt+F**. In the Attachments screen **Alt+C** attaches a file (Windows' own
  file dialog), **Enter** or **Alt+O** opens it in the program Windows uses for it, **Alt+K** saves a
  copy elsewhere, **Alt+D** removes it.
- Allowed: PDF, pictures (JPG, PNG, GIF, WebP, TIFF, BMP), Excel / Word / OpenDocument files without
  macros or ActiveX controls, CSV, TXT, JSON and XML — up to 25 MB each and 50 per voucher or master. Programs, scripts,
  web pages and archives are refused, as is a program renamed to look like a PDF or an XML file that is
  really a web page.
- The files are kept in the company's own folder (under `attachments`), go into every backup (and
  are encrypted with it when the backup has a password), and come back with a restore. **Check Books**
  confirms that every attached file is still there and unchanged.
- Attaching and removing appear in the voucher's or master's edit history (**Alt+H**). Files of a
  voucher in the locked period can be added but not removed. A voucher, ledger or item with files
  cannot be deleted until the files are removed (so a bill scan can never disappear with a deleted
  entry); cancelling a voucher keeps its files.
- **Reports › Attachment Register** lists every attached file with what it belongs to; **Alt+M** opens
  the voucher or master. **Alt+U** removes stored files nothing is attached to any more (left by an
  attach that could not finish) after showing how many and how large — attached files are never
  touched, and the removal is in the edit log.
- Who may do what: Accountants attach and remove, Data Entry users attach, Auditors only view (owners
  can change this in the roles).

### Voucher numbers like INV/26-27/0001

Open the voucher type (**Gateway › Masters › Voucher Types**, or Go To) and in **Numbering**:

- **Prefix / Suffix** may contain codes that are filled in from the voucher date: `{FY}` → `26-27`,
  `{FYYYYY}` → `2026-27`, `{YY}` → `26`, `{MM}` → `04`, `{MMM}` → `Apr`. Example: prefix `INV/{FY}/`,
  zero padding 4, starts again every year → `INV/26-27/0001`, and on 1 April 2027 `INV/27-28/0001`
  without touching the voucher type. The preview under the fields shows the next number.
- **Prefix / suffix from a date** — add a row with an "applicable from" date to change the prefix or
  suffix from that date on (for example a new branch code from 1 October). Leave the text empty to
  stop using a prefix from that date.
- **Starts again**: every year, every month or never. For GST invoices, credit and debit notes a
  monthly restart needs `{MM}` or `{MMM}` in the prefix or suffix, otherwise numbers would repeat
  within the year.
- **GST rule** (CGST Rule 46(b)): a tax invoice number may have at most **16 characters** and only
  letters, digits, `/` and `-`, and must be unique in the financial year. Bahi checks this when you
  save the voucher type, counting each code at its longest (`{FYYYYY}` as 7 characters).
- Changing the numbering never renumbers vouchers already saved.

### Several aliases for a ledger or item

A party may be known by a short name, a Hindi or Gujarati name, or an old code; an item by a supplier's
code or a barcode-less short name. In the ledger or stock item form, **Alias** holds the first one and
**More aliases** takes as many more as you like (one per line, up to 20 in all). Every alias works in
every picker, in Go To and in the lists. Two ledgers (or a ledger and a group) cannot share a name or
alias, and neither can two items. In Excel import / export the **Alias** column holds all aliases
separated by `;`, and Tally import / export keeps them all.

## POS: billing at the counter

For shops that bill walk-in customers: scan, take payment in any mix of cash, card and UPI, give change,
print a receipt — and still have proper GST invoices in your books.

### Turning it on

Press **F11** and turn on **POS invoicing** (under Inventory; it needs *Maintain stock*). Bahi creates a
**POS Sales** voucher type with its own bill numbers (POS/1, POS/2 …), a **POS Return** type for goods
coming back (PR/1 …), a **Cash** payment mode and an **Exchange credit** mode.

Then open **Masters › POS Settings**:

- **Tender modes** (Alt+C): add **UPI** on the bank account your QR code pays into, and **Card** on the
  bank account (or on a "Card Settlements Receivable" ledger if your card machine pays a day later, net of
  charges — move the money to the bank with a Contra or Journal when it arrives).
- **Price level** (with Price levels on): the counter uses that price list, including quantity slabs.
- **Print the receipt after each bill**: on. In **Print Preview › Printer** choose your receipt printer
  once for roll paper — then receipts print straight away without the print dialog.

### Billing a customer

Open **Transactions › POS Counter** (or Go To › "POS"). The cursor waits in the scan box.

1. **Scan** each item. A scanner simply types the barcode and Enter. You can also type the item's part
   number, alias or name. `3*` before a code adds three. Scanning the same item again adds to its line.
2. To change a line, select it with **↑ ↓** and press **+ / −** for quantity, or **Alt+Q** for quantity,
   rate, discount and batch. **Ctrl+D** removes it. **Alt+F** finds an item by name.
3. The big **To pay** figure is the exact bill, GST and round-off included; "You save … on MRP" shows the
   customer's saving on MRP items.
4. Press **Enter** on the empty scan box (or **Ctrl+A**) to **pay**. The whole bill sits on Cash: type the
   cash the customer hands over and press Enter — the bill is saved, the change is shown and the receipt
   prints. To split, type the UPI or card amount on its row (the cash row adjusts) and the reference
   (UTR / last digits of the card).

The bill is one sales voucher: the cash, UPI and card amounts go straight to their ledgers, sales and
GST are credited as for any invoice, and stock goes out.

### Customers and credit

Walk-in customers need no name. For a regular customer press **Alt+U**, type the **mobile number** and
Enter: an existing customer is picked; otherwise type the name (and state) and **Ctrl+A** creates them.
A customer may pay part now — whatever is not paid stays on their account as an outstanding bill. A
walk-in bill must be paid in full.

For a bill of **₹50,000 or more** (taxable value) to a buyer who has no GSTIN, the law asks for the
buyer's name, address of delivery and state on the invoice (CGST Rule 46(e)) — Bahi reminds you to pick
the customer, and to add the address to a customer created at the counter (only name, mobile and state
are taken there). Taking **₹2,00,000 or more in cash** on one bill is not allowed under the Income-tax Act;
Bahi warns before saving.

If a customer from another state takes the goods at your counter, GST is still your state's (CGST +
SGST). If you **deliver** the goods to them in their state, tick "Goods delivered to the customer" on
the counter so the bill charges IGST.

### Hold, recall, reprint

- **Alt+O** puts the bill on hold (the customer went back for one more thing); **Alt+L** lists held bills —
  Enter brings one back, Alt+D discards it.
- **Alt+P** reprints the last bill, **Alt+V** opens it.

### Returns and exchanges

Press **Alt+T** on the counter (or on a POS bill's view), or open **Transactions › POS Return /
Exchange**, and enter the bill number. Type the quantity coming back on each line (**Alt+R** returns
everything), then **Ctrl+A**:

- **Refund** in cash, to the card or by UPI;
- **Exchange credit**: the customer takes other goods instead — the counter opens with the credit
  ready to use on the new bill;
- for a customer, leave it on their **account**.

The return is a credit note against the original bill: the goods come back into stock and the GST is
reversed. Bahi will not let more come back than was sold, nor refund more than the bill charged for
those goods (the return uses the bill's rate and discount). A bill with returns cannot be cancelled until
its returns are cancelled; it can still be altered, but not to sell less than came back, to another
customer or to a date after the return. A return whose exchange credit was already used on a bill keeps
at least that credit. A return dated after **30 November** following the financial year of the sale
gets a reminder: by then GST can no longer be reduced by a credit note (CGST s.34(2)) — ask your
accountant.

If you open a POS bill or return from the Day Book and alter it as an ordinary voucher, its payments
(and the bill it returns) are kept and checked again; to change what was paid, alter the bill on the
counter.

### Day-end

**Reports › POS Day-end Summary** shows, for the working date (or a period): bills, returns, net sales,
GST, what was sold on credit, the **cash** that should be in the drawer, change given, and the split by
payment mode, by cashier and by counter. Type the opening float and the cash you counted to see whether
the drawer tallies. **Ctrl+4** lists every bill and return (Enter opens one); Enter on a payment mode,
cashier or counter lists just their bills. Alt+E exports, Alt+P prints.


## Good to know: backups, locked periods, imports and everyday screens

### A backup folder from another computer must be confirmed here

The backup folder you choose in **F12 › Backup** is stored in the company. When the company arrives on
this computer some other way — restored from a backup made elsewhere, a company folder copied over, or
a data folder shared with another PC — Bahi does **not** write to that folder until you confirm it on
this computer (it could be a network share you never chose here). Meanwhile backups, automatic or not,
go to the default folder inside the data folder. With automatic backups on, a warning says so each time
you open the company; in any case:

- **Data › Backup** shows "Confirm the backup folder" — choose **Confirm folder…** and pick the same
  folder (or another one) in the folder window;
- or in **F12 › Backup** choose **Choose…** and pick it again, or **Use default**.

Confirming needs the right to change the company configuration. A folder inside the data folder never
needs confirming. After upgrading, a backup folder chosen with an older version is confirmed the same
way, once.

### Bank dates in a locked period

When the books are locked up to a date (Company › Lock Books), a bank date on or before that date is
part of a closed reconciliation. Setting, moving or clearing such a bank date — in the BRS, by matching
or unmatching a statement line, by deleting an imported statement with "unmatch", or by deleting,
cancelling or altering (bank ledger or amount) a voucher of the open period whose cheque cleared in the
locked period — needs the right to lock and unlock the books (Owners always have it); others get "Books
are locked up to …". Automatic
matching then leaves the statement lines of the locked period unmatched for such a user. A cheque
written in a locked month that clears in an open month is reconciled as usual.

### "Another task is running in this company"

An Excel or Tally import cannot start while the company is busy with another long task — for example
the automatic backup that runs a few seconds after you open the company or log in, an export, or a
Tally import. The message now offers **Wait and retry**: Bahi tries again every 2 seconds (for up to
2 minutes) and starts the import as soon as the company is free.

### Closing Bahi during a very long operation

Bahi finishes the automatic backup and closes the company before it exits. If one very long database
step is still running (a huge report or backup), closing waits for it, but never longer than about 40
seconds; after that Bahi exits anyway. Nothing saved is lost: an unfinished step is undone the next
time the company opens.

### Smaller changes

- **Debit Note to a customer imported from Tally** — kept for its value and GST only and does not
  reduce stock, the same as a debit note entered in Bahi (a price revision; goods that go out are
  billed on a Sales invoice). Tally reduces stock for such a note, so the import log lists each one.
- **Transactions menu** — voucher types you deactivated in Masters › Voucher Types no longer appear in
  the Gateway's Transactions menu or in Go To (for users who may view masters; for others the list of
  voucher types cannot be read, so they still see every type, as F10 does).
- **Party outstanding** — **Alt+F1** shows or hides settled bills (Alt+H means edit history everywhere).
- **Create ledger** from the dashboard's Get started card opens under Sundry Debtors; from a bank
  statement line it opens under Sundry Debtors (deposit), Indirect Incomes (interest the bank
  credited), Sundry Creditors (payment), Indirect Expenses (bank charges / fees) or Bank Accounts
  (contra). You can still change "Under".
- **Voucher entry** — **Alt+P** right after saving prints the voucher just saved.
- **Get started** — if you hid the card, **Alt+S** on the full dashboard (or the **Show Get started**
  button on the Gateway's dashboard panel) brings it back.
- **Users and roles** — Alt+H on a role shows only that role's history, even when a deleted role once
  had the same number.
