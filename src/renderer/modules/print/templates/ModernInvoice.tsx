/**
 * 'modern' — clean A4/A5 GST invoice: letterhead, reference grid, bill-to / ship-to, item table,
 * totals, amount in words, bank + UPI QR, HSN summary, e-invoice block, declaration and signature.
 * Also prints orders and challans entered with prices (same data shape).
 * (2.0) Honours the print layout applied to the document (parts.tsx; SUPPORTED_PARTS below).
 */
import { isPartShown } from '../../../../shared/printLayout.ts';
import { itemColumns } from '../lib/layout.ts';
import { TEMPLATE_PARTS } from '../lib/layoutParts.ts';
import {
  BankBlock,
  CompanyBlock,
  EInvoiceBlock,
  FooterLine,
  GeneratedLine,
  ItemsTable,
  NotesBlock,
  Parties,
  RefsGrid,
  Signature,
  Stamp,
  TaxSummary,
  TitleBlock,
  TotalsTable,
  UpiBlock,
  Words,
  type DocProps,
} from './parts.tsx';
import { ForexPrintBlock } from '../../forex/PrintBlock.tsx';
import { PosPrintBlock } from '../../pos/PrintBlock.tsx';

/** Parts this template prints and honours (the layout editor lists these). */
export const SUPPORTED_PARTS = TEMPLATE_PARTS.modern;

export function ModernInvoice({ doc, copyLabel, qrs, pageSize, template }: DocProps) {
  const cols = itemColumns(doc, { pageSize, template });
  const byHsn = doc.options.showHsnSummary && doc.taxByHsn.length > 0;
  return (
    <article className="bp-doc bp-modern">
      <Stamp doc={doc} />
      <header className="bp-head">
        <CompanyBlock doc={doc} />
        <TitleBlock doc={doc} copyLabel={copyLabel} />
      </header>
      <RefsGrid doc={doc} />
      <Parties doc={doc} />
      <ItemsTable doc={doc} cols={cols} />
      <section className="bp-summary bp-avoid">
        <div className="bp-summary-left">
          <Words doc={doc} kind="modern" />
          <div className="bp-pay">
            <BankBlock bank={doc.bank} />
            <UpiBlock doc={doc} qr={qrs.upi} />
          </div>
        </div>
        <TotalsTable doc={doc} />
      </section>
      {isPartShown(doc, 'taxSummary') ? <TaxSummary doc={doc} cols={cols} byHsn={byHsn} /> : null}
      {/* (forex group) Export / import invoice in a foreign currency: amounts in it with the rate. */}
      <ForexPrintBlock doc={doc} />
      {/* (pos group) POS bill / return: tenders, cash tendered, change, on account. */}
      <PosPrintBlock doc={doc} />
      <EInvoiceBlock doc={doc} qr={qrs.einvoice} />
      <footer className="bp-foot">
        <div className="bp-foot-left">
          <NotesBlock doc={doc} />
        </div>
        <Signature doc={doc} kind="modern" />
      </footer>
      <GeneratedLine doc={doc} kind="modern" />
      <FooterLine doc={doc} />
    </article>
  );
}
