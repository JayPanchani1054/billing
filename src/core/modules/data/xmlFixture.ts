/**
 * Test helper (used by *.test.ts only): a realistic, hand-written XML data export — masters and a
 * month of transactions of "Shree Ganesh Appliances" (Maharashtra, books from 1-Apr-2026) — as
 * accounting programs write it: UTF-16LE without a BOM, CRLF line ends, '&#4;' markers, negative = Debit.
 *
 * Hand-verified figures (paise in the tests; rupees here):
 *  Openings  Cash 20,000 Dr · HDFC Bank 1,50,000 Dr · Acme Traders 25,000 Dr (bills INV-0911 10,000,
 *            INV-0950 15,000) · Supreme Suppliers 30,000 Cr (bill SS/451) · Capital 2,33,000 Cr
 *            Stock: Mixer 10 Nos × 2,400 = 24,000; Rice 40 Nos × 1,100 = 44,000 (Bhiwandi)
 *            Σ ledgers = 20,000 + 1,50,000 + 25,000 − 30,000 − 2,33,000 = −68,000 = −(stock 68,000) ✓
 *  S-1   5-Apr  Acme, 3 Mixer × 2,950.50 = 8,851.50; CGST 9% 796.635→796.64; SGST 796.64;
 *               8,851.50 + 1,593.28 = 10,444.78; round off 0.22 Cr → party 10,445.00 Dr (New Ref S-1)
 *  GS-1  10-Apr "GST Sales" Delhi Distributors (07), 10 Rice × 1,250 = 12,500 from Bhiwandi;
 *               IGST 5% 625 → 13,125 Dr
 *  P-1   3-Apr  Supreme, ref SS/2026/501, 20 Rice × 1,100 = 22,000; CGST 2.5% 550; SGST 550 → 23,100 Cr
 *  R-1   20-Apr Acme pays 20,000 into HDFC (cheque 123456): Agst INV-0911 10,000 + Agst S-1 10,000
 *  PY-1  25-Apr HDFC pays Supreme 30,000 (e-fund transfer), Agst SS/451
 *  C-1   28-Apr Cash 5,000 deposited into HDFC
 *  J-1   30-Apr Office Rent 12,000 Dr (cost centre Mumbai Branch) / Capital 12,000 Cr
 *  CN-1  2-May  Acme returns 1 Mixer × 2,950.50; CGST 9% 265.545→265.55; SGST 265.55 → 3,481.60;
 *               round off 0.40 Dr → 3,482.00 Cr, Agst INV-0950
 *  S-3   10-May optional sale (not in the books) · S-4 12-May cancelled · J-BAD 15-May unbalanced (skipped)
 *
 *  Expected after import:
 *   Acme 25,000 + 10,445 − 20,000 − 3,482 = 11,963 Dr = INV-0950 11,518 + S-1 445
 *   Supreme 30,000 Cr − 30,000 + 23,100 Cr = 23,100 Cr (SS/2026/501)
 *   Delhi 13,125 Dr (GS-1) · Cash 15,000 Dr · HDFC 1,50,000 + 20,000 − 30,000 + 5,000 = 1,45,000 Dr
 *   Stock: Mixer 10 − 3 + 1 = 8 · Rice 40 + 20 − 10 = 50
 */
import { makeGstin } from '../../testing/fixtures.ts';
import { MESSAGE_CLOSE, MESSAGE_OPEN, REQUEST_TAG } from './xmlFormat.ts';

export const ACME_GSTIN = makeGstin('27', 'AAFCA4321B');
export const SUPREME_GSTIN = makeGstin('27', 'AAECS5678K');
export const DELHI_GSTIN = makeGstin('07', 'AABCD1234E');

