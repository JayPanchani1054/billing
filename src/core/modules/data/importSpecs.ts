/**
 * Import kinds and their column specifications. The same specs drive the downloadable templates
 * ('data.import.template'), header mapping during import, and the column layout of the masters export
 * (so an exported sheet can be imported back unchanged).
 *
 * Header matching is tolerant: case, spaces, '*', '(₹)', '(%)', '.', ':' and similar decorations are ignored,
 * and every column accepts a few common alternative spellings (aliases).
 */
import type { ImportColumnInfo, ImportColumnType, ImportKind, ImportKindInfo } from '../../../shared/types/data.ts';

export interface ColumnSpec {
  key: string;
  header: string;
  type: ImportColumnType;
  required?: boolean;
  aliases?: string[];
  choices?: string[];
  help: string;
  /** Values for the template's two example rows. */
  examples: [string | number | null, string | number | null];
}

export interface KindSpec {
  kind: ImportKind;
  label: string;
  sheetName: string;
  description: string;
  /** Column whose value groups several rows into one record. */
  groupBy?: string;
  columns: ColumnSpec[];
  instructions: string[];
}

const c = (
  key: string,
  header: string,
  type: ImportColumnType,
  help: string,
  examples: [string | number | null, string | number | null],
  extra: Partial<Pick<ColumnSpec, 'required' | 'aliases' | 'choices'>> = {},
): ColumnSpec => ({ key, header, type, help, examples, ...extra });

const YES_NO = ['Yes', 'No'];
export const REGISTRATION_CHOICES = ['Regular', 'Composition', 'Unregistered', 'Consumer', 'SEZ', 'Overseas', 'Deemed Export', 'UIN'];
export const TAXABILITY_CHOICES = ['Taxable', 'Exempt', 'Nil Rated', 'Non-GST'];
export const COSTING_CHOICES = ['Average Cost', 'FIFO', 'LIFO', 'Last Purchase Cost', 'Standard Cost'];
export const BILL_TYPE_CHOICES = ['New Ref', 'Agst Ref', 'Advance', 'On Account'];

const GST_COLUMNS = (ex: [ColumnSpec['examples'], ColumnSpec['examples'], ColumnSpec['examples']]): ColumnSpec[] => [
  c('hsnSac', 'HSN/SAC', 'text', 'HSN code (goods) or SAC (services), 4–8 digits.', ex[0], { aliases: ['hsn', 'sac', 'hsn code', 'hsn sac code', 'hsn/sac code'] }),
  c('gstRate', 'GST Rate', 'percent', 'Integrated GST rate in percent, e.g. 18 (CGST/SGST are half each).', ex[1], {
    aliases: ['gst %', 'gst rate %', 'tax rate', 'gst', 'igst rate', 'rate of tax'],
  }),
  c('taxability', 'Taxability', 'choice', 'Taxable (default), Exempt, Nil Rated or Non-GST.', ex[2], { choices: TAXABILITY_CHOICES }),
];

