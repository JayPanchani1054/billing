/**
 * Payment / receipt / journal / contra (and any ledger-mode voucher): particulars with Dr / Cr,
 * instruments, bill references and cost centres under each ledger, amount in words, narration and
 * signature lines. 'classic' draws it boxed.
 */
import { money, rupees, voucherSides } from '../lib/layout.ts';
import { CompanyBlock, RefsGrid, Stamp, TitleBlock, type DocProps } from './parts.tsx';
import { ForexPrintBlock } from '../../forex/PrintBlock.tsx';

export function VoucherDoc({ doc, copyLabel, template }: DocProps) {
  const debit = doc.entries.reduce((a, e) => a + e.debit, 0);
  const credit = doc.entries.reduce((a, e) => a + e.credit, 0);
  const sides = voucherSides(doc);
  const boxed = template === 'classic';
  const verb = doc.baseType === 'payment' ? 'Paid to' : doc.baseType === 'receipt' ? 'Received from' : null;
  return (
    <article className={`bp-doc ${boxed ? 'bp-classic' : 'bp-modern'}`}>
      <Stamp doc={doc} />
      <header className="bp-head">
        <CompanyBlock company={doc.company} />
        <TitleBlock doc={doc} copyLabel={copyLabel} />
      </header>
      <RefsGrid doc={doc} />
      {verb && sides.accounts.length > 0 ? (
        <div className="bp-parties">
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
      <table className={boxed ? 'bp-box bp-items-c' : 'bp-items'}>
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
          <div>
            <div className="bp-cap">Amount in words</div>
            <div className="bp-words">{doc.amountInWords}</div>
          </div>
          {doc.narration ? (
            <div>
              <div className="bp-cap">On account of</div>
              <div className="bp-pre">{doc.narration}</div>
            </div>
          ) : null}
        </div>
        <table className="bp-totals">
          <tbody>
            <tr className="bp-total">
              <td>Amount</td>
              <td className="bp-num">{rupees(doc.totals.grandTotal)}</td>
            </tr>
          </tbody>
        </table>
      </section>
      <div className="bp-sigs bp-avoid">
        <div>Prepared by</div>
        <div>{doc.baseType === 'payment' ? "Receiver's Signature" : doc.baseType === 'receipt' ? "Payer's Signature" : 'Checked by'}</div>
        <div>{doc.signatoryLabel}</div>
      </div>
    </article>
  );
}