const masters = (): string => `
    ${MESSAGE_OPEN}
     <CURRENCY NAME="₹" RESERVEDNAME="">
      <MAILINGNAME>INR</MAILINGNAME>
      <ORIGINALNAME>₹</ORIGINALNAME>
     </CURRENCY>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <GROUP NAME="Sundry Debtors" RESERVEDNAME="Sundry Debtors">
      <PARENT>&#4; Current Assets</PARENT>
      <ISBILLWISEON>Yes</ISBILLWISEON>
      <ISREVENUE>No</ISREVENUE>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <LANGUAGENAME.LIST>
       <NAME.LIST TYPE="String">
        <NAME>Sundry Debtors</NAME>
       </NAME.LIST>
      </LANGUAGENAME.LIST>
     </GROUP>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <GROUP NAME="Mumbai Debtors" RESERVEDNAME="">
      <PARENT>Sundry Debtors</PARENT>
      <ISBILLWISEON>Yes</ISBILLWISEON>
      <ISREVENUE>No</ISREVENUE>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <LANGUAGENAME.LIST>
       <NAME.LIST TYPE="String">
        <NAME>Mumbai Debtors</NAME>
        <NAME>Local Customers</NAME>
       </NAME.LIST>
      </LANGUAGENAME.LIST>
     </GROUP>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <GROUP NAME="Branch Expenses" RESERVEDNAME="">
      <PARENT>&#4; Primary</PARENT>
      <ISREVENUE>Yes</ISREVENUE>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <AFFECTSGROSSPROFIT>No</AFFECTSGROSSPROFIT>
     </GROUP>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <UNIT NAME="Nos" RESERVEDNAME="">
      <ORIGINALNAME>Numbers</ORIGINALNAME>
      <GSTREPUOM>NOS-NUMBERS</GSTREPUOM>
      <ISSIMPLEUNIT>Yes</ISSIMPLEUNIT>
      <DECIMALPLACES> 0</DECIMALPLACES>
     </UNIT>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <UNIT NAME="Pkt" RESERVEDNAME="">
      <ORIGINALNAME>Packets</ORIGINALNAME>
      <GSTREPUOM>PAC-PACKS</GSTREPUOM>
      <ISSIMPLEUNIT>Yes</ISSIMPLEUNIT>
      <DECIMALPLACES> 0</DECIMALPLACES>
     </UNIT>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <UNIT NAME="Ctn" RESERVEDNAME="">
      <ORIGINALNAME>Cartons</ORIGINALNAME>
      <GSTREPUOM>CTN-CARTONS</GSTREPUOM>
      <ISSIMPLEUNIT>Yes</ISSIMPLEUNIT>
      <DECIMALPLACES> 0</DECIMALPLACES>
     </UNIT>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <UNIT NAME="Ctn of 12 Pkt" RESERVEDNAME="">
      <ISSIMPLEUNIT>No</ISSIMPLEUNIT>
      <BASEUNITS>Ctn</BASEUNITS>
      <ADDITIONALUNITS>Pkt</ADDITIONALUNITS>
      <CONVERSION> 12</CONVERSION>
     </UNIT>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <GODOWN NAME="Main Location" RESERVEDNAME="">
      <PARENT/>
     </GODOWN>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <GODOWN NAME="Bhiwandi Warehouse" RESERVEDNAME="">
      <ADDRESS.LIST TYPE="String">
       <ADDRESS>Plot 5, MIDC</ADDRESS>
       <ADDRESS>Bhiwandi</ADDRESS>
      </ADDRESS.LIST>
      <PARENT/>
     </GODOWN>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <STOCKGROUP NAME="Kitchen Appliances" RESERVEDNAME="">
      <PARENT/>
      <GSTAPPLICABLE>&#4; Applicable</GSTAPPLICABLE>
      <GSTDETAILS.LIST>
       <APPLICABLEFROM>20170701</APPLICABLEFROM>
       <HSNCODE>8509</HSNCODE>
       <TAXABILITY>Taxable</TAXABILITY>
       <STATEWISEDETAILS.LIST>
        <STATENAME>&#4; Any</STATENAME>
        <RATEDETAILS.LIST>
         <GSTRATEDUTYHEAD>Central Tax</GSTRATEDUTYHEAD>
         <GSTRATE> 9</GSTRATE>
        </RATEDETAILS.LIST>
        <RATEDETAILS.LIST>
         <GSTRATEDUTYHEAD>State Tax</GSTRATEDUTYHEAD>
         <GSTRATE> 9</GSTRATE>
        </RATEDETAILS.LIST>
        <RATEDETAILS.LIST>
         <GSTRATEDUTYHEAD>Integrated Tax</GSTRATEDUTYHEAD>
         <GSTRATE> 18</GSTRATE>
        </RATEDETAILS.LIST>
       </STATEWISEDETAILS.LIST>
      </GSTDETAILS.LIST>
     </STOCKGROUP>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <STOCKITEM NAME="Mixer Grinder 750W" RESERVEDNAME="">
      <PARENT>Kitchen Appliances</PARENT>
      <CATEGORY>&#4; Not Applicable</CATEGORY>
      <GSTAPPLICABLE>&#4; Applicable</GSTAPPLICABLE>
      <BASEUNITS>Nos</BASEUNITS>
      <COSTINGMETHOD>Avg. Cost</COSTINGMETHOD>
      <OPENINGBALANCE> 10 Nos</OPENINGBALANCE>
      <OPENINGVALUE>-24000.00</OPENINGVALUE>
      <OPENINGRATE>2400.00/Nos</OPENINGRATE>
      <GSTDETAILS.LIST>
       <APPLICABLEFROM>20170701</APPLICABLEFROM>
       <HSNCODE>8509</HSNCODE>
       <TAXABILITY>Taxable</TAXABILITY>
       <STATEWISEDETAILS.LIST>
        <STATENAME>&#4; Any</STATENAME>
        <RATEDETAILS.LIST>
         <GSTRATEDUTYHEAD>Integrated Tax</GSTRATEDUTYHEAD>
         <GSTRATE> 18</GSTRATE>
        </RATEDETAILS.LIST>
       </STATEWISEDETAILS.LIST>
      </GSTDETAILS.LIST>
     </STOCKITEM>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <STOCKITEM NAME="Rice Bag 25kg" RESERVEDNAME="">
      <PARENT/>
      <GSTAPPLICABLE>&#4; Applicable</GSTAPPLICABLE>
      <BASEUNITS>Nos</BASEUNITS>
      <OPENINGBALANCE> 40 Nos</OPENINGBALANCE>
      <OPENINGVALUE>-44000.00</OPENINGVALUE>
      <OPENINGRATE>1100.00/Nos</OPENINGRATE>
      <GSTDETAILS.LIST>
       <APPLICABLEFROM>20170701</APPLICABLEFROM>
       <HSNCODE>1006</HSNCODE>
       <TAXABILITY>Taxable</TAXABILITY>
       <STATEWISEDETAILS.LIST>
        <STATENAME>&#4; Any</STATENAME>
        <RATEDETAILS.LIST>
         <GSTRATEDUTYHEAD>Integrated Tax</GSTRATEDUTYHEAD>
         <GSTRATE> 5</GSTRATE>
        </RATEDETAILS.LIST>
       </STATEWISEDETAILS.LIST>
      </GSTDETAILS.LIST>
      <BATCHALLOCATIONS.LIST>
       <GODOWNNAME>Bhiwandi Warehouse</GODOWNNAME>
       <BATCHNAME>Primary Batch</BATCHNAME>
       <OPENINGBALANCE> 40 Nos</OPENINGBALANCE>
       <OPENINGVALUE>-44000.00</OPENINGVALUE>
       <OPENINGRATE>1100.00/Nos</OPENINGRATE>
      </BATCHALLOCATIONS.LIST>
     </STOCKITEM>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <COSTCATEGORY NAME="Primary Cost Category" RESERVEDNAME="">
      <ALLOCATEREVENUE>Yes</ALLOCATEREVENUE>
     </COSTCATEGORY>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <COSTCENTRE NAME="Mumbai Branch" RESERVEDNAME="">
      <PARENT/>
      <CATEGORY>Primary Cost Category</CATEGORY>
     </COSTCENTRE>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <VOUCHERTYPE NAME="GST Sales" RESERVEDNAME="">
      <PARENT>Sales</PARENT>
      <NUMBERINGMETHOD>Automatic (Manual Override)</NUMBERINGMETHOD>
      <ISACTIVE>Yes</ISACTIVE>
     </VOUCHERTYPE>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <LEDGER NAME="Cash" RESERVEDNAME="Cash">
      <PARENT>Cash-in-Hand</PARENT>
      <OPENINGBALANCE>-20000.00</OPENINGBALANCE>
     </LEDGER>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <LEDGER NAME="Profit &amp; Loss A/c" RESERVEDNAME="Profit &amp; Loss A/c">
      <PARENT/>
      <OPENINGBALANCE>0</OPENINGBALANCE>
     </LEDGER>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <LEDGER NAME="HDFC Bank" RESERVEDNAME="">
      <PARENT>Bank Accounts</PARENT>
      <BANKDETAILS>50100012345678</BANKDETAILS>
      <IFSCODE>HDFC0000001</IFSCODE>
      <BANKINGCONFIGBANK>HDFC Bank</BANKINGCONFIGBANK>
      <BRANCHNAME>MG Road</BRANCHNAME>
      <OPENINGBALANCE>-150000.00</OPENINGBALANCE>
     </LEDGER>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <LEDGER NAME="Capital - Ramesh Patil" RESERVEDNAME="">
      <PARENT>Capital Account</PARENT>
      <OPENINGBALANCE>233000.00</OPENINGBALANCE>
     </LEDGER>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <LEDGER NAME="Acme Traders" RESERVEDNAME="">
      <ADDRESS.LIST TYPE="String">
       <ADDRESS>12 MG Road</ADDRESS>
       <ADDRESS>Pune</ADDRESS>
      </ADDRESS.LIST>
      <PARENT>Mumbai Debtors</PARENT>
      <LEDSTATENAME>Maharashtra</LEDSTATENAME>
      <PINCODE>411001</PINCODE>
      <INCOMETAXNUMBER>AAFCA4321B</INCOMETAXNUMBER>
      <GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>
      <PARTYGSTIN>${ACME_GSTIN}</PARTYGSTIN>
      <LEDGERPHONE>020-2550000</LEDGERPHONE>
      <LEDGERMOBILE>9876543210</LEDGERMOBILE>
      <EMAIL>accounts@acme.example</EMAIL>
      <LEDGERCONTACT>Ravi Kumar</LEDGERCONTACT>
      <ISBILLWISEON>Yes</ISBILLWISEON>
      <BILLCREDITPERIOD>30 Days</BILLCREDITPERIOD>
      <OPENINGBALANCE>-25000.00</OPENINGBALANCE>
      <BILLALLOCATIONS.LIST>
       <NAME>INV-0911</NAME>
       <BILLDATE>20260210</BILLDATE>
       <BILLCREDITPERIOD>30 Days</BILLCREDITPERIOD>
       <OPENINGBALANCE>-10000.00</OPENINGBALANCE>
      </BILLALLOCATIONS.LIST>
      <BILLALLOCATIONS.LIST>
       <NAME>INV-0950</NAME>
       <BILLDATE>20260305</BILLDATE>
       <OPENINGBALANCE>-15000.00</OPENINGBALANCE>
      </BILLALLOCATIONS.LIST>
     </LEDGER>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <LEDGER NAME="Supreme Suppliers" RESERVEDNAME="">
      <PARENT>Sundry Creditors</PARENT>
      <LEDGSTREGDETAILS.LIST>
       <APPLICABLEFROM>20170701</APPLICABLEFROM>
       <GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>
       <STATE>Maharashtra</STATE>
       <GSTIN>${SUPREME_GSTIN}</GSTIN>
      </LEDGSTREGDETAILS.LIST>
      <ISBILLWISEON>Yes</ISBILLWISEON>
      <OPENINGBALANCE>30000.00</OPENINGBALANCE>
      <BILLALLOCATIONS.LIST>
       <NAME>SS/451</NAME>
       <BILLDATE>20260320</BILLDATE>
       <OPENINGBALANCE>30000.00</OPENINGBALANCE>
      </BILLALLOCATIONS.LIST>
     </LEDGER>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <LEDGER NAME="Delhi Distributors" RESERVEDNAME="">
      <PARENT>Sundry Debtors</PARENT>
      <LEDSTATENAME>Delhi</LEDSTATENAME>
      <GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>
      <PARTYGSTIN>${DELHI_GSTIN}</PARTYGSTIN>
      <ISBILLWISEON>Yes</ISBILLWISEON>
     </LEDGER>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <LEDGER NAME="Sales GST 18%" RESERVEDNAME="">
      <PARENT>Sales Accounts</PARENT>
      <GSTAPPLICABLE>&#4; Applicable</GSTAPPLICABLE>
      <GSTTYPEOFSUPPLY>Goods</GSTTYPEOFSUPPLY>
      <GSTDETAILS.LIST>
       <APPLICABLEFROM>20170701</APPLICABLEFROM>
       <TAXABILITY>Taxable</TAXABILITY>
       <STATEWISEDETAILS.LIST>
        <RATEDETAILS.LIST>
         <GSTRATEDUTYHEAD>Integrated Tax</GSTRATEDUTYHEAD>
         <GSTRATE> 18</GSTRATE>
        </RATEDETAILS.LIST>
       </STATEWISEDETAILS.LIST>
      </GSTDETAILS.LIST>
     </LEDGER>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <LEDGER NAME="Purchase GST 5%" RESERVEDNAME="">
      <PARENT>Purchase Accounts</PARENT>
      <GSTAPPLICABLE>&#4; Applicable</GSTAPPLICABLE>
      <GSTTYPEOFSUPPLY>Goods</GSTTYPEOFSUPPLY>
     </LEDGER>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <LEDGER NAME="CGST" RESERVEDNAME="">
      <PARENT>Duties &amp; Taxes</PARENT>
      <TAXTYPE>GST</TAXTYPE>
      <GSTDUTYHEAD>Central Tax</GSTDUTYHEAD>
     </LEDGER>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <LEDGER NAME="SGST" RESERVEDNAME="">
      <PARENT>Duties &amp; Taxes</PARENT>
      <TAXTYPE>GST</TAXTYPE>
      <GSTDUTYHEAD>State Tax</GSTDUTYHEAD>
     </LEDGER>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <LEDGER NAME="IGST" RESERVEDNAME="">
      <PARENT>Duties &amp; Taxes</PARENT>
      <TAXTYPE>GST</TAXTYPE>
      <GSTDUTYHEAD>Integrated Tax</GSTDUTYHEAD>
     </LEDGER>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <LEDGER NAME="Round Off" RESERVEDNAME="">
      <PARENT>Indirect Expenses</PARENT>
     </LEDGER>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <LEDGER NAME="Office Rent" RESERVEDNAME="">
      <PARENT>Branch Expenses</PARENT>
      <ISCOSTCENTRESON>Yes</ISCOSTCENTRESON>
     </LEDGER>
    ${MESSAGE_CLOSE}
    ${MESSAGE_OPEN}
     <BUDGET NAME="FY 2026-27 Budget" RESERVEDNAME="">
      <PARENT/>
     </BUDGET>
    ${MESSAGE_CLOSE}`;

