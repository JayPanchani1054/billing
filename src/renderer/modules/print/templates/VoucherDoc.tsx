/**
 * Payment / receipt / journal / contra (and any ledger-mode voucher): particulars with Dr / Cr,
 * instruments, bill references and cost centres under each ledger, amount in words, narration and
 * signature lines. 'classic' draws it boxed.
 * (2.0) Honours the print layout applied to the document (SUPPORTED_PARTS below).
 */
import { isPartShown, printText } from '../../../../shared/printLayout.ts';
import { money, rupees, voucherSides } from '../lib/layout.ts';
import { TEMPLATE_PARTS, templateText } from '../lib/layoutParts.ts';
import { CompanyBlock, FooterLine, notesText, RefsGrid, Stamp, TitleBlock, type DocProps } from './parts.tsx';
import { ForexPrintBlock } from '../../forex/PrintBlock.tsx';

/** Parts this template prints and honours (the layout editor lists these). */
export const SUPPORTED_PARTS = TEMPLATE_PARTS.voucher;

export function VoucherDoc({ doc, copyLabel, template }: DocProps) {
  const debit = doc.entries.reduce((a, e) => a + e.debit, 0);
  const credit = doc.entries.reduce((a, e) => a + e.credit, 0);
  const sides = voucherSides(doc);
  const boxed = template === 'classic';
  const verb = doc.baseType === 'payment' ? 'Paid to' : doc.baseType === 'receipt' ? 'Received from' : null;
  const notes = notesText(doc);
  const receivedBy = isPartShown(doc, 'receivedBy');
  const signature = isPartShown(doc, 'signature');
  return (
    <article className={`bp-doc ${boxed ? 'bp-classic' : 'bp-modern'}`}>
      <Stamp doc={doc} />
      <header className="bp-head">
        <CompanyBlock doc={doc} />
        <TitleBlock doc={doc} copyLabel={copyLabel} />
      </header>
      <RefsGrid doc={doc} />
      {verb && sides.accounts.length > 0 && isPartShown(doc, 'party') ? (
        <div className="bp-parties" data-part="party">
          <div>
            <div className="bp-cap">{verb}</div>
            <div className="bp-party-name">{sides.accounts.join(', ')}</div>
          </div>
          {sides.through.length > 0 ? (
            <div>
              <div className="bp-cap">Through</div>
              <div className="bp-party-name">{sides.through.join(', ')}</div>
            </div>
          ) : (
            <div />
          )}
        </div>
      ) : (
        <div className="bp-gap" />
      )}
      <table className={boxed ? 'bp-box bp-items-c' : 'bp-items'} data-part="entries">
        <thead>
          <tr>
            <th>Particulars</th>
            <th className="bp-num">Debit</th>
            <th className="bp-num">Credit</th>
          </tr>
        </thead>
        <tbody>
          {doc.entries.map((e, i) => (
            <tr key={i}>
              <td>
                <span className="bp-strong">{e.ledgerName}</span>
                {e.instrument ? <span className="bp-sub">{e.instrument}</span> : null}
                {e.bills.map((b, j) => (
                  <span key={`b${j}`} className="bp-sub">
                    {b}
                  </span>
                ))}
                {e.costCentres.map((c, j) => (
                  <span key={`c${j}`} className="bp-sub">
                    {c}
                  </span>
                ))}
                {e.narration ? <span className="bp-sub bp-pre">{e.narration}</span> : null}
              </td>
              <td className="bp-num">{e.debit ? money(e.debit) : ''}</td>
              <td className="bp-num">{e.credit ? money(e.credit) : ''}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td className="bp-num">Total</td>
            <td className="bp-num">{money(debit)}</td>
            <td className="bp-num">{money(credit)}</td>
          </tr>
        </tfoot>
      </table>
      {/* (forex group) Entries of ledgers kept in a foreign currency: amount and rate. */}
      <ForexPrintBlock doc={doc} />
      <section className="bp-summary bp-avoid">
        <div className="bp-summary-left">
          {isPartShown(doc, 'amountInWords') ? (
            <div data-part="amountInWords">
              <div className="bp-cap">{printText(doc, 'label.amountInWords', templateText('voucher', 'label.amountInWords', doc))}</div>
              <div className="bp-words">{doc.amountInWords}</div>
            </div>
          ) : null}
          {doc.narration ? (
            <div data-part="narration">
              <div className="bp-cap">On account of</div>
              <div className="bp-pre">{doc.narration}</div>
            </div>
          ) : null}
          {notes ? (
            <div data-part="notes">
              <div className="bp-cap">Notes</div>
              <div className="bp-pre">{notes}</div>
            </div>
          ) : null}
        </div>
        <table className="bp-totals">
          <tbody>
            <tr className="bp-total" data-part="totals.grand">
              <td>{printText(doc, 'label.total', templateText('voucher', 'label.total', doc))}</td>
              <td className="bp-num">{rupees(doc.totals.grandTotal)}</td>
            </tr>
          </tbody>
        </table>
      </section>
      {receivedBy || signature ? (
        <div className="bp-sigs bp-avoid">
          {receivedBy ? <div data-part="receivedBy">Prepared by</div> : null}
          {receivedBy ? (
            <div data-part="receivedBy">{doc.baseType === 'payment' ? "Receiver's Signature" : doc.baseType === 'receipt' ? "Payer's Signature" : 'Checked by'}</div>
          ) : null}
          {signature ? <div data-part="signature">{doc.signatoryLabel}</div> : null}
        </div>
      ) : null}
      <FooterLine doc={doc} />
    </article>
  );
}
