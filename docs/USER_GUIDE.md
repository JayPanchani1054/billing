# Pevqori — User Guide

A practical guide for business owners, accountants and data-entry staff. It follows the order in which
you will meet things: install and open a company, set it up, create masters, enter vouchers, and then
use GST, TDS, banking, reports and the data tools.

**How this guide writes things**

- Keys are shown as they appear on screen: **Ctrl+A** means hold Ctrl and press A.
- Menu paths start at **Home** in its *All menus* view (**Ctrl+2**; earlier versions called it the
  Gateway): *Reports › **Trial Balance*** means the *Trial Balance* item in the *Reports* section of All
  menus. Every menu item can also be found with **Go To** (**Ctrl+G**, **Alt+G** or **Ctrl+K**) by typing
  a few letters of its name.
- *F11 › Inventory › **Batches*** means the *Batches* switch in the *Inventory* group of the
  Features screen (**F11**); *F12 › Checks* means the *Checks* tab of Configuration (**F12**).
- Every screen shows its actions with their keys in the command bar at the top right (**More ▾** lists
  the rest) and a hint in the status line at the bottom. **F1** lists all keys; section 15 of this guide
  has the full reference.
- Pevqori computes from your books. Where a figure goes to a government portal (GST, TDS), compare it with
  the portal before filing — the portal is the legal record.

Things Pevqori deliberately does not do (payroll, direct GST portal APIs, the TDS FVU file, and more) are
listed in [SCOPE.md](SCOPE.md). Installing, upgrading and uninstalling are in [INSTALL.md](INSTALL.md).

## Contents