interface Line {
  ledger: string;
  /** XML sign: negative = Dr. */
  amount: string;
  extra?: string;
}

const entry = (l: Line, tag = 'LEDGERENTRIES.LIST'): string => `
      <${tag}>
       <LEDGERNAME>${l.ledger}</LEDGERNAME>
       <ISDEEMEDPOSITIVE>${l.amount.startsWith('-') ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
       <AMOUNT>${l.amount}</AMOUNT>${l.extra ?? ''}
      </${tag}>`;

const bill = (type: string, name: string, amount: string): string => `
       <BILLALLOCATIONS.LIST>
        <NAME>${name}</NAME>
        <BILLTYPE>${type}</BILLTYPE>
        <AMOUNT>${amount}</AMOUNT>
       </BILLALLOCATIONS.LIST>`;

const item = (o: { name: string; qty: number; rate: string; amount: string; ledger: string; godown?: string; deemedPositive: boolean }): string => `
      <ALLINVENTORYENTRIES.LIST>
       <STOCKITEMNAME>${o.name}</STOCKITEMNAME>
       <ISDEEMEDPOSITIVE>${o.deemedPositive ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
       <RATE>${o.rate}/Nos</RATE>
       <AMOUNT>${o.amount}</AMOUNT>
       <ACTUALQTY> ${o.qty} Nos</ACTUALQTY>
       <BILLEDQTY> ${o.qty} Nos</BILLEDQTY>
       <BATCHALLOCATIONS.LIST>
        <GODOWNNAME>${o.godown ?? 'Main Location'}</GODOWNNAME>
        <BATCHNAME>Primary Batch</BATCHNAME>
        <AMOUNT>${o.amount}</AMOUNT>
        <ACTUALQTY> ${o.qty} Nos</ACTUALQTY>
        <BILLEDQTY> ${o.qty} Nos</BILLEDQTY>
       </BATCHALLOCATIONS.LIST>
       <ACCOUNTINGALLOCATIONS.LIST>
        <LEDGERNAME>${o.ledger}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>${o.deemedPositive ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
        <AMOUNT>${o.amount}</AMOUNT>
       </ACCOUNTINGALLOCATIONS.LIST>
      </ALLINVENTORYENTRIES.LIST>`;