export const KIND_SPECS: Record<ImportKind, KindSpec> = {
  groups: {
    kind: 'groups',
    label: 'Account groups',
    sheetName: 'Groups',
    description: 'Ledger groups (sub-groups of the predefined groups, or new primary groups).',
    columns: [
      c('name', 'Name', 'text', 'Group name (unique).', ['Branch Debtors', 'Office Expenses'], { required: true, aliases: ['group name', 'group'] }),
      c('parent', 'Under', 'text', 'Parent group, e.g. Sundry Debtors. "Primary" (or blank) creates a primary group.', ['Sundry Debtors', 'Indirect Expenses'], {
        aliases: ['parent', 'parent group', 'under group'],
      }),
      c('alias', 'Alias', 'text', 'Optional alternative name.', [null, null]),
      c('nature', 'Nature', 'choice', 'Only for primary groups: Assets, Liabilities, Income or Expenses.', [null, null], {
        choices: ['Assets', 'Liabilities', 'Income', 'Expenses'],
      }),
      c('affectsGrossProfit', 'Affects Gross Profit', 'yesno', 'Only for primary income/expense groups (Trading account).', [null, null], { choices: YES_NO }),
    ],
    instructions: ['Groups are created in file order: list a parent group before its sub-groups.'],
  },

  ledgers: {
    kind: 'ledgers',
    label: 'Ledgers',
    sheetName: 'Ledgers',
    description: 'Ledger accounts: parties, banks, income, expenses, duties & taxes.',
    columns: [
      c('name', 'Name', 'text', 'Ledger name (unique).', ['Acme Traders', 'HDFC Bank Current A/c'], {
        required: true,
        aliases: ['ledger name', 'ledger', 'party name', 'account name', 'account'],
      }),
      c('parent', 'Under', 'text', 'Group, e.g. Sundry Debtors, Bank Accounts, Indirect Expenses.', ['Sundry Debtors', 'Bank Accounts'], {
        required: true,
        aliases: ['group', 'parent', 'group name', 'under group'],
      }),
      c('alias', 'Alias', 'text', "Optional alternative name(s); separate several aliases with ';'.", [null, null]),
      c('openingBalance', 'Opening Balance', 'amount', 'Opening balance in rupees as at the books beginning date (a negative amount means Cr).', [25000, 150000], {
        aliases: ['opening', 'opening bal', 'op balance', 'op bal', 'opening amount'],
      }),
      c('openingDrCr', 'Dr/Cr', 'drcr', 'Dr or Cr for the opening balance. Blank: the natural side of the group (Dr for assets/expenses).', ['Dr', 'Dr'], {
        aliases: ['dr cr', 'drcr', 'balance type', 'opening dr/cr'],
      }),
      c('billWise', 'Bill-wise', 'yesno', 'Maintain balances bill by bill (default Yes for debtors/creditors).', ['Yes', null], {
        aliases: ['bill wise', 'billwise', 'maintain bill-wise', 'maintain balances bill-by-bill'],
      }),
      c('creditDays', 'Credit Days', 'integer', 'Default credit period in days.', [30, null], { aliases: ['credit period', 'default credit days'] }),
      c('creditLimit', 'Credit Limit', 'amount', 'Credit limit in rupees.', [200000, null]),
      c('gstin', 'GSTIN', 'text', '15-character GSTIN/UIN of a registered party.', ['27AAPFU0939F1ZV', null], {
        aliases: ['gst no', 'gstin/uin', 'gstin uin', 'gst number', 'gst no.', 'party gstin'],
      }),
      c('registrationType', 'Registration Type', 'choice', 'GST registration of the party.', ['Regular', null], {
        choices: REGISTRATION_CHOICES,
        aliases: ['gst registration type', 'registration'],
      }),
      c('state', 'State', 'text', 'State name or GST state code (e.g. Maharashtra or 27).', ['Maharashtra', null], { aliases: ['state name', 'state code'] }),
      c('address', 'Address', 'text', 'Mailing address.', ['12 MG Road, Pune', null]),
      c('pincode', 'Pincode', 'text', '6-digit PIN code.', ['411001', null], { aliases: ['pin', 'pin code', 'postal code'] }),
      c('pan', 'PAN', 'text', 'PAN (filled from the GSTIN when blank).', [null, null], { aliases: ['pan no', 'income tax number', 'it pan'] }),
      c('contactPerson', 'Contact Person', 'text', 'Name of the contact person.', ['Ravi Kumar', null], { aliases: ['contact'] }),
      c('phone', 'Phone', 'text', 'Landline number.', [null, null], { aliases: ['phone no', 'telephone'] }),
      c('mobile', 'Mobile', 'text', 'Mobile number.', ['9876543210', null], { aliases: ['mobile no', 'cell'] }),
      c('email', 'Email', 'text', 'E-mail address.', ['accounts@acme.example', null], { aliases: ['e-mail', 'email id', 'email address'] }),
      c('bankAccountNo', 'Bank Account No', 'text', 'Bank ledgers only: account number.', [null, '50100012345678'], {
        aliases: ['account no', 'a/c no', 'account number', 'bank account number'],
      }),
      c('bankIfsc', 'IFSC', 'text', 'Bank ledgers only: IFSC.', [null, 'HDFC0000001'], { aliases: ['ifsc code'] }),
      c('bankName', 'Bank Name', 'text', 'Bank ledgers only: bank name.', [null, 'HDFC Bank']),
      c('bankBranch', 'Branch', 'text', 'Bank ledgers only: branch.', [null, 'MG Road'], { aliases: ['bank branch', 'branch name'] }),
      c('gstApplicable', 'GST Applicable', 'yesno', 'Sales/purchase/income/expense ledgers: GST details apply.', [null, null], { choices: YES_NO }),
      ...GST_COLUMNS([
        [null, null],
        [null, null],
        [null, null],
      ]),
      c('supplyType', 'Supply Type', 'choice', 'Goods or Services (income/expense ledgers).', [null, null], { choices: ['Goods', 'Services'], aliases: ['type of supply'] }),
      c('taxType', 'Tax Type', 'choice', 'Duties & Taxes ledgers: GST, TDS, TCS or Other.', [null, null], { choices: ['GST', 'TDS', 'TCS', 'Other'], aliases: ['type of duty/tax', 'type of duty'] }),
      c('dutyHead', 'Duty Head', 'choice', 'GST tax ledgers: IGST, CGST, SGST or Cess.', [null, null], { choices: ['IGST', 'CGST', 'SGST', 'Cess'], aliases: ['gst duty head', 'tax head'] }),
      c('active', 'Active', 'yesno', 'No = inactive (cannot be used in new vouchers). Default Yes.', [null, null], { choices: YES_NO }),
    ],
    instructions: [
      'The group (Under) must exist — create custom groups first with the Groups import.',
      'Opening balances must be as on the books beginning date. Use the Opening Balances import for bill-wise details.',
    ],
  },

  stock_groups: {
    kind: 'stock_groups',
    label: 'Stock groups',
    sheetName: 'Stock Groups',
    description: 'Groups of stock items (optionally with GST details inherited by their items).',
    columns: [
      c('name', 'Name', 'text', 'Stock group name (unique).', ['Kitchen Appliances', 'Mixers'], { required: true, aliases: ['stock group', 'group name'] }),
      c('parent', 'Under', 'text', 'Parent stock group (blank or "Primary" for a top-level group).', ['Primary', 'Kitchen Appliances'], { aliases: ['parent', 'parent group'] }),
      c('alias', 'Alias', 'text', 'Optional alternative name.', [null, null]),
      ...GST_COLUMNS([
        ['8509', null],
        [18, null],
        ['Taxable', null],
      ]),
    ],
    instructions: ['List a parent stock group before its sub-groups.'],
  },

  units: {
    kind: 'units',
    label: 'Units of measure',
    sheetName: 'Units',
    description: 'Simple units (Nos, Kg) and compound units (Box of 12 Nos).',
    columns: [
      c('symbol', 'Symbol', 'text', 'Unit symbol, e.g. Nos. Leave blank for a compound unit.', ['Ctn', null], { aliases: ['unit', 'unit name', 'name'] }),
      c('formalName', 'Formal Name', 'text', 'Full name, e.g. Cartons.', ['Cartons', null], { aliases: ['formal'] }),
      c('uqc', 'UQC', 'text', 'GST Unique Quantity Code, e.g. NOS, KGS, BOX (suggested when blank).', ['CTN', null], { aliases: ['unit quantity code', 'gst uqc'] }),
      c('decimals', 'Decimal Places', 'integer', 'Number of decimal places (0–4).', [0, null], { aliases: ['decimals', 'number of decimal places'] }),
      c('firstUnit', 'First Unit', 'text', 'Compound units: the larger unit (e.g. Ctn).', [null, 'Ctn'], { aliases: ['first'] }),
      c('conversion', 'Conversion', 'qty', 'Compound units: 1 first unit = this many second units.', [null, 12]),
      c('secondUnit', 'Second Unit', 'text', 'Compound units: the smaller unit (e.g. Nos).', [null, 'Nos'], { aliases: ['second'] }),
    ],
    instructions: ['A row with First Unit, Conversion and Second Unit creates a compound unit; list its simple units first.'],
  },

  godowns: {
    kind: 'godowns',
    label: 'Godowns',
    sheetName: 'Godowns',
    description: 'Storage locations.',
    columns: [
      c('name', 'Name', 'text', 'Godown name (unique).', ['Warehouse - Bhiwandi', 'Shop Floor'], { required: true, aliases: ['godown', 'godown name', 'location'] }),
      c('parent', 'Under', 'text', 'Parent godown (blank for top level).', [null, 'Warehouse - Bhiwandi'], { aliases: ['parent'] }),
      c('alias', 'Alias', 'text', 'Optional alternative name.', [null, null]),
      c('address', 'Address', 'text', 'Address of the godown.', ['Plot 5, Bhiwandi', null]),
    ],
    instructions: ['List a parent godown before its sub-godowns.'],
  },

  cost_centres: {
    kind: 'cost_centres',
    label: 'Cost centres',
    sheetName: 'Cost Centres',
    description: 'Cost centres for expense/income allocation.',
    columns: [
      c('name', 'Name', 'text', 'Cost centre name (unique).', ['Mumbai Branch', 'Marketing'], { required: true, aliases: ['cost centre', 'cost center', 'cost centre name'] }),
      c('category', 'Category', 'text', 'Cost category (default: Primary Cost Category). Created when missing.', [null, null], { aliases: ['cost category'] }),
      c('parent', 'Under', 'text', 'Parent cost centre (blank for top level).', [null, 'Mumbai Branch'], { aliases: ['parent'] }),
      c('alias', 'Alias', 'text', 'Optional alternative name.', [null, null]),
    ],
    instructions: ['List a parent cost centre before its sub-centres.'],
  },

  stock_items: {
    kind: 'stock_items',
    label: 'Stock items',
    sheetName: 'Stock Items',
    description: 'Goods and services you buy and sell, with GST details and an opening stock.',
    columns: [
      c('name', 'Name', 'text', 'Item name (unique).', ['Mixer Grinder 750W', 'Rice Bag 25kg'], { required: true, aliases: ['item', 'item name', 'stock item', 'product', 'product name'] }),
      c('parent', 'Under', 'text', 'Stock group (blank for none).', ['Kitchen Appliances', null], { aliases: ['stock group', 'group'] }),
      c('category', 'Category', 'text', 'Stock category (optional).', [null, null], { aliases: ['stock category'] }),
      c('unit', 'Unit', 'text', 'Base unit symbol, e.g. Nos, Kg (must exist).', ['Nos', 'Nos'], { required: true, aliases: ['uom', 'units', 'base unit', 'unit of measure'] }),
      c('alias', 'Alias', 'text', "Optional alternative name(s); separate several aliases with ';'.", [null, null]),
      c('partNo', 'Part No', 'text', 'Part number.', ['MX-750', null], { aliases: ['part number', 'sku', 'item code'] }),
      c('barcode', 'Barcode', 'text', 'Barcode / EAN.', [null, null], { aliases: ['ean'] }),
      c('description', 'Description', 'text', 'Description printed on invoices.', [null, null]),
      ...GST_COLUMNS([
        ['8509', '1006'],
        [18, 5],
        ['Taxable', 'Taxable'],
      ]),
      c('cessRate', 'Cess Rate', 'percent', 'GST compensation cess in percent.', [null, null], { aliases: ['cess %', 'cess'] }),
      c('isService', 'Service', 'yesno', 'Yes for a service (no stock is kept).', [null, null], { choices: YES_NO, aliases: ['is service'] }),
      c('costingMethod', 'Costing Method', 'choice', 'Average Cost (default), FIFO, LIFO, Last Purchase Cost or Standard Cost.', [null, null], { choices: COSTING_CHOICES }),
      c('mrp', 'MRP', 'amount', 'Maximum retail price in rupees.', [3499, null]),
      c('sellingPrice', 'Selling Price', 'amount', 'Default sales rate in rupees.', [2950, 1250], { aliases: ['sales price', 'sale rate', 'selling rate'] }),
      c('purchasePrice', 'Purchase Price', 'amount', 'Default purchase rate in rupees.', [2400, 1100], { aliases: ['purchase rate', 'cost price'] }),
      c('reorderLevel', 'Reorder Level', 'qty', 'Quantity at which to reorder.', [5, null]),
      c('openingQty', 'Opening Qty', 'qty', 'Opening stock quantity in the base unit (Main Location).', [10, 40], { aliases: ['opening quantity', 'opening stock'] }),
      c('openingRate', 'Opening Rate', 'number', 'Opening rate in rupees per unit.', [2400, 1100], { aliases: ['opening rate (per unit)'] }),
      c('openingValue', 'Opening Value', 'amount', 'Opening value in rupees (default quantity × rate).', [null, null]),
      c('godown', 'Godown', 'text', 'Godown of the opening stock (default Main Location).', [null, null], { aliases: ['location'] }),
      c('active', 'Active', 'yesno', 'No = inactive. Default Yes.', [null, null], { choices: YES_NO }),
    ],
    instructions: ['Units and stock groups must exist. For openings in several godowns or batches use the Stock Openings import.'],
  },

  opening_balances: {
    kind: 'opening_balances',
    label: 'Opening balances (with bills)',
    sheetName: 'Opening Balances',
    description: 'Ledger opening balances, optionally bill by bill (one row per bill).',
    groupBy: 'ledger',
    columns: [
      c('ledger', 'Ledger', 'text', 'Existing ledger name. Rows with the same ledger are combined.', ['Acme Traders', 'Acme Traders'], {
        required: true,
        aliases: ['ledger name', 'party', 'party name', 'name', 'account'],
      }),
      c('openingBalance', 'Opening Balance', 'amount', 'Total opening balance in rupees (blank: the sum of the bills).', [25000, null], { aliases: ['opening', 'balance'] }),
      c('drCr', 'Dr/Cr', 'drcr', 'Dr or Cr for the opening balance.', ['Dr', null], { aliases: ['dr cr', 'drcr', 'balance type'] }),
      c('billName', 'Bill Ref', 'text', 'Bill (invoice) reference.', ['INV-0911', 'INV-0950'], { aliases: ['bill name', 'bill no', 'invoice no', 'reference', 'ref no'] }),
      c('billDate', 'Bill Date', 'date', 'Bill date (on or before the books beginning date).', ['2026-02-10', '2026-03-05'], { aliases: ['invoice date', 'date'] }),
      c('dueDate', 'Due Date', 'date', 'Due date (optional).', ['2026-03-12', '2026-04-04'], { aliases: ['due on'] }),
      c('billAmount', 'Bill Amount', 'amount', 'Pending amount of the bill in rupees.', [10000, 15000], { aliases: ['pending amount', 'amount'] }),
      c('billDrCr', 'Bill Dr/Cr', 'drcr', 'Dr or Cr for the bill (default: same as the opening balance).', ['Dr', 'Dr']),
    ],
    instructions: ['The bills of a ledger must add up to its opening balance.', 'An existing opening balance is replaced only with "Update existing" on.'],
  },

  stock_openings: {
    kind: 'stock_openings',
    label: 'Opening stock',
    sheetName: 'Stock Openings',
    description: 'Opening stock per item, godown and batch (replaces the item’s opening stock).',
    groupBy: 'item',
    columns: [
      c('item', 'Item', 'text', 'Existing stock item. Rows with the same item are combined.', ['Mixer Grinder 750W', 'Mixer Grinder 750W'], {
        required: true,
        aliases: ['item name', 'stock item', 'product', 'name'],
      }),
      c('godown', 'Godown', 'text', 'Godown (default Main Location).', ['Main Location', 'Warehouse - Bhiwandi'], { aliases: ['location'] }),
      c('batch', 'Batch', 'text', 'Batch name (items maintained in batches).', [null, null], { aliases: ['batch name', 'batch no'] }),
      c('qty', 'Quantity', 'qty', 'Quantity in the base unit.', [6, 4], { required: true, aliases: ['qty', 'opening qty', 'opening quantity'] }),
      c('rate', 'Rate', 'number', 'Rate in rupees per unit.', [2400, 2400], { aliases: ['opening rate'] }),
      c('value', 'Value', 'amount', 'Value in rupees (default quantity × rate).', [null, null], { aliases: ['opening value', 'amount'] }),
      c('mfgDate', 'Mfg Date', 'date', 'Manufacturing date (batches).', [null, null], { aliases: ['manufacturing date'] }),
      c('expiryDate', 'Expiry Date', 'date', 'Expiry date (batches).', [null, null], { aliases: ['expiry', 'exp date'] }),
    ],
    instructions: ['All opening rows of an item are replaced by the rows in this file.'],
  },

  sales_invoices: {
    kind: 'sales_invoices',
    label: 'Sales invoices',
    sheetName: 'Sales Invoices',
    description: 'Sales invoices, one row per item or ledger line; GST is computed by Bahi ERP.',
    groupBy: 'invoiceNo',
    columns: [
      c('invoiceNo', 'Invoice No', 'text', 'Invoice number; rows with the same number form one invoice.', ['INV-101', 'INV-101'], {
        required: true,
        aliases: ['voucher no', 'voucher number', 'invoice number', 'bill no', 'inv no', 'number'],
      }),
      c('date', 'Date', 'date', 'Invoice date.', ['2026-04-05', '2026-04-05'], { required: true, aliases: ['invoice date', 'voucher date'] }),
      c('party', 'Party', 'text', 'Customer ledger (must exist), or Cash for a cash sale.', ['Acme Traders', 'Acme Traders'], {
        required: true,
        aliases: ['customer', 'party name', 'buyer', 'party ledger', 'party a/c name'],
      }),
      c('voucherType', 'Voucher Type', 'text', 'Voucher type (default Sales).', ['Sales', 'Sales'], { aliases: ['type', 'vch type'] }),
      c('item', 'Item', 'text', 'Stock item (blank for a ledger line such as freight).', ['Mixer Grinder 750W', null], { aliases: ['stock item', 'item name', 'product'] }),
      c('ledger', 'Ledger', 'text', 'Sales ledger for an item line (optional) or the ledger of a non-item line.', [null, 'Freight Outward'], {
        aliases: ['sales ledger', 'account', 'ledger name'],
      }),
      c('qty', 'Qty', 'qty', 'Quantity (item lines).', [2, null], { aliases: ['quantity'] }),
      c('rate', 'Rate', 'number', 'Rate in rupees per unit, excluding GST.', [2950, null], { aliases: ['price', 'unit price'] }),
      c('discountPct', 'Discount %', 'percent', 'Line discount in percent.', [null, null], { aliases: ['disc %', 'discount', 'disc'] }),
      c('amount', 'Amount', 'amount', 'Line value in rupees (item lines: overrides qty × rate; ledger lines: required).', [null, 500], { aliases: ['value', 'line amount', 'taxable value'] }),
      c('gstRate', 'GST Rate', 'percent', 'Override the GST rate of this line (blank: from the item/ledger).', [null, null], { aliases: ['gst %', 'tax rate'] }),
      c('godown', 'Godown', 'text', 'Godown (default Main Location).', [null, null], { aliases: ['location'] }),
      c('placeOfSupply', 'Place of Supply', 'text', 'State name or code (default: the party’s state).', [null, null], { aliases: ['pos', 'supply state'] }),
      c('narration', 'Narration', 'text', 'Narration (first row of the invoice).', ['Imported invoice', null], { aliases: ['remarks', 'notes'] }),
    ],
    instructions: [
      'Rows with the same Invoice No form one invoice. Item rows need Item, Qty and Rate; other rows need Ledger and Amount.',
      'GST, round-off and party totals are computed as when you enter the invoice yourself.',
      'The Invoice No is kept when the voucher type numbering allows typed numbers (Manual or Automatic with override); otherwise the next automatic number is used.',
    ],
  },

  purchase_invoices: {
    kind: 'purchase_invoices',
    label: 'Purchase invoices',
    sheetName: 'Purchase Invoices',
    description: 'Purchase bills, one row per item or ledger line; GST is computed by Bahi ERP.',
    groupBy: 'supplierInvoiceNo',
    columns: [
      c('supplierInvoiceNo', 'Supplier Invoice No', 'text', 'The supplier’s bill number; rows with the same supplier and number form one bill.', ['SS/2026/451', 'SS/2026/451'], {
        required: true,
        aliases: ['invoice no', 'bill no', 'supplier bill no', 'reference no', 'ref no', 'supplier invoice number'],
      }),
      c('date', 'Date', 'date', 'Voucher date (date of entry).', ['2026-04-03', '2026-04-03'], { required: true, aliases: ['voucher date', 'purchase date'] }),
      c('supplierInvoiceDate', 'Supplier Invoice Date', 'date', 'The supplier’s bill date (default: Date).', ['2026-04-02', '2026-04-02'], {
        aliases: ['invoice date', 'bill date', 'reference date'],
      }),
      c('party', 'Supplier', 'text', 'Supplier ledger (must exist).', ['Supreme Suppliers', 'Supreme Suppliers'], {
        required: true,
        aliases: ['party', 'party name', 'vendor', 'supplier name', 'party ledger'],
      }),
      c('voucherType', 'Voucher Type', 'text', 'Voucher type (default Purchase).', ['Purchase', 'Purchase'], { aliases: ['type', 'vch type'] }),
      c('item', 'Item', 'text', 'Stock item (blank for a ledger line).', ['Rice Bag 25kg', null], { aliases: ['stock item', 'item name', 'product'] }),
      c('ledger', 'Ledger', 'text', 'Purchase ledger for an item line (optional) or the ledger of a non-item line.', [null, 'Freight Inward'], {
        aliases: ['purchase ledger', 'account', 'ledger name'],
      }),
      c('qty', 'Qty', 'qty', 'Quantity (item lines).', [20, null], { aliases: ['quantity'] }),
      c('rate', 'Rate', 'number', 'Rate in rupees per unit, excluding GST.', [1100, null], { aliases: ['price', 'unit price'] }),
      c('discountPct', 'Discount %', 'percent', 'Line discount in percent.', [null, null], { aliases: ['disc %', 'discount', 'disc'] }),
      c('amount', 'Amount', 'amount', 'Line value in rupees (item lines: overrides qty × rate; ledger lines: required).', [null, 800], { aliases: ['value', 'line amount', 'taxable value'] }),
      c('gstRate', 'GST Rate', 'percent', 'Override the GST rate of this line.', [null, null], { aliases: ['gst %', 'tax rate'] }),
      c('godown', 'Godown', 'text', 'Godown (default Main Location).', [null, null], { aliases: ['location'] }),
      c('placeOfSupply', 'Place of Supply', 'text', 'State name or code (default: the supplier’s state).', [null, null], { aliases: ['pos', 'supply state'] }),
      c('narration', 'Narration', 'text', 'Narration (first row of the bill).', [null, null], { aliases: ['remarks', 'notes'] }),
    ],
    instructions: ['Rows with the same Supplier and Supplier Invoice No form one purchase voucher.'],
  },

  vouchers_ledger: {
    kind: 'vouchers_ledger',
    label: 'Journal / payment / receipt vouchers',
    sheetName: 'Vouchers',
    description: 'Accounting vouchers entered as Dr/Cr ledger lines (journal, payment, receipt, contra …).',
    groupBy: 'key',
    columns: [
      c('key', 'Voucher Key', 'text', 'Any text that is the same on all lines of one voucher (default: Voucher Type + Voucher No + Date).', ['J-1', 'J-1'], {
        aliases: ['voucher id', 'key', 'group'],
      }),
      c('date', 'Date', 'date', 'Voucher date.', ['2026-04-10', '2026-04-10'], { required: true, aliases: ['voucher date'] }),
      c('voucherType', 'Voucher Type', 'text', 'Journal, Payment, Receipt, Contra (or a custom type).', ['Journal', 'Journal'], { required: true, aliases: ['type', 'vch type'] }),
      c('number', 'Voucher No', 'text', 'Number to keep (when the type allows typed numbers).', [null, null], { aliases: ['voucher number', 'number', 'vch no'] }),
      c('ledger', 'Ledger', 'text', 'Ledger of this line (must exist).', ['Office Rent', 'Acme Traders'], { required: true, aliases: ['ledger name', 'account', 'particulars'] }),
      c('debit', 'Debit', 'amount', 'Debit amount in rupees.', [12000, null], { aliases: ['dr', 'dr amount', 'debit amount'] }),
      c('credit', 'Credit', 'amount', 'Credit amount in rupees.', [null, 12000], { aliases: ['cr', 'cr amount', 'credit amount'] }),
      c('narration', 'Narration', 'text', 'Narration (first line of the voucher).', ['Rent adjusted against receivable', null], { aliases: ['remarks', 'notes'] }),
      c('billType', 'Bill Type', 'choice', 'Bill-wise ledgers: New Ref, Agst Ref, Advance or On Account.', [null, 'Agst Ref'], {
        choices: BILL_TYPE_CHOICES,
        aliases: ['ref type', 'bill ref type', 'type of ref'],
      }),
      c('billName', 'Bill Name', 'text', 'Bill reference for New Ref / Agst Ref / Advance.', [null, 'INV-0911'], { aliases: ['bill ref', 'bill no', 'against bill'] }),
      c('instrumentNo', 'Cheque/Ref No', 'text', 'Cheque or transfer reference (bank lines).', [null, null], { aliases: ['cheque no', 'instrument no', 'utr', 'chq no'] }),
      c('instrumentDate', 'Cheque Date', 'date', 'Cheque / instrument date.', [null, null], { aliases: ['instrument date', 'chq date'] }),
      c('referenceNo', 'Reference No', 'text', 'Voucher reference (first line).', [null, null], { aliases: ['reference', 'ref'] }),
    ],
    instructions: ['Every voucher must balance: total Debit = total Credit.', 'Payment vouchers need a Cash/Bank credit; receipts a Cash/Bank debit.'],
  },
};