1. [Getting started](#1-getting-started)
2. [Company, features (F11) and configuration (F12)](#2-company-features-f11-and-configuration-f12)
3. [Masters](#3-masters)
4. [Vouchers](#4-vouchers)
5. [Inventory and manufacturing](#5-inventory-and-manufacturing)
6. [GST](#6-gst)
7. [TDS and TCS](#7-tds-and-tcs)
8. [Banking and cheques](#8-banking-and-cheques)
9. [Outstanding: receivables and payables](#9-outstanding-receivables-and-payables)
10. [Reports and budgets](#10-reports-and-budgets)
11. [Multiple currencies](#11-multiple-currencies)
12. [Printing and sharing](#12-printing-and-sharing)
13. [Data: backup, restore, import, export, attachments](#13-data-backup-restore-import-export-attachments)
14. [Security and users](#14-security-and-users)
15. [Keyboard reference](#15-keyboard-reference)
16. [Troubleshooting and FAQ](#16-troubleshooting-and-faq)

## 1. Getting started

### First launch: the data folder

Install Pevqori as described in [INSTALL.md](INSTALL.md). The first time it starts it asks **where to
keep your data** and suggests `Documents\Pevqori`. Every company you create is a folder inside it.
Choose a folder on a drive you trust (a BitLocker-encrypted drive is ideal) and press **Ctrl+A** (or
*Use this folder*). If you already have Pevqori data (for example copied from another computer), choose
that folder instead.

### Select a Company

With no company open you see **Select a Company** (or *Welcome to Pevqori* when the folder is empty):

| Key | Action |
|---|---|
| **Enter** | Open the highlighted company |
| **Alt+C** | Create a company |
| **Alt+R** | Restore a company from a backup file |
| **Alt+D** (or **Ctrl+D**) | Delete the highlighted company (it is moved to the `trash` folder inside the data folder, never erased) |
| *Change…* (next to the folder name) | Use another data folder — *Move*, *Copy* or *Use* the companies already there (see [INSTALL.md](INSTALL.md#choosing-or-changing-the-data-folder)) |

### Creating a company

**Alt+C** opens the *Create Company* wizard: **Business** (name, name on invoices, address, state,
contact) → **GST and tax** (registration type — regular, composition or unregistered — GSTIN, from which
the state and PAN are filled in, PAN) → **Books** (the month the financial year starts — April for most
Indian businesses — and the date the books begin; opening balances are entered as on that date) →
**Features** (the common switches of F11) → **Security** (protect the company with an Owner username and
password — recommended) → **Review**. **Enter** moves through the fields, **Alt+→** goes to the next
step and **Ctrl+A** creates the company (jumping to any step that still needs attention). Everything can
be changed later. In a hurry? **Create with recommended settings** on the *GST and tax* step goes
straight to the last step (section 2, *Quick setup with recommended settings*).

If the company is password-protected, Pevqori asks for the username and password each time it is opened.

### Home

**Home** is the first screen of an open company (earlier versions called it the Gateway). Its left
column lists what you can open, in one of two views — switch with the *Essentials | All menus* control
at the top, or with **Ctrl+1** / **Ctrl+2**:

- **Essentials** — about twenty everyday tasks in five groups, each with one line saying what it is
  for: **Create** (Sales, Receipt, Purchase, Payment, Create Ledger, Create Stock Item), **Look up**
  (Day Book, Ledgers, Stock Items, Receivables, Payables), **Reports** (Profit & Loss A/c, Balance
  Sheet, Trial Balance, Stock Summary, Cash/Bank Books), **GST** (GSTR-1 and GSTR-3B, or CMP-08 and
  GSTR-4 for a composition dealer) and **Company** (settings, invoice numbering and printing, Features,
  Backup).
- **All menus** — every menu section: **Masters**, **Transactions**, **Banking**, **Utilities**,
  **Reports**, **Inventory Reports**, **GST**, **TDS / TCS**, **Data**, **Security** and **Company**.

Either way, items appear only when the features they need are on and you have the permission to use
them. Use **↑ ↓** and **Enter**, or press the item's highlighted letter. Voucher items show their function
key instead (F8 for Sales, …). A new installation starts on Essentials; if you used Pevqori before 2.0,
Home keeps All menus and the shortcut bar you know, and offers once to *Try the simpler Home*. Your choice
is remembered on this computer.

On the right is the **dashboard**: four tiles — To collect, To pay, Cash & bank and Sales this month —
what needs your attention and your last five vouchers, with *Show more insights* for the rest, plus a
**Get started** card for a new company (section 2, *Get started and the Home dashboard*; Alt+S on the
full dashboard, *Reports › **Dashboard***, brings the card back if you hid it). A user who may not see
the dashboard gets a short greeting instead.

### The top bar, the screen bar and the status bar

- **Top bar** (left to right): the company button (name and financial year; its menu has *Switch company*
  **F3**, *Company details* and the GSTIN), the working date (**F2**) and period (**Alt+F2**), the search
  box *Search or jump to…* (Go To, **Ctrl+G**), **Create ▾** (Sales invoice, Receipt, Purchase, Payment,
  Credit note, Customer, Supplier, Item, Other voucher… — each with its usual key; it lists only what you
  may create), the gear (the
  *Settings* screen, when available), **?** (every key, **F1**) and your initials (the user menu).
- **Screen bar**: where you are on the left (*Home › Day Book* — click a step to go back to it) and, on
  the right, the **command bar** of the screen: its main action as a filled button, the next most useful
  ones beside it, and **More ▾** with every other action of the screen and its key (plus Features F11,
  Configure F12 and Help F1). The buttons only show what the keys do — every key works the same whether
  or not a button shows it.
- **Shortcut bar** (optional): a column at the right listing every action of the screen with its key, as
  in earlier versions. Turn it on or off with *Show shortcut bar* in the user menu.
- **Status bar**: a hint for the screen, whether everything is saved (point at it to see the data folder)
  and the version.

### Moving around

- **Esc** goes back one screen (asking first if you typed something). The breadcrumb at the top shows
  where you are; each screen opens on top of the one before it.
- **Go To** (**Ctrl+G**, **Alt+G** or **Ctrl+K**) finds any screen, report, ledger, stock item or
  voucher (by number, party, reference, narration or exact amount).
- **F2** changes the *working date* — the default date of new vouchers and of "as on" reports.
  **Alt+F2** changes the *period* used by reports.
- In any date box: **t** is today, **5** the 5th of this month, **5-10** 5 October, **+** / **−** move
  a day; **Alt+↓** opens the calendar.
- **F3** switches company (Pevqori closes the current one, running the automatic backup first if one is
  due). **Ctrl+Q** quits.
- **F1** (or **Ctrl+H**) shows every key. The menu behind your initials (top right) also has the
  theme (match Windows, light, dark), density (comfortable / compact), the Home view, *Show shortcut
  bar*, *Appearance…* (all four in one panel), *About Pevqori* and — for a password-protected company —
  *Change password*, *Lock* and *Log out*.
- **Ctrl+S** saves wherever **Ctrl+A** accepts or saves (forms, voucher entry, dialogs).

## 2. Company, features (F11) and configuration (F12)

### Settings: every setting in one place

The gear in the top bar (or *Company › **Settings*** on Home, or Go To "settings") opens **Settings**:
topics on the left, the settings of the chosen topic on the right, each with one line saying what you
change there and — where it is known — how it is set now (*Modern template*, *Not locked*, *No backup
folder chosen*…). Choosing a setting opens its usual screen; **Esc** brings you back to Settings.

| Topic | Settings |
|---|---|
| Business | Company details · Features (**F11**) · Configuration (**F12**) |
| Invoices & printing | Invoice printing · Invoice numbering · Voucher types (every option, for experts) |
| GST & TDS | GST settings (the GST tab of F12) · TDS / TCS setup |
| Banking & cheques | Cheque printing settings · Cheque books · Payee bank details |
| Users & security | Users & roles · Security settings · Lock books · Change password |
| Data & backup | Backup · Automatic backups · Restore a backup · Import from Excel · XML data import · Export data · XML data export · the data folder (*Show in folder*) |
| Modules | POS settings · Multi-currency settings |
| Appearance | Theme, density, Home view and the shortcut bar — right on the page, for you on this computer |
| About & updates | About Pevqori and updates |

You only see what you may open: a setting of a feature that is off (F11), or one your role does not
allow, is not listed, and a topic with nothing left disappears. The search box at the top has the focus
when Settings opens (**Ctrl+F** returns to it): type a word — *logo*, *prefix*, *password*, *backup* —
to list the matching settings of every topic, **↓** to move into the list and **Enter** to open one.
In the topic list **↑ ↓** choose a topic and **→** (or **Enter**) moves to its settings; **←** goes back.
Typing a letter while a list has the focus continues in the search box.

### Company details

*Company › **Company Details*** holds the business name and name on invoices, address and contact,
the GST registration (type, GSTIN), PAN, TAN, CIN, the financial year and books beginning, and the
logo printed on invoices. The GST registration decides what the GST menu shows: a composition dealer
sees CMP-08 and GSTR-4 instead of GSTR-1 and GSTR-3B (section 6.8).

### Features (F11)

**F11** (*Company › **Features***) switches parts of Pevqori on and off. A switch that needs another one
says so ("Turn on Batches first").

| Group | Features |
|---|---|
| Accounting | **Bill-wise details** (on by default), **Cost centres**, **Interest calculation**, **Multiple currencies**, **Cheque printing** |
| Inventory | **Maintain stock** (on by default), **Stock value in accounts** (closing stock in the P&L and Balance Sheet from your stock records), **Multiple godowns**, **Batches**, **Expiry dates**, **Sales and purchase orders**, **Delivery and receipt notes**, **Rejection notes**, **Actual and billed quantity**, **Price levels**, **Discount column on invoices**, **Bill of materials and manufacturing**, **Job work** (needs Multiple godowns), **POS invoicing (counter billing)** |
| Taxation | **GST** (on by default; creates the GST tax ledgers), **e-Invoicing**, **e-Way Bill**, **TDS**, **TCS** |
| Security | **Password protection** — turned on or off under *Security › **Security Settings*** because it needs the Owner's password (section 14) |

Turning a feature off hides its menus and screens; the data already entered stays.

### Configuration (F12)

**F12** (*Company › **Configuration***) has five tabs:

- **Invoices** — round-off of invoice totals (nearest / always up / always down, to ₹0.10, ₹0.50, ₹1,
  ₹5 or ₹10) and a summary of the invoice printing settings (**Alt+I** opens *Company › **Invoice
  Printing***, section 12).
- **GST** — return filing frequency (monthly, or quarterly under QRMP), HSN digits in GSTR-1 (4 or 6
  by turnover; 8 if you prefer), your LUT number and validity for exports without IGST, and the B2CL and
  e-way bill limits.
- **Checks** — what happens when an entry would sell more stock than you have, take cash below zero,
  take a party over its credit limit, or repeat a supplier's bill number: **Allow**, **Warn** (ask before
  saving) or **Block**. The **Locked period** is shown here too.
- **Display** — show zero balances, and the date style (05-Oct-2026 or 05-10-2026).
- **Backup** — automatic backups, how many to keep and the backup folder (section 13.1).

Inside voucher entry, **F12** opens the settings of that voucher type and the F12 options that affect it.

### Locking the books

*Company › **Lock Books*** (or *F12 › Checks › Lock or unlock…*) stops anyone from creating, altering
or deleting vouchers dated on or before a date — typically after filing returns or finalising the year.
It needs the *lock and unlock the books* permission (Owners always have it). Bank dates of a locked
period are protected too (section 8.1), as are opening balances when the lock reaches the books
beginning.

### Quick setup with recommended settings

On the *GST and tax* step of *Create Company*, **Create with recommended settings** skips the next three
steps and goes straight to *Check and create* with what suits most businesses: the financial year April
to March of the current year with the books beginning on 1 April, *Maintain stock* and *Bill-wise
details* on, and password protection on with the Owner username *owner*. On that path the password
switch and fields are on the *Check and create* page itself: type a password (twice), or switch
protection off, and press **Create company** (**Ctrl+A**). A step you had already opened keeps what you
chose there, and *Change* next to any section — or **Back** — still opens every step. The usual *Next*
path is unchanged. Everything can be changed later (F11, F12, *Security Settings*).

### Get started and the Home dashboard

On Home, the right-hand panel shows your business in four tiles — **To collect** (what customers owe
you, and how much of it is overdue), **To pay** (what you owe suppliers), **Cash & bank** and **Sales
this month** (against the same month last year) — then **Needs your attention** (overdue bills, GST
due, low stock, backups…) and your last five vouchers. Click a tile or a line to open the report behind
it. **Show more insights** adds the sales and purchases chart, receivables ageing, the cash and bank
accounts, the GST estimate and the cards of the features you use; Pevqori remembers whether you left it
open. *Full dashboard* (or *Reports › **Dashboard***) shows everything on one page.

Until your company is set up, a **Get started** card lists the first steps, each with a button that
opens the right screen: check your company details, switch on the features you need (F11), **set your
invoice number series** (*Invoice Numbering*), **choose what prints on your invoice** (*Invoice
Printing*), add your customers, suppliers and bank, add the items you sell, record your first sale
(F8), **record a payment** you receive (*Receipt*, F6) and set up backups — plus, while the books are
empty, importing from another accounting program. A step ticks itself off when the books show it is
done (for example once a receipt exists, or once the Sales series has a prefix, a padding width or
another starting number); you can also tick a step by hand (*Mark as done*) or *Hide* the card (*Show
Get started* brings it back).

## 3. Masters

Masters are created from the Gateway (*Masters* section), from Go To, or from inside any picker with
**Alt+C** — type a name that does not exist yet in a ledger or item field and press Alt+C to create it on
the spot; it is then selected for you.

### 3.1 Groups and ledgers

- *Masters › **Groups*** — the 28 predefined groups (Capital Account, Current Assets, Sundry Debtors,
  Duties & Taxes, Sales Accounts, …) and your own sub-groups. **Alt+C** creates under the highlighted
  group.
- *Masters › **Ledgers*** — every account: parties, banks, sales and purchase ledgers, expenses, taxes.
  Chips filter parties, cash and bank, sales, purchase, duties and taxes, income and expense. **Alt+C**
  creates, **Alt+B** creates several at once (*Masters › **Multiple Ledgers***), **Alt+D** deletes (a
  ledger with vouchers cannot be deleted — Pevqori explains and offers to deactivate it), **Alt+H** shows its
  edit history, **Alt+T** opens the *Masters › **Chart of Accounts***.
- *Masters › **Create Ledger*** opens the form directly. The form shows only the sections that fit the
  group: opening balance (Dr / Cr); bill-wise details with opening bills (they must add up to the
  opening balance) and the credit period; party details and GST registration for debtors and creditors
  (a valid GSTIN fills in the state, PAN and registration type); bank details for bank accounts; tax type
  and duty head for Duties & Taxes; GST details (taxability, rate, HSN/SAC, input credit, reverse charge)
  for sales, purchase, income, expense and fixed-asset ledgers, with an "applies from" date when a rate
  changes; and other settings (cost centres, TDS / TCS). The currency (with F11 multiple currencies) is in the
  basic section. **Ctrl+A** saves and starts the next
  ledger in the same group; **Alt+S** saves and closes.
- *Masters › **Opening Balances*** lists every opening balance with the Dr and Cr totals and explains
  any difference (with *Stock value in accounts* on, the opening stock is part of it).
- *Masters › **Cost Centres*** (with F11 cost centres) — categories and centres; allocate amounts on
  ledger lines with **Alt+O** in voucher entry.
- *Masters › **Currencies*** (with F11 multiple currencies) — section 11.

**Several aliases.** A party may be known by a short name, a Hindi or Gujarati name, or an old code; an
item by a supplier's code. In the ledger or stock item form, **Alias** holds the first one and **More
aliases** takes more (one per line, up to 20 in all). Every alias works in every picker, in Go To and in
the lists. Two ledgers (or a ledger and a group) cannot share a name or alias, and neither can two
items. In Excel import / export the **Alias** column holds all aliases separated by `;`, and XML data
import / export keeps them all.

### 3.2 Stock masters

With F11 *Maintain stock* on:

- *Masters › **Stock Items*** (and *Masters › **Create Stock Item***) — name, aliases, part number,
  barcode, description, stock group and category, unit (and an alternate unit), whether it is a service,
  GST details (inherited from the group or its own, with dated history), whether prices include GST,
  **MRP**, selling, purchase and standard prices, the costing method (average cost by default; FIFO,
  LIFO, last purchase cost, standard cost), reorder level and minimum order quantity, batches with
  manufacturing / expiry dates, price levels and the opening stock. **Ctrl+A** saves and starts the next
  item with the same group, unit and GST; **Alt+S** saves and closes.
- *Masters › **Multiple Stock Items*** — a grid to create many items at once (all or none are saved).
- *Masters › **Stock Groups***, *Masters › **Stock Categories*** — trees for grouping and reporting.
- *Masters › **Units of Measure*** — simple units with the GST unit code (UQC) suggested from the
  symbol, and compound units such as "1 Box = 12 Nos" (**Alt+U**).
- *Masters › **Godowns*** (with F11 multiple godowns) — locations; *Main Location* always exists. With
  Job work on, *Whose stock* says whether a godown holds your goods at a job worker or a principal's goods
  with you (section 5.3).
- *Masters › **Price Lists*** (with F11 price levels) — per price level and "applicable from" date,
  quantity slabs with a rate and discount.

### 3.3 Voucher types and numbering

*Masters › **Voucher Types*** lists the predefined types (Sales, Purchase, Payment, …) and your own.
For prefixes, the next number and a yearly restart the simpler *Company › **Invoice Numbering*** screen
(section 3.4) is enough; the voucher type form keeps every option.
**Alt+C** creates a type based on the highlighted one — for example *Cash Sales* or *Export Invoice*
with its own series. A predefined type you deactivate disappears from the Transactions menu and Go To.

In **Numbering** (the preview under the fields shows the next number):

- **Prefix / Suffix** may contain codes filled in from the voucher date: `{FY}` → `26-27`, `{FYYYYY}` →
  `2026-27`, `{YY}` → `26`, `{MM}` → `04`, `{MMM}` → `Apr`. Example: prefix `INV/{FY}/`, zero padding 4,
  starts again every year → `INV/26-27/0001`, and on 1 April 2027 `INV/27-28/0001` without touching the
  voucher type.
- **Prefix / suffix from a date** — add a row with an "applicable from" date to change the prefix or
  suffix from that date on (for example a new branch code from 1 October). Leave the text empty to stop
  using a prefix from that date.
- **Starts again**: every year, every month or never. For GST invoices, credit and debit notes a monthly
  restart needs `{MM}` or `{MMM}` in the prefix or suffix, otherwise numbers would repeat within the year.
- **GST rule** (CGST Rule 46(b)): a tax invoice number may have at most **16 characters**, only letters,
  digits, `/` and `-`, and must be unique in the financial year. Pevqori checks this when you save the
  voucher type, counting each code at its longest (`{FYYYYY}` as 7 characters). A number typed by hand on
  an invoice is checked when the invoice is saved: a warning you confirm (for numbers carried over from an
  older system), listed again by the GSTR-1 and e-invoice checks.
- Changing the numbering never renumbers vouchers already saved; a voucher keeps its number when its
  date is altered.

The voucher type also holds its defaults: party, godown, invoice mode, the title, template, MRP
column, bank details, declaration and terms printed on the document, and whether it prints after saving.

### 3.4 Invoice numbering

*Company › **Invoice Numbering*** (also on Home, in Settings › Invoices & printing and in Go To — type
"invoice number", "prefix" or "series") is the simple way to set up your number series. It lists every
series — one per voucher type — with an example number for today, when it starts again, the **next
number** and how many vouchers it has this period. *Invoices & notes* (sales, credit and debit notes)
come first; *Other vouchers* are folded away (→ or Enter opens the group).

Highlight a series and press **Enter** (or **Alt+A**) to change it:

- **Prefix / Suffix** — click a code to insert it where the cursor was in the prefix or suffix (at
  the end of the prefix when you have not been in either): *FY 26-27* (`{FY}`), *2026-27*
  (`{FYYYYY}`), *YY*, *MM*, *Mon* (`{MMM}`). Example: prefix `INV/` + *FY* + `/`, **Digits** 4 →
  `INV/26-27/0001`.
- **Digits** (zeros in front) and **Start at**.
- **Start again from the first number every financial year** — on by default. Turned off, the numbers
  keep running across years; for GST invoices and notes Pevqori still checks that a number is used only
  once in each financial year. After such a change the next number continues after the numbers already
  used, so the preview shows *the next number is worked out when you save* and the message after saving
  shows it.
- **Advanced** — *Start again every month* (for a GST series the month must be part of the number: the
  **Add month to prefix** button does it, e.g. `INV/{FY}/{MM}/`), and how numbers are given: automatic,
  automatic but can be typed while entering, typed by hand, or no numbers. *More options* opens the full
  voucher type (dated prefix / suffix, behaviour, printing).
- **Next number** — the number the next voucher gets, e.g. 41 to continue from a paper bill book.
  **Set** applies it at once (Save does too). It cannot go below **Start at**. Lowering it below a number
  already used asks you to confirm (used numbers are skipped automatically); jumping ahead asks too,
  because the skipped numbers are never issued (report them in GSTR-1 Table 13). Changing the next number needs the *Change voucher numbers and the next
  number* permission (Owner and Accountant), and it is recorded in the edit log of the voucher type.
- The **preview** shows today's number, the first number of the next financial year and the longest
  number; *Valid GST invoice number* or the problem (more than 16 characters, characters GST does not
  allow, a monthly restart without the month) is shown before you save. **Gaps** lists the numbers of
  this financial year that no voucher carries (**Show** lists up to 200).

**Ctrl+A** (or **Ctrl+S**) saves, **Esc** closes (asking first when something was changed). Numbers
already given never change.

**Create series** (**Alt+C**) adds a series based on the highlighted one — for example *Cash Sales*
with the prefix `CS/` — as a voucher type of its own. Choose it with **F10** (*Other vouchers…*) when
entering a voucher. **Alt+H** shows the edit history of the highlighted series.

## 4. Vouchers

### 4.1 Voucher types and their keys

| Key | Voucher | Notes |
|---|---|---|
| **F4** | Contra | Cash ↔ bank, bank ↔ bank |
| **F5** | Payment | Money paid (at least one credit to cash or bank) |
| **F6** | Receipt | Money received |
| **F7** | Journal | Adjustments, provisions, depreciation |
| **F8** | Sales | Tax invoice (item or accounting invoice) |
| **F9** | Purchase | Supplier's bill |
| **Ctrl+F8** | Credit Note | Sales return / reduction in value |
| **Ctrl+F9** | Debit Note | Purchase return / increase in value |
| **Alt+F5** | Sales Order | Needs F11 *Sales and purchase orders* |
| **Alt+F6** | Purchase Order | Needs F11 *Sales and purchase orders* |
| **Alt+F8** | Delivery Note | Goods sent before the invoice (needs *Maintain stock*) |
| **Alt+F9** | Receipt Note | Goods received before the bill (needs *Maintain stock*) |
| **Ctrl+F6** | Rejections In | Goods returned by a customer (needs *Rejection notes*) |
| **Ctrl+F5** | Rejections Out | Goods returned to a supplier (needs *Rejection notes*) |
| **Alt+F7** | Stock Journal | Transfers between godowns, consumption, conversion |
| **Ctrl+F7** | Physical Stock | Counted stock |
| **Ctrl+F10** | Memorandum | A provisional entry that never touches the books |
| **F10** | Other vouchers… | Picks any other type: Reversing Journal, Quotation, Proforma Invoice, Manufacturing Journal, Material In / Out, POS Sales and your own types |

The same voucher types are in *Transactions* on the Gateway (for example *Transactions › **Sales***).
A key whose feature is off tells you which F11 switch to turn on. While entering a voucher you can press
another voucher key (or F10) to switch type; the date is kept.

### 4.2 Entering a voucher

- **Enter** moves to the next field or cell and **Shift+Enter** back. Enter on an empty grid row moves on
  to the next part (items → additional ledgers such as freight or discounts → narration); Enter in the
  narration asks *Accept?*. **Ctrl+A** saves at any time. **Esc** leaves (asking first).
- **F2** inside voucher entry changes the voucher date. Back-dated vouchers need the *create / alter
  vouchers dated before today* permission when security is on.
- **Alt+I** switches a sales / purchase / note between **item invoice** (stock items with quantity and
  rate) and **accounting invoice** (ledgers only, for services or for a credit note that only reduces the
  price). **Ctrl+H** switches a payment, receipt or contra between **single entry** (one cash / bank
  account at the top) and the **Dr / Cr** layout.
- **Ctrl+I** opens *More details*: buyer and consignee, dispatch and e-way bill details, order
  references, export details (shipping bill, port, LUT or with IGST) and the effective date. On a sales
  invoice (and the other documents you issue: credit notes, sales orders, delivery notes, quotations)
  the buyer's **Reference no.**, **Reference date** and **Reverse charge** are on its first tab,
  *Reference*; once one of them holds a value it also shows in the voucher header. A purchase keeps the
  *Supplier invoice no. / date* and *Reverse charge* in the header — input credit is matched on them.
- **Place of supply** shows as a chip such as *Gujarat (24) · intra-state ✎* when Pevqori can work it
  out from the party (and the consignee). Click it (or Tab to it and press Enter) to choose another
  state; a party without a state, or an overseas party, shows the list straight away.
- **Alt+T** fills an invoice from open delivery / receipt notes or orders of the party, so the goods are
  not moved twice and the order shows what is still pending.
- **Alt+B** opens the **bill-wise** details of the line (or of the invoice party): on a receipt or
  payment the oldest pending bills are settled first and the rest stays *On Account*; **Alt+F** in the
  dialog re-runs that allocation. An invoice creates a new bill named after its number (purchase: the
  supplier's invoice number) with the party's credit period.
- **Alt+O** allocates the line to cost centres; **Alt+K** records the bank instrument of a bank line —
  cheque (number filled from the cheque book, section 8.2), DD, NEFT / RTGS / IMPS, UPI, card.
- **Ctrl+B** puts the Dr / Cr difference on the last line. **Ctrl+D** removes a line, **Alt+N** /
  **Ctrl+N** inserts one above.
- **Ctrl+L** makes the voucher **optional** (kept, numbered, but not in the books); **Ctrl+T** makes it
  **post-dated** (it joins the books on its date;
  *Transactions › **Post-dated Vouchers*** lists them).
- **Alt+J** GST details (advances, bill of entry, challans, ITC reversals — section 6.4), **Alt+U** TDS /
  TCS (section 7), **Alt+Y** foreign currency (section 11). Files are attached from the saved voucher's
  view with **Alt+F** (section 13.6).
- **Alt+C** in a picker creates the ledger or item you typed, under the group that fits the place
  (Sundry Debtors for a customer, Sales Accounts for a sales ledger, …). In the party field a small
  **Create customer** (or *Create supplier*) dialog opens: name, GSTIN (a valid GSTIN fills the state
  and PAN), state, mobile, e-mail and billing address — **Ctrl+A** creates the party and puts it on the
  invoice. *Full form…* opens the complete ledger form instead.
- **Ctrl+R** changes the **voucher number** — for example to match a paper bill book. Type the new
  number: it is checked as you type (a GST invoice number has at most 16 letters, digits, '/' and '-',
  and must not be used again in the same financial year), add a reason for the edit log and, when the
  number is in the series' format, tick *Continue the series from here* so the next invoices follow it.
  The number shows in the *No.* field with a **changed** badge and is used when you save. Needs the
  *Change voucher numbers and the next number* permission (the Owner and Accountant roles have it).
- **F12** shows the settings of this voucher type.

Totals, GST and round-off are worked out as you type with the same rules the books use. When you pause
and the voucher looks complete, Pevqori checks it on the server: warnings appear in the **Checks** panel
and on the rows (negative stock, credit limit, duplicate supplier bill, GST questions, TDS thresholds …).
Warnings marked *confirm* are asked about when you save; *block* ones must be fixed. The F12 › Checks
tab decides which checks warn and which block.

After saving, a message shows the voucher number and amount and the screen is ready for the next voucher
of the same type, keeping the date. A **Saved bar** above the new voucher repeats it — *✓ Saved Sales
INV/26-27/0042 · ₹ 11,800.00* — with **Print** (Alt+P), **Share** (Alt+W, by e-mail or WhatsApp) and,
after a sales invoice to a customer, **Record payment**: it opens a Receipt with the customer already on
the first line, so you only type the amount (after a purchase it opens a Payment to the supplier). The
bar goes away when you start the next voucher or press ×. **Alt+P** prints the voucher just saved (or
the one being altered) and **Alt+W** shares it.

**Sales invoices in short.** Party (or a cash ledger for cash sales), then items with quantity, rate and
discount; GST is CGST + SGST within your state and IGST for another state, exports and SEZ, based on the
place of supply (the consignee's state for goods, else the buyer's). Additional ledgers (freight,
packing, discount, round-off) go below the items. The party is debited with the grand total, the sales
ledger credited with the taxable value and the output tax ledgers with the tax. A purchase is the mirror
image with input tax; a reverse-charge purchase posts the tax to the input ledgers and the reverse-charge
liability instead of to the supplier.

**Credit and debit notes.** An item credit note always brings the goods back (a sales return); for a
price reduction on goods the customer keeps, use the accounting invoice mode. A debit note to a supplier
with items returns the goods; a debit note to a customer (an upward price revision) is for value and GST
only and never moves stock. Enter the original invoice number and date (Ctrl+I) — GSTR-1 needs them.

**Physical Stock** records what you counted; Pevqori posts the difference from the books on that date. If
you later enter a voucher dated before the count, save the physical stock voucher again so that it
re-reads the book quantity.

### 4.3 Day Book, viewing, altering, cancelling

*Transactions › **Day Book*** shows every voucher of the working date (it follows F2) or of a period
(**Alt+F2**; **Alt+T** back to today). **Enter** or **Alt+A** alters the highlighted voucher,
**Alt+Enter** views it read-only, **Ctrl+P** prints it, **Alt+P** prints the Day Book itself, **Alt+2**
duplicates it and **Alt+D** deletes it.

The read-only view (Alt+Enter, or Enter on any report row that is a voucher) shows the header, party,
items, Dr / Cr entries with bills, cost centres and bank details, GST by rate, e-invoice / e-way bill
details and who created and changed it. Its keys: **Alt+A** alter, **Alt+P** print, **Alt+W** share
(section 12.4), **Ctrl+R** change the number, **Alt+2** duplicate, **Alt+X** cancel, **Alt+D** delete,
**Alt+H** edit history, plus the
panels other features add (Alt+F attachments, Alt+K print cheque, Alt+T POS return, Alt+U TDS / TCS,
Alt+Y currency, Alt+V / Alt+O convert a quotation, Alt+S quotation status, Alt+R make recurring, Alt+L
pre-close an order).

- **Cancel** (Alt+X, with a reason) keeps the voucher and its number but takes it out of the books — the
  right choice for an invoice number that must stay in the series.
- **Delete** (Alt+D) removes it. A voucher with attached files, a GST document of a filed GSTR-1 period,
  a POS bill with returns and some other linked vouchers cannot be deleted; the message says why and what
  to do instead.
- **Change number** (Ctrl+R, with the *Change voucher numbers* permission) gives a saved voucher another
  number without opening it for alteration: the same checks as in voucher entry, an optional reason,
  and — when the GSTR-1 of its period is already filed — the usual *Please check before saving* question
  (the change is then reported as an amendment). The amounts, GST and stock of the voucher do not
  change. A cancelled voucher or one with an e-invoice (IRN) keeps its number.
- Every create, alter, cancel and delete is recorded in the edit log (Alt+H shows the voucher's history;
  a changed number shows as *Number change* with the old and new number and the reason).
- Vouchers dated on or before the locked date cannot be created, altered or deleted (section 2).

A voucher whose e-invoice (IRN) has been generated opens read-only: cancel the IRN first (section 6.3).

### 4.4 Orders, notes and pending bills

With F11 *Sales and purchase orders*, a **Sales Order** (Alt+F5) or **Purchase Order** (Alt+F6) records
what was ordered. Delivery notes, receipt notes and invoices pick up order lines with **Alt+T**;
*Inventory Reports › **Pending Sales Orders*** and *Inventory Reports › **Pending Purchase Orders*** show
what is still to be delivered or received, with due dates and overdue marks (**Alt+C** creates an
order).

**Sales Bills Pending and Purchase Bills Pending.** *Inventory Reports › **Sales Bills Pending*** lists
delivery notes (and rejections in) whose goods have gone out but are not fully invoiced;
*Inventory Reports › **Purchase Bills Pending*** lists receipt notes (and rejections out) whose supplier
bills you have not entered. You see the quantity, what is billed, what is pending, the value and the age of each
line, and the total by age (0–7, 8–30, 31–90, over 90 days).

- Ctrl+4 / Ctrl+5 group the list by party or by item; Enter on a group shows its lines.
- **Alt+I** (*Invoice now* / *Enter bill*) opens the invoice already filled with the pending quantities
  and linked to the note — stock is not moved twice.
- Why it matters: for a taxable sale of goods the invoice is due before or at the time the goods leave
  (CGST Act s.31). A delivery challan is meant for job work, goods on approval and similar movements
  (CGST Rule 55). The dashboard warns about delivery notes unbilled for more than 7 days (7 days is
  Pevqori's reminder, not a legal limit; rejections waiting for a credit note are not counted).

**Pre-closing an order.** When a customer cancels the rest of an order (or a supplier will not deliver
it), don't alter the order — **pre-close** it: Alt+L on the pending orders report or on the opened order.
Choose the quantity per item (the whole balance by default), the date and the reason. The balance leaves
the pending-order reports and the "From orders" list from that date; the order itself is unchanged. The
order's view shows what was closed, by whom and why, with **Reopen order** to undo it.

### 4.5 Quotations and proforma invoices

A **quotation** is your price offer; a **proforma invoice** asks the customer for an advance before you
supply. Neither touches your books, stock or GST returns, and each has its **own number series** — so
your GST invoice numbers stay consecutive (CGST Rule 46).

- **Create:** *Transactions › **Quotation*** or *Transactions › **Proforma Invoice*** (or F10, or Go
  To). Enter the party and items as on a sales invoice — GST is worked out for printing — and a **Valid
  until** date.
- **Print:** Alt+P. The title reads *Quotation* or *Proforma Invoice*; a proforma always says
  **"This is not a tax invoice"** and prints your bank details / UPI QR for the advance.
- **Track:** *Reports › **Quotation Register*** shows every document with its status — *Open*,
  *Accepted*, *Rejected*, *Expired* (open past its validity), *Converted* or *Cancelled* — the value by
  status and your conversion rate. Ctrl+1 / Ctrl+2 switch between quotations and proforma invoices.
- **Record the customer's answer:** Alt+S → Accepted, or Rejected with a reason (price, delivery time …).
- **Convert with one key:** on the register or the opened document, **Alt+V** makes a Sales Invoice and
  **Alt+O** a Sales Order (quotations only; needs Sales and purchase orders in F11). The new voucher opens
  filled in; check it and save. The quotation then shows *Converted* with a link to the invoice — it
  cannot be converted twice (cancel or delete the invoice first if you need to). The invoice can never be
  dated (or later altered to a date) before its quotation, nor the quotation moved after its invoice.
- **Duplicate (Alt+2)** a quotation to re-quote: the copy is dated today and keeps the same validity
  length (a 15-day offer stays a 15-day offer).

### 4.6 Recurring vouchers (rent, retainers, AMC, EMIs)

1. Open a saved voucher (e.g. this month's rent journal or a retainer invoice) and press **Alt+R**
   (*Make recurring*), or go to *Masters › **Recurring Vouchers*** › Alt+C and pick the voucher.
2. Choose how often: monthly, quarterly, half-yearly, yearly or every N days; the day of the month
   (*Last day of the month* for month-end entries — the 31st falls on 30-Apr and 28/29-Feb); the first
   posting date and, if it ends, the last. If the voucher has one amount you can change it here.
3. Write `{period}` in the narration to get "Rent for May 2026" in each posting (`{date}` and `{fy}` work
   too).

Pevqori never posts behind your back. When you open the company, a notice says **"N recurring vouchers are
due"** (it is also on the dashboard). Press *Review & post*, or *Transactions › **Due Recurring
Vouchers***:

- Everything due up to the working date (F2) is ticked. **Space** (or Alt+T) unticks a line, **Alt+O**
  changes the amount for this posting only, **Alt+S** skips it (with a reason), **Enter** opens it in
  voucher entry to change anything before saving.
- **Ctrl+A** posts the ticked vouchers. Each becomes an ordinary voucher with its own number, in the Day
  Book and the edit log. A month can never be posted twice; if you delete a posted voucher, that month
  becomes due again.
- Pause a template (Alt+S on the list) when the arrangement stops for a while.
- Changing a template's day of the month or end date is always safe. If you change *how often* it runs
  (say quarterly to monthly, or every 7 days from another date), Pevqori asks you to start the new schedule
  on or after the date the old one would have posted next — so a month, quarter or week already posted
  is never billed again.

### 4.7 Memorandum, optional and reversing journals

A **Memorandum** voucher (Ctrl+F10) and an **optional** voucher (Ctrl+L) never change the books. A
**Reversing Journal** (F10 › Reversing Journal) is a provisional entry — for example a month-end
provision for an unbilled expense. Give it an **Applicable up to** date: it counts in provisional reports
(scenarios, section 10.3) only up to that date.

### 4.8 POS: billing at the counter

For shops that bill walk-in customers: scan, take payment in any mix of cash, card and UPI, give change,
print a receipt — and still have proper GST invoices in your books.

**Turning it on.** Turn on *F11 › Inventory › **POS invoicing (counter billing)*** (it needs *Maintain
stock*). Pevqori creates a **POS Sales** voucher type with its own bill numbers (POS/1, POS/2 …), a **POS
Return** type for goods coming back (PR/1 …), a **Cash** payment mode and an **Exchange credit** mode.
Then open *Masters › **POS Settings***:

- **Tender modes** (Alt+C): add **UPI** on the bank account your QR code pays into, and **Card** on the
  bank account (or on a "Card Settlements Receivable" ledger if your card machine pays a day later, net of
  charges — move the money to the bank with a Contra or Journal when it arrives).
- **Price level** (with Price levels on): the counter uses that price list, including quantity slabs.
- **Print the receipt after each bill**: on. In the print preview's printer choice pick your receipt
  printer once for roll paper — then receipts print straight away without the print dialog.

**Billing a customer.** Open *Transactions › **POS Counter*** (or Go To › "POS"). The cursor waits in
the scan box.

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

**Customers and credit.** Walk-in customers need no name. For a regular customer press **Alt+U**, type
the **mobile number** and Enter: an existing customer is picked; otherwise type the name (and state) and
**Ctrl+A** creates them. A customer may pay part now — whatever is not paid stays on their account as an
outstanding bill. A walk-in bill must be paid in full.

For a bill of **₹50,000 or more** (taxable value) to a buyer who has no GSTIN, the law asks for the
buyer's name, address of delivery and state on the invoice (CGST Rule 46(e)) — Pevqori reminds you to pick
the customer, and to add the address to a customer created at the counter (only name, mobile and state
are taken there). Taking **₹2,00,000 or more in cash** on one bill is not allowed under the Income-tax
Act; Pevqori warns before saving.

If a customer from another state takes the goods at your counter, GST is still your state's (CGST +
SGST). If you **deliver** the goods to them in their state, tick "Goods delivered to the customer" on the
counter so the bill charges IGST.

**Hold, recall, reprint.** **Alt+O** puts the bill on hold (the customer went back for one more thing);
**Alt+L** lists held bills — Enter brings one back, Alt+D discards it. **Alt+P** reprints the last bill,
**Alt+V** opens it, **Alt+Z** clears the bill on screen.

**Returns and exchanges.** Press **Alt+T** on the counter (or on a POS bill's view), or open
*Transactions › **POS Return / Exchange***, and enter the bill number. Type the quantity coming back on
each line — **Enter** moves to the next line and on to the reason, and Enter on the reason opens the
refund (**Alt+R** returns everything) — or press **Ctrl+A**:

- **Refund** in cash, to the card or by UPI;
- **Exchange credit**: the customer takes other goods instead — the counter opens with the credit ready
  to use on the new bill;
- for a customer, leave it on their **account**.

The return is a credit note against the original bill: the goods come back into stock and the GST is
reversed. Pevqori will not let more come back than was sold, nor refund more than the bill charged for those
goods (the return uses the bill's rate and discount). A bill with returns cannot be cancelled until its
returns are cancelled; it can still be altered, but not to sell less than came back, to another customer
or to a date after the return. A return whose exchange credit was already used on a bill keeps at least
that credit. A return dated after **30 November** following the financial year of the sale gets a
reminder: by then GST can no longer be reduced by a credit note (CGST s.34(2)) — ask your accountant.

If you open a POS bill or return from the Day Book and alter it as an ordinary voucher, its payments
(and the bill it returns) are kept and checked again; to change what was paid, alter the bill on the
counter.

**Day-end.** *Reports › **POS Day-end Summary*** shows, for the working date (Ctrl+5) or the report
period (Ctrl+6): bills, returns, net sales, GST, what was sold on credit, the **cash** that should be in
the drawer, change given, and the split by payment mode (Ctrl+1), by cashier (Ctrl+2) and by counter
(Ctrl+3). Type the opening float and the cash you counted to see whether the drawer tallies. **Ctrl+4**
lists every bill and return (Enter opens one); Enter on a payment mode, cashier or counter lists just
their bills. Alt+E exports, Alt+P prints.

## 5. Inventory and manufacturing

### 5.1 How stock is valued

Every inward and outward movement comes from vouchers (purchases, sales, notes, stock journals,
manufacturing). Closing stock is valued by each item's **costing method** — average cost (the default,
a running weighted average), FIFO, LIFO, last purchase cost or standard cost — and, with *Stock value
in accounts* on, appears in the Profit & Loss A/c and in the Balance Sheet under Current Assets ›
Stock-in-Hand. A voucher entered later with an earlier date re-values everything after it in every
report. Without *Stock value in accounts*, Stock-in-Hand ledgers are ordinary ledgers: record the closing
stock by journal.

### 5.2 Inventory reports

All under *Inventory Reports* (Alt+F2 changes the period or date, Alt+E exports, Alt+P prints):

| Report | What it shows | Useful keys |
|---|---|---|
| ***Stock Summary*** | Groups → items with closing quantity, rate and value; *Detailed* adds opening, inward and outward | Enter drills down · Alt+F1 detailed · Alt+V quantities only · Alt+Z all items · Alt+X expand / collapse |
| ***Stock Item Vouchers*** | One item's vouchers with running balance | Enter opens the voucher · Alt+M item master |
| ***Godown Summary*** | Stock per godown (with Multiple godowns) | Alt+Z empty godowns |
| ***Batch Summary*** | Batches with manufacturing / expiry dates and days left (with Batches) | Alt+W expiry filter |
| ***Category Summary*** | Stock by stock category | |
| ***Movement Analysis*** | Inward / outward by party and item | Alt+I inward · Alt+O outward |
| ***Stock Ageing*** | Stock by age buckets | Alt+Q values ↔ quantities |
| ***Reorder Status*** | Items below their reorder level, on order, shortfall | Alt+O new purchase order |
| ***Negative Stock*** | Items and godowns below zero, since when | |
| ***Physical Stock Register*** | Counted vs books, gain or loss at cost | Alt+C new count |
| ***Item Profitability*** | Sales, returns, cost of goods sold and gross profit per item | |
| ***Pending Sales Orders*** / ***Pending Purchase Orders*** | Orders not yet delivered / received | Alt+C create order · Alt+L pre-close |
| ***Sales Bills Pending*** / ***Purchase Bills Pending*** | Notes not yet invoiced (section 4.4) | Alt+I invoice now |
| ***Production Register*** / ***Pending Job Work*** | Manufacturing and job work (below) | |

### 5.3 Manufacturing and job work

Turn these on in F11: *F11 › Inventory › **Bill of materials and manufacturing*** for making goods, and
*F11 › Inventory › **Job work*** (it needs *Multiple godowns*) for sending material to job workers or
processing a principal's material. Turning them on adds the voucher types **Manufacturing Journal**,
**Material Out** and **Material In** (you may rename them, or set "Use as" on your own Stock Journal
types under *Masters › **Voucher Types***).

#### Bills of materials (BOM)

A BOM lists what goes into an item you make. *Masters › **Bills of Materials*** (Alt+C to create, or
*Masters › **Create BOM***).

- Choose the **finished item**, give the BOM a name (an item can have several — *Standard*, *Export
  pack* …) and say what quantity the lines are for, e.g. "components are for 10 Nos".
- Add **components** with their quantity (and a default godown if you keep stock in several places).
- Add **by-products** and **scrap** with how they are valued: a rate per unit, a percentage of the cost
  of production, or no value. Their value is taken off the cost of the finished goods.
- One BOM per item is the **default**; mark old ones inactive rather than deleting them.
- Every change is kept as a **revision** (Alt+H shows each one). Vouchers remember the revision they used.
- The form shows the **estimated cost** of the BOM at today's cost of the components, next to the item's
  standard cost.

Sub-assemblies are not exploded automatically: make them first with their own Manufacturing Journal.

#### Manufacturing Journal

*Transactions › **Manufacturing Journal*** (or F10 / Go To).

1. Enter the date, the **finished item** and the **quantity** made. The item's default BOM is chosen and
   the **components** and **scrap** fill in, scaled to your quantity (change the BOM in its field).
2. Correct any quantity actually used — once you change a component by hand the BOM no longer refills
   it; **Alt+B** fills it from the BOM again.
3. Add **additional costs** (labour, power, overheads) as an amount or as a % of the components' cost,
   naming the expense ledger.
4. The panel shows the cost as you type: **components consumed** (valued by each item's costing method
   as on the voucher date) **+ additional costs − by-products/scrap = cost of the finished goods**, and
   the **rate per unit**. **Ctrl+A** saves.

**Ctrl+L** makes the journal optional (a memo that moves no stock) and **Ctrl+T** post-dated, as on other
vouchers; altering an optional journal keeps it optional until you press Ctrl+L again.

The journal moves stock only. Additional costs raise the value of the finished goods but **are not
posted to the expense ledgers** (the usual convention) — record the actual expense with a Payment or Journal
voucher as usual. If a purchase is entered later with an earlier date, the cost of the finished goods is
recomputed automatically in every report. *Inventory Reports › **Production Register*** lists what was
made, at what cost, against the BOM's estimate today.

#### Godowns for job work

In the godown form (*Masters › **Godowns***), *Whose stock* says what a location holds:

- **Our stock with third party** — your goods at a job worker or agent. Still your stock: valued and in
  your Balance Sheet.
- **Third-party stock with us** — a principal's goods you process. Quantities are tracked but they are
  **never valued and never part of your closing stock** — nor of your item quantities, reorder status or
  the dashboard's low-stock list (open that godown in the Godown Summary to see them).

Link the godown to the job worker's (or principal's) ledger; challans then pick the right godown when you
choose the party.

A Manufacturing Journal, Material Out or Material In is altered on its own screen. If that screen cannot
open (e.g. the feature was turned off in F11), saving it from the plain Stock Journal screen is refused
with a message saying what to turn on — so its job work and costing details are never lost.

#### Sending goods to a job worker (you are the principal)

- **Job Work Orders** (optional; *Transactions › **Job Work Orders***): what the job worker will make,
  the material to send (Alt+B fills it from the BOM), process, job charges and due date. From an order,
  **Alt+O** opens a Material Out and **Alt+I** a Material In against it; the order shows what has gone and
  come back.
- **Material Out** (*Transactions › **Material Out***; the delivery challan for job work, CGST rule 55):
  choose the job worker and their godown, then the material, your godown it leaves from, the **type of
  goods** (inputs, capital goods, or moulds/dies/jigs/fixtures/tools) and the **challan rate** (the value
  shown on the challan and in ITC-04). Alt+P prints "Delivery Challan (Job Work)".
- **Material In** (*Transactions › **Material In***): the finished goods received, the components the
  job worker used up, any scrap, any material returned unprocessed, and the job charges as an additional
  cost — the finished goods are valued like a Manufacturing Journal. Type the **job worker's challan
  no.** (the challan they sent the goods back with) in its field: ITC-04 table 5A reports it.
- **Moving goods from one job worker to another**: a Material Out to the second job worker's godown with
  the first job worker's godown as the line's *From godown*. The goods keep the date of your original
  challan for the one-year / three-year rule (moving them on does not restart the clock), and ITC-04
  reports the move in table 5B, not as a new table 4 challan.
- **Purchases delivered straight to the job worker** (enter the job worker's godown on the purchase line)
  are listed under the job worker in Pending Job Work and ITC-04, not under the supplier.

#### The one-year / three-year rule (CGST s.143)

Inputs sent for job work must come back (or be supplied from the job worker's premises) within **one
year**, capital goods within **three years** of the day they were sent; moulds, dies, jigs, fixtures and
tools have no limit. Goods not back in time are treated as **supplied by you on the day they were sent**
— GST is payable with interest.

*Inventory Reports › **Pending Job Work*** lists every challan still (partly) with a job worker, its
return-by date and status (*Overdue*, *Due in n days*, *No time limit*); the Gateway and the dashboard warn
you about overdue and soon-due goods. If the Commissioner has extended the time, enter the new date in the
challan line's *Return extended to* field. Ctrl+2 shows principals' goods lying with you.

#### ITC-04

*GST › **ITC-04***. Choose the period — **half-yearly** (Apr–Sep, Oct–Mar) if your previous year's
aggregate turnover was above ₹5 crore (Ctrl+3 switches *AATO above ₹5 crore*; the choice is remembered on
this computer only), otherwise **annual** — and review **Table 4** (goods sent, Ctrl+1) and **Tables
5A–5C** (received back with the original challan, sent on to another job worker, sold from the job
worker's premises, Ctrl+2). Alt+E exports each table to CSV or Excel in the form's column order, to key
into the GST portal's ITC-04 offline tool; Pevqori does not create the portal's upload file. Check the due
date on the portal — it is often extended — and fill in losses and wastes yourself where they apply.
Moulds, dies, jigs, fixtures and tools are listed as *Inputs* in table 4 (the form has only inputs and
capital goods) — check with your adviser.

#### If you are the job worker

Mark the principal's godown *Third-party stock with us*. Record goods received with **Material In**, your
processing with a **Manufacturing Journal** in that godown (needs *Bill of materials and manufacturing*
on), and goods sent back with **Material Out**. None of this changes your stock value or Balance Sheet;
your job charges are billed with an ordinary sales invoice.

When the components of a Manufacturing Journal come from the principal's godown, the finished goods,
by-products and scrap go into that godown too (leave their godown blank). Pevqori refuses to put them in one
of your own godowns — they belong to the principal, and in your godown they would appear in your stock at
a value out of nothing. A purchase, sale or ordinary stock journal that moves stock into or out of a
principal's godown asks you to confirm first, because that stock is never valued.

## 6. GST

Everything here needs *F11 › Taxation › **GST*** and lives under **GST** on the Gateway. Reading needs
the *View GST reports* permission; marking returns filed, posting the set-off or a challan and saving return
files need *Prepare GST filings*. The figures come from your books — always compare them with the GST portal
before you file, because the portal is the legal record.

### 6.1 Setting up GST

- **Company**: GST registration type and GSTIN in *Company › **Company Details***; return frequency, HSN
  digits, LUT and limits in *F12 › GST*.
- **Parties**: the GSTIN and registration type (regular, composition, unregistered, consumer, SEZ,
  overseas, deemed export, UIN) on the party ledger decide B2B / B2C, SEZ, export and the place of supply.
- **Rates**: the rate comes from the voucher line (if you override it), else the stock item (its dated
  history), else its stock group, else the sales / purchase ledger. Services without stock items take the
  rate from their ledger. When a rate changes, add a dated row ("applies from") instead of overwriting,
  so older vouchers keep their rate.
- **Tax ledgers**: turning GST on creates the Output and Input CGST / SGST / IGST / cess ledgers and the
  reverse-charge payable ledgers.
- Enter GST in **invoice** mode (item or accounting invoice). Tax typed by hand on a plain journal is not
  part of the returns — Pevqori warns when you do that.

### 6.2 Returns and reports

| Gateway item | What it is |
|---|---|
| *GST › **GSTR-1*** | Outward supplies for the return period (Alt+F2): tiles for tables 4A, 4B, 5, 6A, 6B, 6C, 7, 8, 9B, 11, 12 and 13, uncertain transactions with links to fix them, **Alt+J** saves the portal JSON (asking first when there are errors), **Alt+F** marks the return filed, **Alt+M** amendments, **Alt+X** GST exceptions. Enter on a tile opens its documents (Alt+← / Alt+→ moves between parts) |
| *GST › **GSTR-3B*** | Portal-style form 3.1, 3.1.1, 3.2, 4, 5, 5.1 and 6.1 with the ITC set-off explained; *Your entries* for figures the books do not hold (ISD credit, interest, late fee, credit on the portal when the books began — **Ctrl+A** saves only the changed cells); **Alt+J** JSON, **Alt+F** mark filed, **Alt+S** GST set-off, **Alt+P** print |
| *GST › **GSTR-9*** | Annual summary prepared from the books (tables 4, 5, 6, 9, months, 17 / 18) — verify before filing; Enter on a month opens its GSTR-3B |
| *GST › **HSN/SAC Summary*** | Outward / inward HSN summary (Ctrl+1 / Ctrl+2) |
| *GST › **GST Register*** | Sales / purchase register with GST (purchases show the supplier's invoice number and date) |
| *GST › **Input Tax Credit*** | ITC by supplier and by type |
| *GST › **GST Exceptions*** | Every uncertain transaction (missing GSTIN, place of supply, HSN, rate, original invoice …) with Alt+A to alter the voucher and Alt+M to fix the master |
| *GST › **GST Reconciliation*** | GSTR-2B / GSTR-2A against your purchases and GSTR-1 against your sales (section 6.6) |

GSTR-1 and GSTR-3B JSON files are written for upload in the portal's offline utility. Credit notes and
purchase returns are shown as negative amounts, as the portal does. Quarterly (QRMP) filers get the whole
quarter in one GSTR-1 file — invoices already uploaded through IFF must not be uploaded again.

### 6.3 e-Invoice and e-way bills: the JSON round trip

Turn on *F11 › Taxation › **e-Invoicing*** and / or *F11 › Taxation › **e-Way Bill***. Pevqori works offline
and does not hold the API credentials of a GST Suvidha Provider, so it does not talk to the IRP or the
e-way bill system directly. Instead:

1. *GST › **e-Invoice*** (or *GST › **e-Way Bills***): select the invoices (Space; Alt+S selects all that
   are ready) and press **Alt+J** to save the JSON file. Invoices that are not ready say why; Alt+A alters
   one.
2. Upload it on the IRP (e-invoice portal › bulk upload, or its offline tool) or the e-way bill portal
   (bulk generation).
3. Download the response file the portal gives you (IRN, acknowledgement, signed QR code / EWB numbers).
4. Back in Pevqori: e-Invoice › **Alt+I** imports the IRP response (JSON or Excel; the IRN and QR code then
   print on the invoice); e-Way Bills › **Alt+N** records the e-way bill number, date and validity.
   **Alt+H** shows the history of each document.

Cancel an IRN on the portal within 24 hours and then mark it cancelled in Pevqori (Ctrl+2 *IRN generated* ›
**Alt+K**, with the IRP reason code).

### 6.4 GST details on a voucher (Alt+J)

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
  advance), the tax on the advance is reversed automatically. You can also enter the amounts per advance
  under Alt+J.
- **Payment — refund of an advance.** Choose *Refund of an advance* and the amount refunded for the
  receipt; the tax on that part is reversed (GSTR-1 Table 11B).
- **Payment — GST challan.** Choose *GST challan (PMT-06)* and type the CPIN, CIN, BRN and the amount per
  head (tax, interest, penalty, fee, others). Debit "GST Electronic Cash Ledger" and credit the bank. The
  easier way is GST Set-off › **Alt+C** (below), which builds this voucher for you.
- **Purchase — bill of entry (imports).** For goods bought from an overseas supplier or an SEZ unit,
  tick *Import of goods* and enter the BOE number, date, port code (six characters, e.g. INNSA1),
  assessable value, customs duty and the IGST paid at customs. The IGST is taken as input credit
  (GSTR-3B 4(A)(1)); for a composition dealer, or for goods whose credit is blocked (for example a car
  marked "ineligible"), it becomes part of the cost. Enter blocked and other goods on separate purchases.
- **Journal — stat adjustment.** Choose the kind of adjustment, then enter the journal lines:
  - *Reversal of ITC* (Rule 42 / 43 common credit, Rule 38, s.17(5), Rule 37 supplier not paid within
    180 days, Rule 37A supplier did not file GSTR-3B, others): credit the Input tax ledgers and debit an
    expense such as "ITC Reversed (GST)". Shown in GSTR-3B 4(B)(1) or 4(B)(2).
  - *Reclaim of ITC* (after you pay the supplier, or the supplier files): debit the Input tax ledgers.
    Shown in 4(A)(5) and 4(D)(1).
  - *Reverse charge liability* (for example import of services): credit the "… Payable (Reverse Charge)"
    ledgers and debit the Input tax ledgers with the credit you may take; enter the taxable value for
    3.1(d).

### 6.5 GST set-off, challans and electronic ledgers

*GST › **GST Set-off*** shows, for the return period (Alt+F2), how your input tax credit pays the tax in
the order the law requires (IGST credit first; CGST credit never for SGST and vice versa; cess only for
cess), the cash still needed per head (tax, interest, penalty, fee, others), what is already in your
electronic cash ledger and what is still to deposit.

1. Create the challan on the GST portal and pay it.
2. Press **Alt+C** and record it: voucher date, the bank you paid from, CPIN, CIN, BRN, challan date. The
   amounts are prefilled with what is still to deposit. This posts a Payment voucher.
3. After filing GSTR-3B (or CMP-08), press **Ctrl+A** to post the set-off: one journal that squares off
   your Output, Input, reverse-charge, interest / late fee and cash-ledger accounts for the period. To
   change it, alter or delete that journal (Alt+V opens it) and post again — a set-off already posted is
   not recomputed when the period's vouchers change later. If you post it before recording the challan,
   the screen warns you and the cash ledger shows a negative balance until you do. Credit you entered in
   GSTR-3B as *credit not in the books* is never taken from your Input ledgers: the journal credits it to
   **GST Credit Not in Books** (give that ledger an opening balance for the credit the portal held when
   you started).

*GST › **Electronic Cash Ledger*** and *GST › **Electronic Credit Ledger*** show the balances per head as
kept in your books (opening, deposited / accrued, utilised, reversed, closing) with every voucher behind
them (Enter opens it). Compare them with the ledgers on the portal; if the portal shows less credit than
the books, pass a reversal journal (section 6.4).

**Advances (GSTR-1 Table 11).** *GST › **Advances (GST)*** lists, for the period, advances received
(11A) and adjusted or refunded (11B) by place of supply and rate, with the vouchers (Ctrl+1), and the
advances not yet invoiced or refunded (Ctrl+2). As the GSTR-1 instructions require, an advance received
and invoiced (or refunded) in the same return period is in neither table; only what is still unadjusted
at the end of the period goes to 11A. The GSTR-1 table 11 tile opens this screen; the net tax is included
in GSTR-3B 3.1(a).

**Bills of entry (imports of goods).** *GST › **Bills of Entry*** lists the bills of entry recorded on
import purchases. Download your GSTR-2B JSON (or the ZIP the portal gives for a large return) and press
**Alt+O** to compare: each BOE is shown as matched, mismatched (with the IGST difference), missing in
your books or missing in GSTR-2B. Claim credit only for bills of entry that appear in GSTR-2B.

### 6.6 GST reconciliation (GSTR-2B, GSTR-2A, GSTR-1)

*GST › **GST Reconciliation*** compares the portal's documents with your books, document by document.

1. Choose the return period (**Alt+F2**) and the source with **Alt+S** (GSTR-2B or GSTR-2A); download the
   file from the portal (JSON, the ZIP of a large return, or the Excel download) and press **Alt+O** to
   import it. The reconciliation runs after the import (**Alt+R** runs it again).
2. Each portal document is paired with its purchase (by GSTIN, document number — tolerant of prefixes,
   zeros and separators — date and value) and every difference is explained field by field. **Enter**
   opens the comparison: **Ctrl+A** accept, **Alt+I** ignore, **Alt+U** undo a link. Your decisions are
   kept when you import the file again. **Alt+T** sets the matching rules (tolerances).
3. The *Supplier-wise* tab lists suppliers with the most to fix; **Alt+M** prepares an e-mail asking a
   supplier to correct their GSTR-1. **Alt+E** exports the result to Excel, **Alt+P** prints the rows
   shown.
4. The *GSTR-1* tab compares a GSTR-1 file (the portal's download or Pevqori's own) with your sales.

Only vouchers in the books count (not optional, cancelled or future post-dated ones). The portal's IMS
(accept / reject / pending) actions are not imported or exported.

### 6.7 Filing status, amendments and protected periods

After filing a return on the portal, open it in Pevqori and press **Alt+F** (Mark filed) — enter the filing
date and the ARN. *GST › **Return Filing Status*** lists every return marked filed (Alt+U unmarks one
entered by mistake).

Once **GSTR-1** of a month is marked filed, its invoices are protected:

- if you alter one, Pevqori asks you to confirm and records the change as an **amendment** reported in your
  next GSTR-1 (table 9A for invoices, 9C for credit / debit notes, 10 for small B2C sales) — the filed
  month keeps the figures you filed;
- an invoice entered later but dated in that month is reported in the next GSTR-1 as well;
- such an invoice cannot be deleted or cancelled: issue a credit note instead.

*GST › **GSTR-1 Amendments*** (or Alt+M on GSTR-1) lists them with the original and amended values. The
GSTR-1 JSON includes the amendments of invoices and notes to registered buyers; enter the others on the
portal from this list.

Once **GSTR-3B** of a month is marked filed, that month is protected too: altering a purchase, an ITC
reversal or reverse-charge journal, a bill of entry or any voucher with GST of that month asks you to
confirm; the change (and a voucher entered later but dated in that month, or one deleted or cancelled) is
listed in *GST › **Changes after GSTR-3B Filing*** and reported in your **next** GSTR-3B — more credit in
4(A), less credit as a reversal in 4(B)(2), tax in 3.1 — while the filed month keeps the figures you
filed.

*GST › **Rule 37 (180 Days)*** lists purchase bills not paid within 180 days of their date (as on the
date you choose): the input tax credit to reverse for the unpaid part, the GSTR-3B month it belongs to,
and — once you pay — the credit to reclaim. **Alt+R** posts the reversal journal, **Alt+L** the reclaim
(both GST stat adjustments, in 4(B)(2) / 4(A)(5) + 4(D)(1)). Interest u/s 50 is not worked out: enter it
in GSTR-3B under *Your entries*. A supplier kept without bill-wise details cannot be traced; the screen
lists such bills to check by hand.

### 6.8 Composition dealers: CMP-08 and GSTR-4

If your company is registered under composition (*Company › **Company Details***), your sales are Bills
of Supply without tax ("Composition taxable person, not eligible to collect tax on supplies"), supplier
GST is a cost, and the GST menu shows **CMP-08**, **GSTR-4** and **Composition Rates** instead of GSTR-1 /
3B. The dashboard shows when each is due (CMP-08 by the 18th after each quarter, GSTR-4 by 30 April after
the year); the government sometimes extends these dates, so check the portal.

- *GST › **Composition Rates***: choose your category (manufacturer, trader, restaurant, service provider
  under s.10(2A)) and check the rates — 1% for manufacturers and traders (traders on taxable turnover),
  5% for restaurants, 6% for service providers, each half CGST and half SGST. If a rate changes, add a new
  rate with its effective date (Alt+C); older documents keep the old rate. Once the books are locked, a
  rate (or the category) that would change the tax of a locked quarter cannot be added, altered or
  deleted — add the new rate from a date after the lock.
- *GST › **CMP-08*** (quarterly): table 3 — your turnover and the composition tax on it, plus tax on
  purchases under reverse charge (including import of services), interest (Alt+I) — and table 4, the tax
  paid. Pay through GST Set-off (Alt+S): record the challan, then post the set-off. Save the figures as
  CSV / JSON (Alt+K / Alt+J) — the portal has no CMP-08 upload, so type them in — and mark it filed
  (Alt+F).
- *GST › **GSTR-4*** (annual): purchases (4A registered, 4B registered under reverse charge, 4C
  unregistered, 4D import of services), your four CMP-08s (table 5; Enter opens a quarter), rate-wise
  supplies (table 6) and the tax paid (table 8). The file it saves is Pevqori's own CSV / JSON to help you
  fill the return; it is not the portal's offline-tool file. TDS / TCS credit (table 7) is not kept —
  take it from the portal.

A composition dealer cannot record GST on advances (there is no Table 11); include such an advance in
the quarter's CMP-08 turnover yourself where it applies.

## 7. TDS and TCS

*For businesses that deduct TDS on payments (contractors, professionals, rent, commission, interest,
purchases above ₹50 lakh for buyers with turnover above ₹10 crore) or collect TCS on sales (scrap,
minerals, forest produce, motor vehicles above ₹10 lakh).* Salary TDS (section 192, Form 24Q) is not
covered — Pevqori has no payroll.

**1. Turn it on.** Press **F11** and turn on *F11 › Taxation › **TDS*** and / or *F11 › Taxation ›
**TCS***. A **TDS / TCS** section appears on the Gateway. Nothing about TDS / TCS is shown while both are
off.

**2. Setup** (*TDS / TCS › **TDS / TCS Setup***). Enter your **TAN**, the deductor category and the
person responsible. If your turnover exceeded ₹10 crore last year, turn on **Deduct TDS on purchase of
goods (s.194Q)**. Tax is rounded to the rupee unless you turn that off.

**3. Natures of payment / goods** (*TDS / TCS › **Natures of Payment / Goods***). The common sections
come ready with their rates and thresholds for FY 2025-26 (194C, 194H, 194I, 194J, 194A, 194Q, 194R,
194T, 195, 206C(1), 206C(1F)). When the law changes, open the nature and **add a rate row from the new
date** (Alt+R) — do not overwrite the old one, so older vouchers keep their rate. From 1 April 2026 the
Income-tax Act 2025 applies: the app keeps the familiar 1961 section codes and assumes the rates carried
on unchanged — check with your tax adviser and add dated rows if they changed. The rate for payments to
non-residents (195) is a placeholder; set the right rate for each remittance.

**4. Tell the app who and what.** *TDS / TCS › **Ledger TDS / TCS Details***:
- *Parties* (Ctrl+1): every supplier / customer is a deductee unless you turn **TDS / TCS applies to this
  party** off (an exempt party — e.g. a transporter who gave the s.194C(6) declaration). Enter the
  **PAN** (checked as you type — without a valid PAN a higher rate applies: usually 20% for TDS, 5% for
  194Q, and twice the rate (at least 5%) for TCS), the **deductee type** (company, individual / HUF, firm,
  others; suggested from the PAN), and any **lower / nil deduction certificate** (number, rate, dates,
  amount limit). For a customer who deducts TDS from you, enter its **TAN**. Partners (194T) and lenders
  (194A): open their capital / loan ledger here and set the deductee type.
- *Expenses & assets* (Ctrl+2): mark e.g. *Contract Charges* as TDS applicable under 194C.
- *Sales & income* (Ctrl+3): mark e.g. *Sale of Scrap* as TCS applicable.
You can also reach these from a ledger master (Other settings › Open TDS / TCS details).

**5. Enter vouchers as usual.** On a purchase bill, journal or payment the right-hand column shows the
TDS worked out — section, base, rate and why (e.g. "the year's total ₹1,20,000 crossed ₹1,00,000: earlier
credits taken in now"). The supplier is credited with the bill less TDS, and *TDS Payable – 194C* is
credited. On a sale with TCS the tax is added to the invoice. Press **Alt+U** to change an amount (you
must give a reason — it is recorded and listed under Exceptions) or, for an **advance payment**, to choose
the nature to deduct under. When the bill for that advance comes, the part already taxed as the advance
is set off — TDS is deducted only on the rest. If you type the *TDS Payable* line yourself, the app takes
your amount instead of adding its own. *TDS / TCS › **TDS / TCS Computation*** shows what was deducted or
collected per party and section.

A **debit note** to a supplier against a bill with TDS (bill-wise *Against* the bill, or its invoice
number in *Original invoice*) reverses the TDS in proportion — a note for 10% of the bill reverses 10% of
its TDS, never more than is left — and a **credit note** to a customer reverses TCS the same way (in the
invoice modes only). If you booked a bill **without** TDS and deduct it later by a journal (Dr the
supplier against the bill, Cr *TDS Payable – 194C*), Pevqori records it as the TDS on that bill: it shows in
Outstanding, the statement and every report. 194T (payments by a firm to its partners) is deducted only
when the deductor category in TDS / TCS Setup is *Firm*. On a bill from a foreign supplier kept in
dollars, TDS u/s 195 is worked out on the rupee value at the voucher's rate (type the SBI TT buying rate
of the deduction date when it differs); the supplier is owed the net in dollars, and paying that net
settles the bill.

**6. Pay the tax.** *TDS / TCS › **TDS / TCS Outstanding*** shows, month by month and section by section,
what was deducted and not yet deposited, the due date (7th of the next month; 30 April for March TDS),
days late and the interest (1.5% a month or part for late TDS deposit, 1% for TCS). Highlight a month and
press **Alt+C**: the challan form opens with the unpaid tax and the interest filled in (also *TDS / TCS ›
**Create TDS / TCS Challan***). Enter the BSR code, challan serial number and deposit date from the
challan and press **Ctrl+A**. A Payment voucher is created and the month is cleared. *TDS / TCS ›
**TDS / TCS Challan Register*** lists every challan.

**7. Quarterly statements.** *TDS / TCS › **Quarterly Return (26Q / 27Q / 27EQ)***: pick 26Q
(residents), 27Q (non-residents) or 27EQ (TCS), the year and the quarter. Ctrl+1 shows the deductee rows
(with PANNOTAVBL where a PAN is missing), Ctrl+2 the challans; warnings tell you what is not yet
deposited. **Alt+S** saves two CSV files with every field the return preparation utility asks for — copy
them in, or send them to your tax practitioner. They are not the final FVU file: validate with the
current FVU before filing. After filing, press **Alt+R** and enter the filing date and token: the late fee
u/s 234E (₹200 a day, up to the tax) stops counting. The Outstanding screen also lists each statement with
its due date and late fee. Once a statement is recorded as filed, its quarter is protected: saving a
voucher that changes the TDS / TCS or challan reported in it asks you to confirm (file a correction
statement on TRACES afterwards), and such a voucher cannot be deleted or cancelled. If you recorded the
filing by mistake, open the statement, press Alt+R and choose **Not filed**.

**8. Check before you file.** *TDS / TCS › **TDS / TCS Exceptions*** lists vouchers with no PAN or an
invalid PAN, amounts deducted below the threshold, thresholds crossed but not deducted (with the interest
that may be due), and short deductions. Enter opens the voucher.

**9. TDS your customers deduct.** Create the *TDS Receivable* ledger (TDS / TCS Setup › Alt+R) and debit
it in Receipt vouchers (Dr Bank, Dr TDS Receivable, Cr Customer). In *TDS / TCS › **TDS Receivable vs
26AS*** press **Alt+I** to import a CSV prepared from Form 26AS / AIS (columns: TAN of deductor, Name of
deductor, Section, Transaction date, Amount paid/credited, Tax deducted). Each customer shows the TDS in
your books against 26AS; differences are the ones to follow up.

Reports open with Enter down to the voucher, and export (Alt+E) or print (Alt+P) like every other report.
The Gateway reminds you when a deposit is overdue or due within a week. Form 16A / 27D certificates come
from TRACES; Pevqori does not produce them.

## 8. Banking and cheques

### 8.1 Bank reconciliation and statements

- *Banking › **Bank Overview*** — every bank account with its book balance, the last imported statement
  and the difference. **Enter** reconciles, **Alt+I** imports a statement, **Alt+M** matches, **Alt+Q**
  cheque register, **Alt+T** post-dated cheques, **Alt+C** creates a bank ledger.
- *Banking › **Bank Reconciliation*** — choose the bank and the *as on* date. Type the **bank date**
  of each entry as it appears in your passbook or statement (Ctrl+1 unreconciled, Ctrl+2 reconciled,
  Ctrl+3 all; **Alt+R** sets all shown to the statement date, **Alt+X** discards typed dates, **Ctrl+A**
  saves). The summary shows the balance as per books, cheques issued but not presented, cheques deposited
  but not cleared, and the balance as per bank — and, once a statement is imported, the difference from
  the statement's balance and what explains it.
- *Banking › **Import Statement*** — choose the bank and the file the bank gave you: Excel (`.xlsx`) or
  CSV / text. Layouts of SBI, HDFC, ICICI, Axis, Kotak, Yes Bank, PNB, Bank of Baroda and Canara Bank are
  recognised, and other banks' columns are matched by their names; you can correct the mapping, and it is
  remembered for that bank. Old `.xls`, HTML disguised as `.xls` and PDF statements are refused — save the
  statement as `.xlsx` or CSV first. Lines already imported are skipped, so overlapping downloads are
  safe; lines dated before your books begin are left out (they are in the opening balance).
- *Banking › **Match Statement*** — **Alt+M** auto-matches statement lines with your vouchers (same
  amount, close date, cheque / UTR number, party name); doubtful ones become *Suggestions* (Ctrl+2) to
  confirm (**Alt+L** looks for a match for one line). For lines with no voucher (bank charges, interest, a customer's direct transfer) **Alt+V**
  creates the receipt, payment or contra (**Alt+B** for many at once) — Pevqori first checks that no
  existing voucher could be the same transaction. **Alt+I** ignores a line, **Alt+U** unmatches, **Alt+D**
  deletes an imported statement (to import it again into the right bank or with other columns). Matching
  sets the bank date.
- *Banking › **Cheque Register*** — cheques and DDs issued and received with their status (cleared,
  uncleared, post-dated, stale after 3 months). *Banking › **Post-dated Cheques*** lists post-dated
  vouchers on bank ledgers by maturity. *Banking › **Deposit Slip*** lists the cheques and cash
  deposited on a date with totals and the amount in words, ready to print.

**Bank dates in a locked period.** When the books are locked up to a date, a bank date on or before that
date is part of a closed reconciliation. Setting, moving or clearing such a bank date — in the BRS, by
matching or unmatching a statement line, by deleting an imported statement with "unmatch", or by
deleting, cancelling or altering (bank ledger or amount) a voucher of the open period whose cheque
cleared in the locked period — needs the right to lock and unlock the books (Owners always have it);
others get "Books are locked up to …". Automatic matching then leaves the statement lines of the locked
period unmatched for such a user. A cheque written in a locked month that clears in an open month is
reconciled as usual.

### 8.2 Payee bank details

*Masters › **Payee Bank Details*** keeps each supplier's (or employee's, or landlord's) bank account:
beneficiary name as the bank has it, account number (typed twice, so a wrong digit is caught), IFSC (11
characters: 4 letters for the bank, a zero, 6 letters or digits for the branch; the bank code is shown as
you type), bank, branch, account type, the **name to write on cheques** if it differs, and how you usually
pay them. Confirm a new or changed account with the payee before paying — fraudsters often send "changed
bank details" letters. Go To finds them too: type the party's name.

### 8.3 Cheque books and cheque printing

Turn on *F11 › Accounting › **Cheque printing***, then:

1. *Masters › **Cheque Books*** (Alt+C): choose the bank and type the first and last leaf number printed
   on the book (for example 000501 to 000525). Payments and Contras paid **by cheque** (Alt+K on the bank
   line → Cheque) now get the next unused leaf automatically when saved; you can still type a number
   yourself.
2. *Masters › **Cheque Layouts***: start from the *CTS-2010 standard leaf* preset (202 × 92 mm). Press
   **Alt+K** to print the **calibration sheet** on plain paper, hold it against a real cheque in front of
   a light and move the boxes (millimetres from the leaf's top-left corner) until the date boxes, payee
   line and amount boxes fall in place — or use *Shift right / down* when everything is off by the same
   amount. **Alt+T** prints a sample cheque on plain paper to check. Nothing may be printed in the bottom
   16 mm (the MICR code line); Pevqori refuses positions whose text would reach it — including the
   "Authorised Signatory" line, which prints 10 mm below "For <your company>".
3. *Masters › **Cheque Printing Settings***: give each bank its layout, whether cheques are crossed **A/c
   Payee** by default, and the signatory text (Authorised Signatory, Partner, Director…).
4. To print: open the payment and press **Alt+K** (Print cheque), or *Banking › **Print Cheques***, tick
   several payments of the period (Space, Alt+A all) and press Ctrl+A. Check the preview — date as
   DDMMYYYY in the boxes, the payee, the amount in words in lakh / crore ending with "Only", the figures as
   **\*\*1,23,456.78/-** so nothing can be added — then **Alt+P**. Space leaves a cheque out; Alt+X switches
   its A/c Payee crossing (self cheques for cash withdrawals are never crossed). Printing is recorded in
   the edit log and the register; a reprint is warned.

Feed the leaf as your printer needs: a cheque printer or a printer that takes custom paper prints the
leaf on its own; an ordinary A4 printer can use the *On an A4 sheet* placements. Some printer drivers
ignore a custom paper size — then use the A4 placements or set the size in the printer's own dialog.
Pevqori ships generic CTS-2010 positions, not bank-specific presets: calibrate once per bank.

### 8.4 Cheque leaf register

*Banking › **Cheque Leaf Register*** shows every leaf of a bank's books as on a date: **issued**
(post-dated ones marked PDC), **cleared** (the bank date you entered in Bank Reconciliation — Alt+R opens
it), **stale** (not cleared three months after the cheque date — banks will not pay it; issue a fresh
cheque), **cancelled** and **unused**. Ctrl+1…6 switch the view. A spoilt or lost leaf: **Alt+X**, with
the reason, so it is never used; Alt+U re-opens one cancelled by mistake (neither works for a date in a
locked period). Cancelling a payment cancels its leaf; deleting a payment frees it unless it was printed.
Enter opens the payment. Change the *as on* date to see the register on an earlier day (a cheque cleared
later shows as issued then); the "Issued, not cleared" total is the same figure as "cheques issued but not
presented" in Bank Reconciliation on that date (optional payments and cheques dated later are listed but
not counted).

### 8.5 Bulk e-payment file (NEFT / RTGS / IMPS)

*Banking › **E-payment File*** lists the period's payments by bank transfer (bank line NEFT / RTGS /
IMPS, or no instrument). Tick the ones to pay (Space; Alt+A ticks all that are ready), optionally set the
value date, and press **Ctrl+A** to save a CSV to upload in your bank's net banking (bulk / file upload).
A payment that cannot go in the file says why: no bank details for the payee (Alt+M opens them), several
payees in one voucher, RTGS under ₹2,00,000, IMPS over ₹5,00,000. Payments already in an earlier file are
marked, and Pevqori asks before you put them in another (paying twice). If you cancel the Save dialog,
nothing is marked. Optional (memorandum) payments are never listed.

The file is Pevqori's own documented layout (beneficiary name, account, IFSC, amount, mode, value date,
remarks and more). Banks' upload formats differ: most let you map the columns of a CSV once; if yours
needs a fixed template, rearrange the columns in Excel the first time and save it as your template.
Careful: Excel drops the leading zeros of account numbers such as 001122334455 when it opens a CSV —
import the account column as *Text*, or upload the file exactly as Pevqori saved it.

## 9. Outstanding: receivables and payables

With *Bill-wise details* on (the default), every invoice is a **bill** with a due date (from the party's
credit period); receipts and payments settle bills (Alt+B in voucher entry), and anything not set against
a bill stays *On Account*. For a party not kept bill-wise, Pevqori settles the oldest balance first (FIFO).

- *Reports › **Receivables*** and *Reports › **Payables*** — as on the period end (Alt+F2). **Ctrl+1**
  parties (total, overdue, not yet due, advances and on-account amounts, credit-limit use), **Ctrl+2**
  bills (Alt+O overdue only, Ctrl+F search), **Ctrl+3** ageing (Alt+B changes the periods, e.g. `30, 60,
  90, 180`; Alt+U due-date or bill-date basis). **Enter** on a party opens its bills; **Alt+S** statement
  of account, **Alt+L** ledger, **Alt+I** interest, **Alt+R** reminder letter (receivables). **Alt+W**
  switches between receivables and payables on these two screens.
- *Reports › **Receivables Ageing***, *Reports › **Payables Ageing*** and *Reports › **Overdue Bills***
  open those views directly.
- A party's bills (Enter on a party) show each bill with its history (Ctrl+1) and the on-account entries
  (Ctrl+2); **Alt+F1** shows or hides settled bills; **Alt+Y** shows the bills in the party's foreign
  currency (section 11).
- *Reports › **Statement of Account*** — a party's transactions (Ctrl+1) or pending bills (Ctrl+2) for a
  period, to print (Alt+P), save as PDF / Excel (Alt+E) or share by e-mail / WhatsApp (**Alt+W**).
- *Reports › **Interest Calculation*** (with F11 *Interest calculation*) — simple interest on overdue
  bills for one party, a group or all debtors and creditors (Alt+R sets the rate), 365-day year.
- *Reports › **Payment Reminders*** — reminder letters for customers with overdue bills: Space includes or
  skips a customer, Alt+P prints the letter, Alt+S saves it as PDF, Alt+T copies its text, Alt+B prints all
  chosen letters and Alt+M saves them all as one PDF. Letters are in English.

The dashboard shows receivables and payables with their ageing, and bills falling due in the next seven
days.

## 10. Reports and budgets

### 10.1 Financial reports

All reports follow the same rules: **Alt+F2** changes the period (or the *as on* date), **Enter** (or a
double-click) drills down — group → ledgers → vouchers → the voucher itself — and **Esc** comes back up,
**Alt+F1** switches detailed / condensed, **Alt+E** exports (Excel, CSV or PDF — press X, C or P in the
dialog) and **Alt+P** prints. Amounts carry Dr / Cr instead of a minus sign.

| Report | Notes and keys |
|---|---|
| *Reports › **Balance Sheet*** | As on the period end; **Alt+C** adds last year's column for comparison |
| *Reports › **Profit & Loss A/c*** | Trading and P&L for the period; **Alt+V** switches horizontal ↔ vertical (Schedule III) |
| *Reports › **Trial Balance*** | **Alt+L** ledger-wise ↔ group-wise, **Alt+O** opening balances, **Alt+T** period transactions, **Alt+Z** zero balances, **Alt+X** expand / collapse |
| *Reports › **Ledger*** | One ledger's vouchers with running balance; **Alt+L** another ledger, **Alt+M** ledger master, **Alt+Y** monthly summary, **Alt+A** alter the voucher, **Alt+R** both currencies for a foreign-currency ledger |
| *Reports › **Cash/Bank Books*** | Cash and bank accounts with their balances; **Alt+F** cash flow |
| *Reports › **Sales Register*** (and Purchase, Receipt, Payment, Contra, Journal, Credit Note, Debit Note registers) | Month by month; Enter on a month lists its vouchers; **Alt+V** voucher list ↔ monthly view |
| *Reports › **Cash Flow*** | Money into and out of cash and bank, month by month |
| *Reports › **Funds Flow*** | Sources and uses of funds, change in working capital |
| *Reports › **Ratio Analysis*** | Current and quick ratio, profit margins, receivable days and more |
| *Reports › **Cost Centre Report*** | Income and expenses by cost centre (with F11 cost centres) |
| *Reports › **Exception Reports*** | Negative balances, optional, post-dated, cancelled and memorandum vouchers |
| *Reports › **Statistics*** | Number of vouchers and masters |
| *Reports › **Dashboard*** | The full dashboard (Alt+R refresh) |

The Day Book (section 4.3) and the outstanding, GST, TDS, stock and forex reports are described in their
own sections. Exporting and printing need the *Export* permission and are recorded in the edit log.

### 10.2 Budgets and budget variance

*Masters › **Budgets*** › Alt+C: name, period (usually the financial year) and lines. Each line is a group,
ledger or cost centre with an amount, **Dr or Cr** (type `d` / `c`): an expense or asset budget is Dr, an
income or liability budget Cr. Choose **On nett transactions** for what should be spent or earned in the
period, or **On closing balance** for where a balance should stand (e.g. debtors at year-end).

- *Reports › **Budget Variance*** (or Alt+V on the budget list) shows each line's budget, actual, variance
  and variance %, marked *Over budget* or *Within budget*. Enter drills to the ledger, group or cost
  centres. Ctrl+2 reports a part of the year (Alt+F2): nett budgets are scaled by days (a quarter of an
  annual budget for a quarter); closing-balance targets stay as they are. Alt+S runs it under a scenario.
- On the Trial Balance, P&L and Balance Sheet, **Alt+B** adds a budget column next to the amounts (the
  Trial Balance also shows the variance: a nett budget against the period's debits less credits, a
  closing-balance budget against the closing balance).
- The report's total counts each amount once: a ledger budgeted inside a budgeted group (and cost-centre
  lines next to group / ledger lines) is shown but not added again. Drilling into a group under a scenario
  keeps the scenario.

### 10.3 Scenarios

A **scenario** (*Masters › **Scenarios***) says which provisional vouchers to add to the reports:
memorandum vouchers, reversing journals and optional vouchers of the voucher types you tick — with or
without the actual books — and which regular voucher types to leave out (e.g. "before year-end
journals"). On the **Trial Balance, Profit & Loss and Balance Sheet press Alt+S** and choose the
scenario; the report title shows it, and the totals still balance. Group summaries you drill into follow
the scenario; ledger statements, outstanding, GST returns and the Day Book always show the books. Budget
variance under a scenario follows it for cost centres too. The scenario and budget chosen on a report are
not remembered after the screen closes.

## 11. Multiple currencies

Use this if you bill overseas customers in dollars, pay foreign suppliers in euros, or keep an EEFC
account. Your books stay in rupees — every voucher still balances in rupees — but customers, suppliers and
bank accounts that you deal with in a foreign currency are *also* kept in that currency.

### 11.1 Setting it up

1. Turn on *F11 › Accounting › **Multiple currencies***. A ledger called **Forex Gain/Loss** (under
   Indirect Expenses) is created for exchange differences.
2. *Masters › **Currencies*** — create the currency (for example `$`, US Dollar, ISO code `USD`, 2
   decimals). **Alt+R** enters a rate of exchange for a date: *standard*, *selling* and *buying* rates in
   rupees for one unit. Enter the rates you actually use (your bank's rate, or for exports of goods the
   rate notified by CBIC for customs). Pevqori does not download rates.
3. Open the customer / supplier / bank ledger and set its **Currency**. From then on it is entered in that
   currency. (Once vouchers record a ledger in a currency, its currency cannot be changed — create a new
   ledger instead.)
4. Opening balances: enter the rupee opening balance in the ledger as usual, then *Masters › **Opening
   Balance in Currency*** (or Alt+O in Forex Outstanding / Ledger in Foreign Currency) to give the same
   balance — and each opening bill — in the currency. **Alt+R** there fills every amount at one rate. Like
   the rupee openings, these cannot be changed once the books are locked up to the books beginning or
   later — unlock the period first.
5. Optional: *Masters › **Multi-currency Settings*** — choose other ledgers for realised and unrealised
   differences, and which rate (standard / selling / buying) is used at the year end.

### 11.2 Export invoices

Create the sales invoice (F8) for the overseas customer as usual. Because the customer is kept in
dollars, Pevqori fills in the **rate of exchange** from your rates (the buying rate of the invoice date) or
asks for it when there is none; **Alt+Y** shows or changes it. Type rates and amounts **in dollars**; the
rupee value is what posts, and GST is worked out in rupees. In **Ctrl+I › More details › Export** choose
*under LUT* (no IGST) or *with payment of IGST*, and fill the shipping bill number, date and port code when
you have them. The side panel shows the invoice value in dollars, the rate and the rupee value.

The printed invoice is your normal GST invoice in rupees (with the "supply meant for export…" line) plus a
table of every line in dollars next to the rupees, the rate, GST in rupees (and its dollar equivalent),
the total in both currencies and the dollar total in words (Modern, Classic and voucher templates; the
Compact receipt template does not print it). GSTR-1 shows the export in rupees (EXPWP / EXPWOP), as the
portal wants.

Import purchases work the same way with a supplier kept in a foreign currency (selling rate by default).
Amounts are typed with the currency's own decimals: none for yen, three for Kuwaiti dinars, four where the
currency has four. Stock bought in a currency is valued in rupees at the converted rate.

### 11.3 Receipts and payments — exchange gain or loss

When the customer pays, enter the receipt (F6) with the customer's line **in dollars** and the rate the
bank gave you (Pevqori asks for both when you leave the customer's line; **Alt+Y** reopens it). Choose the
bills it settles in the same dialog, in dollars. If the rate differs from the rate the invoice was booked
at, Pevqori works out the **realised exchange gain or loss** and posts it to Forex Gain/Loss *in the same
receipt* — the bill is cleared in both currencies. Example: an invoice of $1,000 at ₹83 (₹83,000); $600
received at ₹84 = ₹50,400; the bill carried ₹49,800 for that $600, so ₹600 is an exchange gain.

Moving money between your EEFC account and a rupee account is an ordinary contra: the EEFC line in
dollars at the bank's rate.

### 11.4 Reports

- *Reports › **Forex Outstanding*** — every party in a foreign currency with its pending bills: amount in
  the currency, the rate it was booked at, the rupees in your books, today's (period-end) closing rate,
  what it is worth at that rate and the difference. Ctrl+1/2/3 all / receivables / payables; Enter opens
  the ledger or the bill's voucher.
- *Reports › **Ledger in Foreign Currency*** — a ledger's vouchers with amounts, rates and running
  balances in both currencies. From the normal ledger report, **Alt+R** switches to it; from a party's
  outstanding, **Alt+Y** shows its bills in the currency.
- A voucher opened from any report shows a **Foreign currency** panel with the amounts, rates and any
  exchange difference it posted.

### 11.5 Year end (or quarter end): revaluation

Accounting Standards (AS 11 / Ind AS 21) ask you to restate money owed in a foreign currency at the
**closing rate**. Enter the closing rate in Currencies (or type it on the screen, Alt+R), then open
*Reports › **Forex Revaluation*** for the period end (Alt+F2). It lists each balance, what it is carried
at, what it is worth at the closing rate and the adjustment. **Ctrl+A** posts the **Forex adjustment**
journal (you can change its date and narration first — not earlier than the revaluation date). Every
currency with a balance needs its closing rate before you can post. Only money items are restated:
parties, bank accounts, loans and deposits; sales, purchase, expense ledgers and fixed assets,
investments or stock kept in a currency stay at the rate they were booked at. Pevqori warns you before
posting a second revaluation for the same date. If you reverse revaluations on the first day of the next
year, duplicate the journal (Alt+2 on the voucher) and swap the sides.

Things Pevqori does not do: download exchange rates, treat long-term foreign-currency loans under AS 11 para
46A, or hedge accounting — record those with a journal and ask your CA.

## 12. Printing and sharing

### 12.1 Invoice printing settings

*Company › **Invoice Printing*** sets how invoices look: the template (**Modern**, **Classic** or
**Compact**), the paper, copies (original / duplicate / triplicate), the HSN summary, item-wise tax
columns, your bank details and a UPI "Scan to pay" QR code, the declaration, terms and conditions, the
signatory label, **Show MRP**, print after saving, and the texts used when sharing (12.4). **Alt+P**
previews a sample, **Alt+E** saves the preview as PDF, **Ctrl+A** saves. A voucher type can have its own
template and MRP column (*Masters › **Voucher Types***). Invoices carry the IRN and signed QR code once
the e-invoice response is imported (section 6.3).

### 12.2 Print preview, paper sizes and thermal receipts

**Alt+P** on a voucher (or Ctrl+P in the Day Book) opens the print preview: **Alt+P** prints, **Alt+E**
saves a PDF, **Alt+W** shares, **Alt+L** customizes what prints (12.5), **PgUp / PgDn** moves to the
previous / next voucher, **Alt+T** changes the template and **Alt+S** the paper for this print,
**Ctrl+1/2/3** original / duplicate / triplicate, **Alt+V** opens the voucher.

**Modern** and **Classic** print on A4, A5 (portrait or landscape), Letter or Legal; **Compact** is a till
receipt for 80 mm or 58 mm thermal rolls — item, quantity × rate and amount on narrow lines, a tax
summary, and a page exactly as long as the receipt. Drivers that cannot print a custom page length use the
roll's own page size: set it in the printer's settings.

*Utilities › **Print Vouchers*** prints many vouchers at once: tick them (Alt+A all), choose template,
paper and copies, then **Ctrl+A** to preview and print, **Alt+P** to print all or **Alt+E** to save them
as one PDF.

### 12.3 MRP on invoices

Give stock items their MRP (per unit, inclusive of all taxes), then turn on **Show MRP** in Invoice
Printing (or *MRP column* on a voucher type). Sales invoices, quotations, orders and challans print an MRP
column marked "inclusive of all taxes", and invoices add **"You saved ₹…"** — the MRP value less what the
customer actually paid. If a line is billed above its MRP, the preview warns you before printing: packaged
goods must not be sold above MRP. The MRP printed is the item's MRP when you print — reprinting an old
invoice after changing the MRP prints the new one.

### 12.4 Sharing an invoice or statement by e-mail or WhatsApp

On a saved voucher's view, its print preview or a Statement of Account press **Alt+W**. The party's
e-mail and mobile come from its ledger (fill in *E-mail* and *Mobile* there once); the subject and message
come from the texts in Invoice Printing, which you can change (placeholders such as {document}, {number},
{date}, {amount}, {party}, {company}).

- **E-mail**: Pevqori saves the PDF in the company's *exports\shared* folder and opens a ready e-mail in your
  mail program (Outlook, Windows Mail) with the PDF attached — check it and press Send. If no mail program
  is set up, your default mail link opens instead and the PDF is shown in its folder to attach. (If
  *exports* or *shared* in the company folder is a shortcut / link to another place, Pevqori refuses to use
  it — delete it and Pevqori creates the folder again.)
- **WhatsApp**: WhatsApp (app or web) opens a chat with the party's number and your message, and the PDF
  is shown in its folder — drag it into the chat. (WhatsApp does not let any program attach a file for
  you.)

Sharing needs the *Export* permission, and every share is recorded in the edit log. Pevqori itself sends
nothing over the internet: your mail program or WhatsApp does.

### 12.5 Customize what prints

In the print preview of any invoice, note, challan, order or voucher press **Alt+L** (or *Customize
layout* in the command bar). A panel opens beside the preview:

- **Show** lists every part this template prints, in groups — header (logo, your name, address, GSTIN,
  PAN, CIN, phone and e-mail, title, copy label …), document details, parties (bill-to, the buyer's
  GSTIN, ship-to), each item column (S.No., HSN/SAC, quantity, unit, MRP, rate, discount, GST rate, the
  per-line tax columns, amount), totals rows, amount and tax in words, HSN / tax summaries, bank details,
  UPI QR, the e-invoice IRN and QR, declaration, terms, notes, narration, signature, the
  "computer-generated" line, the footer line and page numbers. Turn a switch off to hide that part (Space
  toggles, Tab moves on). A lock marks what always prints: the CANCELLED / OPTIONAL stamp, the document
  number and date, the grand total, the item description and the ledger entries of a voucher. Click a part
  in the preview to jump to its switch.
- **Texts** has a box for every printed wording: the title, the copy labels, the "Bill to" / "Ship to"
  labels, column headings, the "Amount in words" and "Total" labels, declaration, terms, a notes paragraph
  printed above the terms, the signatory label, the "For {company}" line, a footer line and the
  "computer-generated" text. An empty box prints the wording shown in grey; ↺ goes back to it.

Changes apply **to this print only** and show at once in the preview; Print, Save as PDF and Share print
exactly what you see. If you change the same kind of document again later in the session, the panel offers
**Apply them** to repeat the earlier changes. To keep them, use **Save for Sales** (for every document of
this voucher type; needs the *Alter masters* permission) or **Save for all documents** (needs *Change
company settings*). Choices that Invoice Printing already offers — HSN summary, bank details, UPI QR,
tax on every line, MRP column, declaration, terms and signatory — are saved into those same settings
(and into the voucher type's own choices for a voucher type). **Reset ▾** undoes this print's changes, or
what is saved for the voucher type or for all documents. *Company › **Invoice Printing*** has the same
panel (**Alt+L**, *Customize layout…*) for all documents; save it there with **Ctrl+A**. Batch printing
(*Utilities › **Print Vouchers***) and printing right after saving use the saved layouts.

Hiding a particular that GST rules require on that document — for example the buyer's GSTIN on a B2B tax
invoice, the HSN/SAC codes (column and summary both hidden), the place of supply of an inter-State supply,
the signature, or the IRN and QR code of an e-invoice — never stops you printing: the panel and the
"Before you print" banner say what is missing and which rule asks for it (CGST Rules 46, 48, 49, 53, 55).

## 13. Data: backup, restore, import, export, attachments

### 13.1 Backups

*Data › **Backup*** makes a complete copy of the company in one `.pvqbak` file named after the company,
date and time. Type an optional note ("Before filing GSTR-3B") and, if the file will leave your control,
a **password** of at least 8 characters — the backup is then encrypted (AES-256-GCM) and cannot be
restored without it. **Ctrl+A** backs up now; you can keep working meanwhile. The list below shows the
backups in the folder; **Alt+V** checks one (checksums, password, database integrity), **Alt+R**
restores, **Alt+K** checks the books, **Alt+F** changes the folder and **Alt+S** opens the backup
settings.

**Automatic backups** (*F12 › Backup*, on by default): when the last backup is more than 24 hours old,
Pevqori backs up a few seconds after you open the company (or log in) and again when you close it (F3,
Ctrl+Q or closing the window). It keeps the last 10 backups of the company in the folder (change *Keep
last* in F12); older ones are removed only after the new file has been read back intact. Automatic
backups are not password-protected — make a backup with a password by hand when a copy leaves your
control.

The default folder is `backups\<company>` inside the data folder. Choose a folder on another disk, a USB
drive or a folder your cloud drive synchronises (*F12 › Backup › Choose…*); Pevqori itself never uploads
anything.

**A backup folder from another computer must be confirmed here.** The backup folder chosen in F12 is
stored in the company. When the company arrives on this computer some other way — restored from a backup
made elsewhere, a company folder copied over, or a data folder shared with another PC — Pevqori does **not**
write to that folder until you confirm it on this computer (it could be a network share you never chose
here). Meanwhile backups, automatic or not, go to the default folder inside the data folder. With
automatic backups on, a warning says so each time you open the company; in any case:

- *Data › **Backup*** shows "Confirm the backup folder" — choose **Confirm folder…** and pick the same
  folder (or another one) in the folder window;
- or in *F12 › Backup* choose **Choose…** and pick it again, or **Use default**.

Confirming needs the right to change the company configuration. A folder inside the data folder never
needs confirming. After upgrading, a backup folder chosen with an older version is confirmed the same
way, once.

### 13.2 Restoring

- With a company open: *Data › **Restore Backup*** — restore the file **as a new company**, or **replace**
  another company that is closed. The open company itself cannot be replaced (close it first, F3).
- With no company open: **Alt+R** on *Select a Company*.

Pevqori verifies the whole file before anything is replaced; the replaced company's folder is moved to the
`trash` folder, not erased. Replacing a password-protected company asks for an Owner's username and
password. A backup of one company can never replace a different company, and a backup made by a newer
version of Pevqori is refused until you upgrade. Attached files come back with the restore.

### 13.3 Check Books

*Data › **Check Books*** runs read-only checks: database integrity, every voucher balanced, bill-wise and
cost-centre allocations adding up, stock directions, GST postings matching the tax ledgers, openings
balanced, duplicate voucher numbers, the edit-log hash chain and every attached file present and
unchanged. Each problem is explained in plain words; **Alt+R** checks again.

### 13.4 Export and import (Excel / CSV)

- *Data › **Export Data*** — masters (**Alt+M**: groups, ledgers, stock items …, in exactly the layout of
  the import templates, so a workbook can be imported back) or vouchers of a period (**Alt+V**, optionally
  with optional and cancelled vouchers), as Excel or CSV; **Ctrl+A** exports. A sheet too large for Excel
  is refused with the advice to export as CSV or a shorter period.
- *Data › **Import from Excel*** — groups, ledgers, stock groups, units, godowns, cost centres, stock
  items, opening balances, opening stock, sales invoices, purchase invoices and vouchers (ledger lines).
  Choose the kind, download its template (**Alt+T**; an *Instructions* sheet explains every column), fill
  it in and choose the file (**Alt+O**). The preview checks every row through the same rules as manual
  entry and marks it *Ready*, *Check* (warning), *Exists* or *Error*. **Ctrl+A** imports. By default it is
  all or nothing; tick *Skip rows with errors* to import the good rows, *Update existing records* to alter
  masters that already exist, and *Save vouchers with warnings* to accept non-blocking warnings. Amounts
  are in rupees, dates `DD-MM-YYYY`. Invoices are posted exactly as if typed (GST, round-off and stock
  worked out by Pevqori). Example rows left in a template are refused.

Every export is recorded in the edit log and needs the *Export* permission; importing needs *Import* plus
the right to create the masters or vouchers concerned.

### 13.5 XML data import and export (moving to or from another accounting program)

**XML Data Import** (*Data › **XML Data Import***) brings your masters and vouchers across from your
previous accounting program, if it can export them as XML:

1. In your previous accounting program, open the company and export its **masters** and **transactions**
   as XML (see that program's help for its export command). Copy the `.xml` files to this computer.
2. Choose the file (**Alt+O**). The preview shows what is in it — masters by kind, vouchers by type and
   date range, how many already exist here, and issues — without writing anything.
3. Choose masters and / or vouchers, the period and what to do with vouchers already imported (skip, or
   update those that came from the earlier import — a voucher entered in Pevqori is never overwritten).
   **Alt+B** backs up first. **Ctrl+A** imports; a progress bar shows the vouchers.
4. Compare: **Alt+T** opens Pevqori's Trial Balance for the same period, to check against the Trial
   Balance of your previous program.

Vouchers are imported **as recorded** — amounts, tax, round-off and numbers are never recalculated.
Unbalanced vouchers, unknown ledgers or items, dates before the books begin or inside a locked period are
listed as issues and skipped. Points to know: a **debit note to a customer** is imported for value and GST
only (your previous program may have reduced stock for it; Pevqori does not, and the import log lists each
one); **job work** (Material In / Out) vouchers and **budgets** are not imported; foreign-currency amounts
come in as rupees; GST on advances recorded with the GST system ledgers is recognised, but stat-adjustment
journals arrive as plain journals. Features the data uses (cost centres, godowns, …) are switched on for
you.

**XML Data Export (for your CA or auditor).** Many chartered accountants finalise accounts in their own
accounting program. *Data › **XML Data Export*** writes your books as an XML file that such a program can
import:

1. Tick **Masters** (groups, ledgers with GST, address, bank and bill-wise opening details, units,
   godowns, stock groups and items with opening stock, cost centres, voucher types, aliases) and / or
   **Vouchers of the period**, and enter the period. **Ctrl+A** exports; you choose where to save.
2. Masters alone come as one `.xml` file. With vouchers you get a `.zip` holding `1-Masters.xml` and
   `2-Vouchers.xml` — extract it first (right-click › Extract All); the receiving program needs the `.xml`
   files, not the ZIP.
3. In the receiving program, open (or create) the company with the books-beginning date the screen shows
   under **Opening balances as on** and the same GST details, then import the masters from
   `1-Masters.xml` first and the transactions from `2-Vouchers.xml` after them.
4. Compare the Trial Balance and Stock Summary there with Pevqori's for the same period (**Alt+B** on the
   export screen opens Pevqori's Trial Balance).

**Opening balances.** If you export the vouchers of, say, 2026-27 while your books here began earlier, the
masters carry the balances as on 1-Apr-2026 — every ledger's balance on that day (last year's profit in
the Profit & Loss A/c), the bills still pending (an amount received or paid without a bill becomes one
opening bill called "On Account") and the stock in each godown and batch at its value — so your CA's
company can simply begin on that date. Masters exported on their own, or with vouchers from your first
day, carry the opening balances you entered.

Vouchers go exactly as recorded — the same tax, round-off, numbers, bill references, cost centres, cheque
details and stock lines; nothing is recalculated. The one exception is a Manufacturing Journal or Material
In / Out: its stock lines go at the cost Pevqori's stock reports show today, so if a purchase entered later
(back-dated) changed the cost of what was produced, the receiving company gets the corrected value and the
closing stock agrees. GST on advances received (Alt+J on a receipt), its adjustment on the invoice and a
refund of it come back as advances when the file is imported into Pevqori again. Freight or packing that
you include in the goods' taxable value stays on its own ledger, and the freight ledger is marked so that
the receiving program includes it in the assessable value too. Not exported: quotations, proforma
invoices and physical stock vouchers (the screen tells you how many were left out), e-invoice / e-way bill
details, an export's shipping bill number / date / port code (enter them again in the receiving program),
attachments, price lists, BOMs, budgets and scenarios, and foreign-currency amounts (exported in rupees).
POS bills go as ordinary sales vouchers with their payment entries. SEZ, deemed-export and UIN parties
arrive as Regular — set their party type there. For a credit or debit note the original invoice number
and date go in the voucher's Reference No. and Date.

The export has been tested by importing it back into an empty Pevqori company (same trial balance, stock
summary, GST returns and pending bills); it has not been tried against the receiving program itself, so
the first time import it into a **copy** of the company there and check.

### 13.6 Attaching bills, challans and other papers

Keep the purchase bill scan with the purchase, the signed delivery challan with the sale, the bank advice
with the payment, the agreement with the party's ledger:

- On a voucher, open it (Day Book › **Enter** or **Alt+Enter**) and press **Alt+F**; on a ledger or stock
  item form press **Alt+F**. In the Attachments screen **Alt+C** attaches a file (Windows' own file
  dialog), **Enter** or **Alt+O** opens it in the program Windows uses for it, **Alt+K** saves a copy
  elsewhere, **Alt+D** removes it.
- Allowed: PDF, pictures (JPG, PNG, GIF, WebP, TIFF, BMP), Excel / Word / OpenDocument files without
  macros or ActiveX controls, CSV, TXT, JSON and XML — up to 25 MB each and 50 per voucher or master.
  Programs, scripts, web pages and archives are refused, as is a program renamed to look like a PDF or an
  XML file that is really a web page. There is no preview inside Pevqori.
- The files are kept in the company's own folder (under `attachments`), go into every backup (and are
  encrypted with it when the backup has a password), and come back with a restore. **Check Books**
  confirms that every attached file is still there and unchanged. They are not part of the Excel or XML
  data exports.
- Attaching and removing appear in the voucher's or master's edit history (**Alt+H**). Files of a voucher
  in the locked period can be added but not removed. A voucher, ledger or item with files cannot be
  deleted until the files are removed (so a bill scan can never disappear with a deleted entry);
  cancelling a voucher keeps its files.
- *Reports › **Attachment Register*** lists every attached file with what it belongs to; **Alt+M** opens
  the voucher or master. **Alt+U** removes stored files nothing is attached to any more (left by an
  attach that could not finish) after showing how many and how large — attached files are never touched,
  and the removal is in the edit log.
- Who may do what: Accountants attach and remove, Data Entry users attach, Auditors only view (Owners can
  change this in the roles).

## 14. Security and users

### 14.1 Password protection

Protect a company when you create it (wizard step *Security*) or later in *Security › **Security
Settings*** › **Alt+O** (*Turn security on*): you create the first **Owner** with a username and password.
From then on Pevqori asks for a username and password to open the company. Turning security off again needs
an Owner to type their password.

*Security › **Security Settings*** also sets the password rules (minimum length 8–64, mixed case, a
symbol, expiry after 0–365 days; a password may not be the username or one of the last three), the
**lockout** after 3–10 wrong tries (default 5) for 1–60 minutes (default 5), and the **idle timeout**
(default 30 minutes; 5–240, or 0 for never). When the idle timeout ends a session, the company is locked
behind a login screen; logging in again as the same user resumes exactly where you were, unsaved work
included.

Protect the data folder itself with your Windows account and, ideally, BitLocker: a password inside Pevqori
does not stop someone who can copy the files. See [SECURITY.md](SECURITY.md) for the full picture.

### 14.2 Users and roles

*Security › **Users & Roles*** — **Ctrl+1** users, **Ctrl+2** roles; **Alt+C** creates, **Alt+A**
alters, **Alt+K** copies a role as a new one. The built-in roles:

| Role | Can do |
|---|---|
| **Owner** | Everything, including users, roles and security settings |
| **Accountant** | All accounting work; no security administration and no restoring of backups |
| **Data Entry** | Create masters and vouchers, attach files, view basic reports and GST |
| **Auditor** | Read-only: books, reports (including the Balance Sheet and P&L), GST, TDS reports, the edit log, and export |

Make your own roles from the permission list (masters, vouchers — including back-dated ones —, reports,
financial statements, GST filing, banking reconciliation, export, import, backup, restore, edit log,
period lock, TDS, attachments). Rules that protect you: only an Owner can create, change or reset another
Owner; nobody can change their own role; there is always at least one active Owner; you can only hand out
permissions you hold yourself. Users are never deleted (the edit log refers to them) — **deactivate**
them instead. Role and permission changes apply from the user's next login.

What a role does not allow is simply not offered: such actions are left out of the action bar (for
example *Create challan* or *Mark filed* for a user who may view but not file GST or TDS). On a form or
settings screen the user may only view, **Save** is greyed out with the permission it needs (or not
offered at all) and a "view only" note shows at the top; **Export** and **Print** stay visible and say
which permission they need.

*Security › **My Session*** shows who you are and your previous login; **Alt+W** changes your password,
**Alt+Q** logs out. The same is in the menu behind your initials (top right).

### 14.3 The edit log

Every create, alter, cancel and delete of a master, voucher, user or setting — and every import, export,
print, share, backup and restore — is written to the **edit log** in the same step. *Security › **Edit
Log*** lists it with filters (date, user, action, record type) and search (**Ctrl+F**); **Enter** shows
what changed, field by field; **Alt+H** shows the whole history of one record (also **Alt+H** on any
voucher or master); **Alt+E** exports and **Alt+P** prints. The log cannot be edited: each entry carries
a fingerprint of the one before (a hash chain). **Alt+V** (*Verify edit log*) recomputes the chain and
says in plain words whether any entry was altered, inserted or removed. Pevqori also keeps the latest
fingerprint outside the company file, so a rewritten or cut-short log is detected — see
[SECURITY.md](SECURITY.md) for exactly what is and is not detected.

## 15. Keyboard reference

The **F1** overlay in the app is generated from the same table as the global keys below.

### 15.1 Global keys (work on every screen of an open company)

| Key | Action |
|---|---|
| **Ctrl+G**, **Alt+G**, **Ctrl+K** | Go To — find any screen, report, master or voucher |
| **F2** | Change the working date |
| **Alt+F2** | Change the period |
| **Esc** | Back / close (asks before discarding unsaved changes) |
| **F4** | Contra |
| **F5** | Payment |
| **F6** | Receipt |
| **F7** | Journal |
| **F8** | Sales |
| **F9** | Purchase |
| **Ctrl+F8** | Credit Note |
| **Ctrl+F9** | Debit Note |
| **Alt+F5** | Sales Order |
| **Alt+F6** | Purchase Order |
| **Alt+F8** | Delivery Note |
| **Alt+F9** | Receipt Note |
| **Ctrl+F6** | Rejections In |
| **Ctrl+F5** | Rejections Out |
| **Alt+F7** | Stock Journal |
| **Ctrl+F7** | Physical Stock |
| **Ctrl+F10** | Memorandum |
| **F10** | Other vouchers… |
| **F3** | Switch company |
| **F11** | Features |
| **F12** | Configuration |
| **F1**, **Ctrl+H** | Keyboard shortcuts and help |
| **Ctrl+Q** | Quit Pevqori |

Screens never take these keys for themselves — with two kinds of exception: inside voucher entry the
voucher keys and F10 switch the voucher being entered and **F2** is the voucher date, F12 the voucher type
settings, and **Ctrl+H** switches single entry ↔ Dr / Cr.

Each of these keys also has a place in the top bar for the mouse: the date and period chips, the search
box (Go To), **Create ▾** (the everyday vouchers with their keys, and Other voucher… F10), the company
button (Switch company F3) and **?** (F1); F11 and F12 are under **More ▾** in the command bar.

### 15.2 Keys with one meaning across screens

Wherever a screen offers one of these actions, it is on this key. A screen that has nothing of the kind
(no voucher to cancel, nothing to share) may use the key for something of its own; such keys are listed
with the screen (15.4 and the sections above).

| Key | Meaning |
|---|---|
| **Enter** | Next field (forms); open / drill down (lists and reports) |
| **Shift+Enter** | Previous field |
| **Ctrl+Enter** | Next field from a multi-line box |
| **Ctrl+A** | Accept / save |
| **Ctrl+S** | Accept / save — the same as Ctrl+A, wherever Ctrl+A accepts or saves |
| **Alt+C** | Create a new master from a list or picker (ledger, item, …); on the Balance Sheet and P&L, a comparison column ("New Column") |
| **Alt+A** | Alter the selected voucher or master; in a tick list with nothing to alter (Print Cheques, E-payment File, Print batch, Reminders) tick / untick everything |
| **Alt+D** | Delete the master or voucher on screen (**Ctrl+D** also deletes in master lists) |
| **Ctrl+D** | Remove the line (voucher and grid rows) |
| **Alt+N**, **Ctrl+N** | Insert a line above |
| **Alt+2** | Duplicate the voucher |
| **Alt+X** | Cancel the voucher (keeps its number); in tree reports, expand / collapse all |
| **Alt+H** | Edit history of the voucher or master (needs the Edit Log permission) |
| **Alt+Enter** | View the voucher (read-only) |
| **Alt+M** | Open the report subject's master (ledger, item) |
| **Alt+F1** | Detailed / condensed |
| **Ctrl+1**, **Ctrl+2**, **Ctrl+3** … **Ctrl+9** | Switch view or tab (on Home: **Ctrl+1** Essentials, **Ctrl+2** All menus) |
| **Ctrl+F** | The screen's search box |
| **Alt+E** | Export (Excel / CSV / PDF; needs the Export permission) |
| **Alt+P** | Print (in voucher entry: the voucher being altered, or the one just saved) |
| **Ctrl+P** | Print the highlighted voucher (Day Book, voucher lists) |
| **Alt+W** | Share as PDF by e-mail or WhatsApp (voucher view, print preview, Statement of Account) |
| **↑**, **↓** | Move in lists and reports |
| **Alt+↓** | Open a list or calendar |
| **t** | Today, in a date box (also **5** = 5th of this month, **5-10** = 5 Oct, **+** / **−** a day) |
| **Y**, **Ctrl+A** | Yes / confirm in a dialog |
| **N**, **Esc** | No / cancel in a dialog |

Screens where one of these keys does something else: **Alt+W** switches to the other side on
*Receivables* / *Payables* (share a party's statement from *Statement of Account*), shows all customers
on *Payment Reminders*, cycles the expiry filter on *Batch Summary* and changes your password on *My
Session*; **Alt+X** discards typed dates on *Bank Reconciliation*, switches A/c Payee on *Print Cheques*,
cancels a leaf on the *Cheque Leaf Register*, opens GST exceptions on GSTR-1 / GSTR-3B, opens the
XML data import on *Import from Excel* and clears the filters on the *Edit Log*.

### 15.3 Voucher entry

| Key | Action |
|---|---|
| **Enter** / **Shift+Enter** | Next / previous field or cell; Enter on an empty row moves to the next part; Enter in the narration asks *Accept?* |
| **↑** / **↓** | Same column, previous / next row |
| **Ctrl+A** | Accept (save) |
| **F2** | Voucher date |
| **F4–F9**, **Ctrl+F8**, **F10** … | Change the voucher type (new vouchers; the date is kept) |
| **Alt+I** | Item invoice ↔ accounting invoice |
| **Ctrl+H** | Single entry ↔ Dr / Cr layout (payment, receipt, contra) |
| **Ctrl+I** | More details (sales-side documents: reference and reverse charge first; buyer, consignee, dispatch and e-way bill, orders, export, effective date) |
| **Ctrl+R** | Change the voucher number (also in the voucher view; needs *Change voucher numbers*) |
| **Alt+T** | Fill lines from open delivery / receipt notes or orders |
| **Alt+B** | Bill-wise details |
| **Alt+O** / **Alt+K** | Cost centres / bank instrument of the line |
| **Alt+J** | GST details (section 6.4) |
| **Alt+U** | TDS / TCS (section 7) |
| **Alt+Y** | Currency and rate, or a line's foreign amount (section 11) |
| **Ctrl+B** | Put the Dr / Cr difference on the last line |
| **Ctrl+D** / **Alt+N**, **Ctrl+N** | Remove / insert a line |
| **Alt+C** | Create the ledger or item typed in a picker (a customer or supplier in a small dialog) |
| **Ctrl+L** / **Ctrl+T** | Optional / post-dated |
| **F12** | Voucher type settings |
| **Alt+P** | Print the voucher being altered, or the one just saved |
| **Alt+W** | Share (e-mail / WhatsApp) the voucher being altered, or the one just saved |
| **Alt+D**, **Alt+X**, **Alt+2**, **Alt+H** | (when altering) delete, cancel, duplicate, edit history |

### 15.4 Keys of particular screens

| Screen | Keys |
|---|---|
| Select a Company | **Enter** open · **Alt+C** create · **Alt+R** restore · **Alt+D** delete |
| Gateway | **↑ ↓** move · **Enter** open · the highlighted letter opens its item |
| Day Book | **Enter** / **Alt+A** alter · **Alt+Enter** view · **Ctrl+P** print voucher · **Alt+2** duplicate · **Alt+D** delete · **Alt+T** today · **Alt+F2** period |
| Voucher view | **Alt+A** alter · **Alt+P** print · **Alt+W** share · **Alt+X** cancel · **Alt+D** delete · **Alt+2** duplicate · **Alt+H** history · **Alt+F** attachments · **Alt+K** print cheque · **Alt+T** POS return · **Alt+U** TDS / TCS · **Alt+Y** currency · **Alt+V** / **Alt+O** convert quotation · **Alt+S** quotation status · **Alt+R** make recurring · **Alt+L** pre-close order |
| Print preview | **Alt+P** print · **Alt+E** PDF · **Alt+W** share · **Alt+L** customize what prints · **PgUp / PgDn** previous / next · **Alt+T** template · **Alt+S** paper · **Ctrl+1/2/3** copies · **Alt+V** open voucher |
| Trial Balance | **Alt+F1** · **Alt+L** ledger-wise · **Alt+O** opening · **Alt+T** transactions · **Alt+Z** zero balances · **Alt+X** expand · **Alt+S** scenario · **Alt+B** budget |
| Balance Sheet / P&L | **Alt+F1** · **Alt+C** compare last year (Balance Sheet) · **Alt+V** vertical / horizontal (P&L) · **Alt+S** scenario · **Alt+B** budget |
| Ledger | **Alt+L** change ledger · **Alt+M** master · **Alt+Y** monthly summary · **Alt+A** alter voucher · **Alt+R** both currencies |
| Receivables / Payables | **Ctrl+1/2/3** parties / bills / ageing · **Alt+O** overdue only · **Alt+B** ageing periods · **Alt+S** statement · **Alt+L** ledger · **Alt+I** interest · **Alt+R** reminder · **Alt+W** other side |
| Bank Reconciliation | **Ctrl+1/2/3** views · **Alt+R** all to statement date · **Alt+X** discard typed dates · **Alt+I** import · **Alt+M** match · **Ctrl+A** save |
| Match Statement | **Ctrl+1…4** tabs · **Alt+M** auto-match · **Alt+L** look for a match · **Alt+V** / **Alt+B** create voucher(s) · **Alt+I** ignore · **Alt+U** unmatch · **Alt+D** delete imported statement |
| GSTR-1 / GSTR-3B | **Alt+F2** period · **Alt+J** JSON · **Alt+F** mark filed · **Alt+M** amendments (GSTR-1) · **Alt+S** set-off (GSTR-3B) · **Alt+X** exceptions |
| GST Set-off | **Alt+C** create challan · **Ctrl+A** post set-off · **Alt+V** open set-off journal · **Alt+L** cash ledger · **Alt+R** the return |
| e-Invoice / e-Way Bills | **Space** select · **Alt+S** select all ready · **Alt+J** JSON · **Alt+I** import IRP response · **Alt+K** mark IRN cancelled · **Alt+N** record e-way bill · **Alt+H** history |
| POS Counter | **Enter** add / pay · **↑ ↓ + −** · **Ctrl+A** payment · **Alt+U** customer · **Alt+Q** line · **Ctrl+D** remove · **Alt+F** find item · **Alt+O** hold · **Alt+L** held bills · **Alt+Z** clear · **Alt+P** reprint · **Alt+V** view · **Alt+T** return · **Alt+B** day-end · **Alt+S** settings |
| Print Cheques | **Space** leave out · **Alt+A** tick all · **Alt+X** A/c Payee on / off · **Ctrl+A** preview · **Alt+L** layouts |
| Backup | **Ctrl+A** back up now · **Alt+V** check backup · **Alt+R** restore · **Alt+K** check books · **Alt+F** folder · **Alt+S** settings |
| Edit Log | **Ctrl+F** search · **Alt+V** verify · **Alt+H** record history · **Alt+O** order · **Alt+X** clear filters · **Ctrl+PgUp / PgDn** pages |

## 16. Troubleshooting and FAQ

**Windows says "Windows protected your PC" when I run the installer.** The installer is not yet
code-signed. Click *More info › Run anyway* — see [INSTALL.md](INSTALL.md#windows-smartscreen).

**"… is open in another window. Close it there first."** Only one copy of Pevqori can have a company open at
a time; a lock file in the company folder enforces it (also when two computers share a network folder).
Close it in the other window or on the other computer. After a crash or power cut the stale lock is taken
over automatically — on another computer once it has not been refreshed for 15 minutes.

**Can two people work in the same company at once?** No. Pevqori is a single-user desktop program: one
company is open in one place at a time. Several people can use the same computer with their own logins.

**"This company was created by a newer version of Pevqori."** Install the newer version (or newer) on
this computer; an older version never writes into a newer company.

**"Another task is running in this company."** An Excel or XML data import cannot start while the company is
busy with another long task — for example the automatic backup that runs a few seconds after you open the
company or log in, an export, or another import. The message offers **Wait and retry**: Pevqori tries again
every 2 seconds (for up to 2 minutes) and starts the import as soon as the company is free.

**Closing Pevqori during a very long operation.** Pevqori finishes the automatic backup and closes the company
before it exits. If one very long database step is still running (a huge report or backup), closing waits
for it, but never longer than about 40 seconds; after that Pevqori exits anyway. Nothing saved is lost: an
unfinished step is undone the next time the company opens.

**"The accounting engine stopped unexpectedly and was restarted."** The calculating part of Pevqori runs
separately from the window; if it fails (for example out of memory on a huge export) it is restarted and
you are back at the company list. Open the company again and check your last entry — saved data is safe.

**I forgot my password.** Another Owner can reset it in *Security › **Users & Roles*** (it must then be
changed at the next login). Pevqori has no master password or back door: if the only Owner's password is
lost, the company cannot be opened. Keep a second Owner, or the password in a safe place.

**A key or menu item does nothing / is missing.** The feature may be off (F11 — the key tells you which
switch), you may lack the permission (ask an Owner), or a dialog is open. A predefined voucher type you
deactivated in *Masters › **Voucher Types*** is hidden from the Transactions menu and Go To (for users who
may view masters; others still see every type, as F10 does).

**Where are the logs?** *Utilities › **About Pevqori*** shows the logs folder (`%APPDATA%\Pevqori\logs`)
with a button to open it; the window's hidden menu (press and release Alt) also has *Help › Open Logs
Folder*. Logs never contain passwords or voucher data; send them when reporting a problem.

**My previous program's figures and Pevqori's differ after moving.** Compare the Trial Balance (Alt+T on
the XML Data Import screen) and read the import log: skipped vouchers (unbalanced, unknown masters, dates
before the books begin) and debit notes to customers (Pevqori does not move stock for them; your previous
program may have) are listed there.

**Excel shows my account numbers / GSTINs wrongly.** Excel drops leading zeros when it opens a CSV. Use
the `.xlsx` export, or import the column as *Text*.

**The thermal receipt is cut in the wrong place.** Set the roll's paper size in the printer's own
settings; some drivers ignore the page length Pevqori asks for.

**How do I move to a new computer?** Either make a backup and restore it there, or copy the whole data
folder (with Pevqori closed) and choose it at first launch (*Use the companies already in that folder*). A
backup folder chosen on the old computer must be confirmed on the new one (section 13.1).

**Other small things worth knowing.**

- **Party outstanding** — **Alt+F1** shows or hides settled bills (Alt+H means edit history everywhere).
- **Create ledger** from the dashboard's Get started card opens under Sundry Debtors; from a bank
  statement line it opens under Sundry Debtors (deposit), Indirect Incomes (interest the bank credited),
  Sundry Creditors (payment), Indirect Expenses (bank charges / fees) or Bank Accounts (contra). You can
  still change "Under".
- **Users and roles** — Alt+H on a role shows only that role's history, even when a deleted role once had
  the same number.

### Updating Pevqori

Pevqori goes online only when you ask it to (or after you turn on the weekly check below). To get a new version:

1. Open *Utilities › **About Pevqori*** (or Go To, Ctrl+G, "About") and click **Check for updates**. The
   window's hidden menu (press and release Alt) has the same thing under *Help › Check for Updates…*.
2. If a newer version exists, Pevqori shows its number, size and what is new. Click **Download update**;
   you can keep working while it downloads. The file is checked before it is used — if the check fails it is
   deleted and nothing is installed.
3. Click **Restart to update**. Pevqori first backs up the open company to its usual backup folder (untick
   *Back up the open company first* to skip it), asks about unsaved changes, closes, installs and opens
   again — about a minute. Or click **Install when I quit** to install the next time you close Pevqori.
   When an update is ready, Home also shows "Pevqori x.y.z is ready — Restart to update".

Your companies, data folder, backups and settings are kept. The first time you open About, Pevqori asks
whether to **check automatically once a week** — turn it on there or later with the switch in the same panel;
a weekly check still only downloads when you click **Download update**. No company data is ever sent: only
the version check and the download itself reach the internet (GitHub, where Pevqori is published).

If the panel says *Managed by your administrator*, updates are set for your computer by your IT team
([SECURITY.md](SECURITY.md#311-updates--srcmainupdates) describes the policy file); if it says *Updates are turned off…*, ask them. You can
always install a newer version by running its installer over the existing one ([INSTALL.md](INSTALL.md)).
