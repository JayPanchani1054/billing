/**
 * 'compact' — 80 mm thermal receipt for retail counters. Works for every layout: invoice lines as
 * "qty × rate = amount", vouchers as Dr/Cr lines, stock documents as quantities.
 */
import { addressLines, dateText, money, pctText, qtyText, rateText, rupees, totalRows, voucherSides } from '../lib/layout.ts';
import { safeImage, Stamp, taxabilityShort, type DocProps } from './parts.tsx';

export function CompactDoc({ doc, copyLabel, qrs }: DocProps) {
  const upi = safeImage(qrs.upi);
  const einv = safeImage(qrs.einvoice);
  const c = doc.company;
  const sides = doc.layout === 'voucher' ? voucherSides(doc) : null;
  return (
    <article className="bp-doc bp-compact">
      <Stamp doc={doc} />
      <div className="bp-c-center">
        <div className="bp-c-name">{c.displayName}</div>
        {addressLines(c).map((l, i) => (
          <div key={i}>{l}</div>
        ))}
        {c.phone ? <div>Ph: {c.phone}</div> : null}
        {c.gstin ? <div>GSTIN: {c.gstin}</div> : null}
        <div className="bp-c-title">{doc.title}</div>
        {doc.endorsement ? <div className="bp-small">{doc.endorsement}</div> : null}
        {doc.notes.map((n, i) => (
          <div key={i} className="bp-small">
            {n}
          </div>
        ))}
        {copyLabel ? <div className="bp-small">{copyLabel}</div> : null}
      </div>
      <div className="bp-c-rule" />
      <table>
        <tbody>
          <tr>
            <td>No: {doc.number ?? '—'}</td>
            <td className="bp-num">{dateText(doc.date)}</td>
          </tr>
          {doc.party?.name ? (
            <tr>
              <td colSpan={2}>
                {doc.partyLabel.replace(/ \(.*\)$/, '')}: <b>{doc.party.name}</b>
                {doc.party.gstin ? <span className="bp-sub">GSTIN: {doc.party.gstin}</span> : null}
              </td>
            </tr>
          ) : null}
          {doc.placeOfSupply && doc.gst.showTax ? (
            <tr>
              <td colSpan={2}>Place of supply: {doc.placeOfSupply.label}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <div className="bp-c-rule" />

      {doc.layout === 'voucher' ? (
        <table>
          <tbody>
            {doc.entries.map((e, i) => (
              <tr key={i}>
                <td>
                  {e.ledgerName}
                  {e.instrument ? <span className="bp-sub">{e.instrument}</span> : null}
                </td>
                <td className="bp-num">
                  {money(Math.abs(e.amount))} {e.amount >= 0 ? 'Dr' : 'Cr'}
                </td>
              </tr>
            ))}
            <tr className="bp-c-total">
              <td>Amount</td>
              <td className="bp-num">{rupees(doc.totals.grandTotal)}</td>
            </tr>
          </tbody>
        </table>
      ) : (
        <table>
          <tbody>
            {doc.lines.map((l) => (
              <tr key={l.sl} className="bp-c-item">
                <td>
                  {l.name}
                  {l.hsnSac ? <span className="bp-sub">HSN {l.hsnSac}{doc.gst.showTax && !l.absorbed ? ` · GST ${l.taxability === 'taxable' ? pctText(l.gstRate) : taxabilityShort(l.taxability)}` : ''}</span> : null}
                  {l.qty !== null ? (
                    <span className="bp-sub">
                      {qtyText(l.qty, l.qtyDecimals)} {l.unit ?? ''}
                      {l.rate !== null && doc.layout !== 'inventory' ? ` × ${rateText(l.rate)}` : ''}
                      {l.discountPct ? ` − ${pctText(l.discountPct)}` : ''}
                    </span>
                  ) : null}
                </td>
                <td className="bp-num">{doc.totals.grandTotal !== 0 || l.amount !== 0 ? money(l.amount) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {doc.layout === 'invoice' ? (
        <table>
          <tbody>
            {totalRows(doc).map((r, i) => (
              <tr key={i} className={r.kind === 'total' ? 'bp-c-total' : undefined}>
                <td>{r.label}</td>
                <td className="bp-num">{r.kind === 'total' ? rupees(r.amount) : money(r.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : doc.layout === 'inventory' && doc.totals.grandTotal !== 0 ? (
        <table>
          <tbody>
            <tr className="bp-c-total">
              <td>Total</td>
              <td className="bp-num">{rupees(doc.totals.grandTotal)}</td>
            </tr>
          </tbody>
        </table>
      ) : null}

      {doc.gst.showTax && doc.taxByRate.length > 0 ? (
        <>
          <div className="bp-c-rule" />
          <table className="bp-small">
            <thead>
              <tr>
                <th>GST</th>
                <th className="bp-num">Taxable</th>
                <th className="bp-num">Tax</th>
              </tr>
            </thead>
            <tbody>
              {doc.taxByRate.map((r) => (
                <tr key={`${r.taxability}|${r.rate}|${r.reverseCharge}`}>
                  <td>{r.taxability === 'taxable' ? pctText(r.rate) : taxabilityShort(r.taxability)}</td>
                  <td className="bp-num">{money(r.taxableValue)}</td>
                  <td className="bp-num">{money(r.tax)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      <div className="bp-c-rule" />
      {doc.totals.grandTotal !== 0 ? <div className="bp-small">{doc.amountInWords}</div> : null}
      {sides && sides.through.length > 0 ? <div className="bp-small">Through: {sides.through.join(', ')}</div> : null}
      {doc.narration ? <div className="bp-small bp-pre">{doc.narration}</div> : null}
      {upi && doc.upi ? (
        <div className="bp-c-center">
          <img className="bp-qr" src={upi} alt="UPI QR code" />
          <div className="bp-small">Scan to pay {rupees(doc.upi.amount)} · {doc.upi.id}</div>
        </div>
      ) : null}
      {doc.einvoice ? (
        <div className="bp-c-center">
          {einv ? <img className="bp-qr" src={einv} alt="E-invoice QR code" /> : null}
          <div className="bp-small bp-irn">IRN: {doc.einvoice.irn}</div>
          {doc.einvoice.ackNo ? <div className="bp-small">Ack No. {doc.einvoice.ackNo}</div> : null}
        </div>
      ) : null}
      {doc.terms ? <div className="bp-small bp-pre">{doc.terms}</div> : null}
      {doc.declaration ? <div className="bp-small bp-pre">{doc.declaration}</div> : null}
      <div className="bp-c-center bp-small">Thank you</div>
    </article>
  );
}