const voucher = (o: { type: string; date: string; number: string; guid: string; party?: string; ref?: string; narration?: string; flags?: string; body: string; invoice?: boolean }): string => `
    ${MESSAGE_OPEN}
     <VOUCHER REMOTEID="${o.guid}" VCHKEY="${o.guid}:00000008" VCHTYPE="${o.type}" ACTION="Create" OBJVIEW="${o.invoice ? 'Invoice Voucher View' : 'Accounting Voucher View'}">
      <DATE>${o.date}</DATE>
      <GUID>${o.guid}</GUID>
      <VOUCHERTYPENAME>${o.type}</VOUCHERTYPENAME>
      <VOUCHERNUMBER>${o.number}</VOUCHERNUMBER>${o.party ? `\n      <PARTYLEDGERNAME>${o.party}</PARTYLEDGERNAME>` : ''}${o.ref ? `\n      <REFERENCE>${o.ref}</REFERENCE>` : ''}${o.narration ? `\n      <NARRATION>${o.narration}</NARRATION>` : ''}
      <ISINVOICE>${o.invoice ? 'Yes' : 'No'}</ISINVOICE>${o.flags ?? ''}${o.body}
     </VOUCHER>
    ${MESSAGE_CLOSE}`;

const transactions = (): string =>
  [
    voucher({
      type: 'Sales',
      date: '20260405',
      number: 'S-1',
      guid: 'a1b2c3d4-0000-0000-0000-000000000001-00000101',
      party: 'Acme Traders',
      narration: 'Being 3 mixers sold',
      invoice: true,
      body:
        item({ name: 'Mixer Grinder 750W', qty: 3, rate: '2950.50', amount: '8851.50', ledger: 'Sales GST 18%', deemedPositive: false }) +
        entry({ ledger: 'Acme Traders', amount: '-10445.00', extra: bill('New Ref', 'S-1', '-10445.00') }) +
        entry({ ledger: 'CGST', amount: '796.64' }) +
        entry({ ledger: 'SGST', amount: '796.64' }) +
        entry({ ledger: 'Round Off', amount: '0.22' }),
    }),
    voucher({
      type: 'GST Sales',
      date: '20260410',
      number: 'GS-1',
      guid: 'a1b2c3d4-0000-0000-0000-000000000001-00000102',
      party: 'Delhi Distributors',
      invoice: true,
      flags: '\n      <PLACEOFSUPPLY>Delhi</PLACEOFSUPPLY>',
      body:
        item({ name: 'Rice Bag 25kg', qty: 10, rate: '1250.00', amount: '12500.00', ledger: 'Sales', godown: 'Bhiwandi Warehouse', deemedPositive: false }) +
        entry({ ledger: 'Delhi Distributors', amount: '-13125.00', extra: bill('New Ref', 'GS-1', '-13125.00') }) +
        entry({ ledger: 'IGST', amount: '625.00' }),
    }),
    voucher({
      type: 'Purchase',
      date: '20260403',
      number: 'P-1',
      guid: 'a1b2c3d4-0000-0000-0000-000000000001-00000103',
      party: 'Supreme Suppliers',
      ref: 'SS/2026/501',
      invoice: true,
      body:
        item({ name: 'Rice Bag 25kg', qty: 20, rate: '1100.00', amount: '-22000.00', ledger: 'Purchase GST 5%', deemedPositive: true }) +
        entry({ ledger: 'Supreme Suppliers', amount: '23100.00', extra: bill('New Ref', 'SS/2026/501', '23100.00') }) +
        entry({ ledger: 'CGST', amount: '-550.00' }) +
        entry({ ledger: 'SGST', amount: '-550.00' }),
    }),
    voucher({
      type: 'Receipt',
      date: '20260420',
      number: 'R-1',
      guid: 'a1b2c3d4-0000-0000-0000-000000000001-00000104',
      narration: 'Cheque 123456 received',
      body:
        entry({ ledger: 'Acme Traders', amount: '20000.00', extra: bill('Agst Ref', 'INV-0911', '10000.00') + bill('Agst Ref', 'S-1', '10000.00') }, 'ALLLEDGERENTRIES.LIST') +
        entry(
          {
            ledger: 'HDFC Bank',
            amount: '-20000.00',
            extra: `
       <BANKALLOCATIONS.LIST>
        <DATE>20260420</DATE>
        <INSTRUMENTDATE>20260419</INSTRUMENTDATE>
        <TRANSACTIONTYPE>Cheque</TRANSACTIONTYPE>
        <INSTRUMENTNUMBER>123456</INSTRUMENTNUMBER>
        <BANKNAME>State Bank of India</BANKNAME>
        <AMOUNT>-20000.00</AMOUNT>
       </BANKALLOCATIONS.LIST>`,
          },
          'ALLLEDGERENTRIES.LIST',
        ),
    }),
    voucher({
      type: 'Payment',
      date: '20260425',
      number: 'PY-1',
      guid: 'a1b2c3d4-0000-0000-0000-000000000001-00000105',
      body:
        entry({ ledger: 'Supreme Suppliers', amount: '-30000.00', extra: bill('Agst Ref', 'SS/451', '-30000.00') }, 'ALLLEDGERENTRIES.LIST') +
        entry(
          {
            ledger: 'HDFC Bank',
            amount: '30000.00',
            extra: `
       <BANKALLOCATIONS.LIST>
        <DATE>20260425</DATE>
        <INSTRUMENTDATE>20260425</INSTRUMENTDATE>
        <TRANSACTIONTYPE>e-Fund Transfer</TRANSACTIONTYPE>
        <INSTRUMENTNUMBER>UTR2026042500001</INSTRUMENTNUMBER>
        <AMOUNT>30000.00</AMOUNT>
       </BANKALLOCATIONS.LIST>`,
          },
          'ALLLEDGERENTRIES.LIST',
        ),
    }),
    voucher({
      type: 'Contra',
      date: '20260428',
      number: 'C-1',
      guid: 'a1b2c3d4-0000-0000-0000-000000000001-00000106',
      body: entry({ ledger: 'HDFC Bank', amount: '-5000.00' }, 'ALLLEDGERENTRIES.LIST') + entry({ ledger: 'Cash', amount: '5000.00' }, 'ALLLEDGERENTRIES.LIST'),
    }),
    voucher({
      type: 'Journal',
      date: '20260430',
      number: 'J-1',
      guid: 'a1b2c3d4-0000-0000-0000-000000000001-00000107',
      narration: 'April rent paid by the proprietor',
      body:
        entry(
          {
            ledger: 'Office Rent',
            amount: '-12000.00',
            extra: `
       <CATEGORYALLOCATIONS.LIST>
        <CATEGORY>Primary Cost Category</CATEGORY>
        <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
        <COSTCENTREALLOCATIONS.LIST>
         <NAME>Mumbai Branch</NAME>
         <AMOUNT>-12000.00</AMOUNT>
        </COSTCENTREALLOCATIONS.LIST>
       </CATEGORYALLOCATIONS.LIST>`,
          },
          'ALLLEDGERENTRIES.LIST',
        ) + entry({ ledger: 'Capital - Ramesh Patil', amount: '12000.00' }, 'ALLLEDGERENTRIES.LIST'),
    }),
    voucher({
      type: 'Credit Note',
      date: '20260502',
      number: 'CN-1',
      guid: 'a1b2c3d4-0000-0000-0000-000000000001-00000108',
      party: 'Acme Traders',
      narration: 'One mixer returned (damaged)',
      invoice: true,
      body:
        item({ name: 'Mixer Grinder 750W', qty: 1, rate: '2950.50', amount: '-2950.50', ledger: 'Sales GST 18%', deemedPositive: true }) +
        entry({ ledger: 'Acme Traders', amount: '3482.00', extra: bill('Agst Ref', 'INV-0950', '3482.00') }) +
        entry({ ledger: 'CGST', amount: '-265.55' }) +
        entry({ ledger: 'SGST', amount: '-265.55' }) +
        entry({ ledger: 'Round Off', amount: '-0.40' }),
    }),
    voucher({
      type: 'Sales',
      date: '20260510',
      number: 'S-3',
      guid: 'a1b2c3d4-0000-0000-0000-000000000001-00000109',
      party: 'Acme Traders',
      invoice: true,
      flags: '\n      <ISOPTIONAL>Yes</ISOPTIONAL>',
      body:
        item({ name: 'Mixer Grinder 750W', qty: 1, rate: '2950.00', amount: '2950.00', ledger: 'Sales GST 18%', deemedPositive: false }) +
        entry({ ledger: 'Acme Traders', amount: '-3481.00', extra: bill('New Ref', 'S-3', '-3481.00') }) +
        entry({ ledger: 'CGST', amount: '265.50' }) +
        entry({ ledger: 'SGST', amount: '265.50' }),
    }),
    voucher({
      type: 'Sales',
      date: '20260512',
      number: 'S-4',
      guid: 'a1b2c3d4-0000-0000-0000-000000000001-00000110',
      party: 'Acme Traders',
      narration: 'Cancelled — wrong party',
      flags: '\n      <ISCANCELLED>Yes</ISCANCELLED>',
      body: '',
    }),
    voucher({
      type: 'Journal',
      date: '20260515',
      number: 'J-BAD',
      guid: 'a1b2c3d4-0000-0000-0000-000000000001-00000111',
      body: entry({ ledger: 'Office Rent', amount: '-100.00' }, 'ALLLEDGERENTRIES.LIST') + entry({ ledger: 'Cash', amount: '90.00' }, 'ALLLEDGERENTRIES.LIST'),
    }),
  ].join('');

/** The whole export as text (masters + transactions in one ENVELOPE, as "Export › All Masters + Day Book"). */
export function xmlFixtureXml(opts: { masters?: boolean; vouchers?: boolean } = {}): string {
  const body = `${opts.masters === false ? '' : masters()}${opts.vouchers === false ? '' : transactions()}`;
  return `<ENVELOPE>
 <HEADER>
  <${REQUEST_TAG}>Import Data</${REQUEST_TAG}>
 </HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>All Masters</REPORTNAME>
    <STATICVARIABLES>
     <SVCURRENTCOMPANY>Shree Ganesh Appliances</SVCURRENTCOMPANY>
    </STATICVARIABLES>
   </REQUESTDESC>
   <REQUESTDATA>${body}
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>
`.replace(/\n/g, '\r\n');
}

/** UTF-16LE bytes without a BOM, exactly as accounting programs write their XML exports. */
export function utf16le(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[i * 2] = c & 0xff;
    out[i * 2 + 1] = c >> 8;
  }
  return out;
}

export function xmlFixtureBytes(opts: { masters?: boolean; vouchers?: boolean } = {}): Uint8Array {
  return utf16le(xmlFixtureXml(opts));
}