/** Column metadata for the renderer (data.import.kinds). */
export function kindInfo(spec: KindSpec): ImportKindInfo {
  const group = spec.groupBy ? spec.columns.find((col) => col.key === spec.groupBy) : undefined;
  return {
    kind: spec.kind,
    label: spec.label,
    description: spec.description,
    groupByHeader: group?.header ?? null,
    columns: spec.columns.map(
      (col): ImportColumnInfo => ({
        key: col.key,
        header: col.header,
        required: col.required === true,
        type: col.type,
        aliases: col.aliases ?? [],
        choices: col.choices,
        help: col.help,
      }),
    ),
  };
}

/** Header text → comparison key ('Opening Balance (₹) *' → 'opening balance'). */
export function headerKey(h: unknown): string {
  if (h === null || h === undefined) return '';
  return String(h)
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/\((₹|rs\.?|inr|%|rupees|in rupees|in ₹)\)/g, ' ')
    .replace(/[*:.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Map of header key → column key for a kind. */
export function headerIndex(spec: KindSpec): Map<string, string> {
  const map = new Map<string, string>();
  for (const col of spec.columns) {
    map.set(headerKey(col.header), col.key);
    map.set(headerKey(col.key), col.key);
  }
  for (const col of spec.columns) for (const a of col.aliases ?? []) if (!map.has(headerKey(a))) map.set(headerKey(a), col.key);
  return map;
}
