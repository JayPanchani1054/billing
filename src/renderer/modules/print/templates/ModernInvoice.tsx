/**
 * 'modern' — clean A4/A5 GST invoice: letterhead, reference grid, bill-to / ship-to, item table,
 * totals, amount in words, bank + UPI QR, HSN summary, e-invoice block, declaration and signature.
 * Also prints orders and challans entered with prices (same data shape).
 */
import { itemColumns } from '../lib/layout.ts';
import {
  BankBlock,
  CompanyBlock,
  EInvoiceBlock,
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

export function ModernInvoice({ doc, copyLabel, qrs, pageSize, template }: DocProps) {
  const cols = itemColumns(doc, { pageSize, template });
  const byHsn = doc.options.showHsnSummary && doc.taxByHsn.length > 0;
  return (
    <article className="bp-doc bp-modern">
      <Stamp doc={doc} />
      <header className="bp-head">
        <CompanyBlock company={doc.company} />
        <TitleBlock doc={doc} copyLabel={copyLabel} />
      </header>
      <RefsGrid doc={doc} />
      <Parties doc={doc} />
      <ItemsTable doc={doc} cols={cols} />
      <section className="bp-summary bp-avoid">
        <div className="bp-summary-left">
          <Words doc={doc} />
          <div className="bp-pay">
            <BankBlock bank={doc.bank} />
            <UpiBlock doc={doc} qr={qrs.upi} />
          </div>
        </div>
        <TotalsTable doc={doc} />
      </section>
      <TaxSummary doc={doc} cols={cols} byHsn={byHsn} />
      <EInvoiceBlock doc={doc} qr={qrs.einvoice} />
      <footer className="bp-foot">
        <div className="bp-foot-left">
          <NotesBlock doc={doc} />
        </div>
        <Signature doc={doc} />
      </footer>
      <GeneratedLine>{doc.layout === 'invoice' && doc.baseType === 'sales' ? 'This is a computer-generated invoice.' : undefined}</GeneratedLine>
    </article>
  );
}
