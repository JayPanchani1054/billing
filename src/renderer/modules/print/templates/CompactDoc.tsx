/**
 * 'compact' — 80 mm / 58 mm thermal receipt for retail counters (no wide tables: item, qty × rate,
 * amount; tax summary; with the MRP option, each item's MRP and "You saved" against MRP). Works for every layout: invoice lines as
 * "qty × rate = amount", vouchers as Dr/Cr lines, stock documents as quantities. A GST invoice keeps
 * its Rule 46 particulars even on a roll: buyer address / GSTIN / state code, place of supply, HSN and
 * rate per line, the reverse-charge statement, the invoice adjusted by a note, and the signatory.
 */
import { addressLines, compactLineInfo, dateText, money, mrpText, pctText, qtyText, rateText, rupees, showMrp, totalRows, voucherSides } from '../lib/layout.ts';
import { safeImage, Stamp, taxabilityShort, type DocProps } from './parts.tsx';

export function CompactDoc({ doc, copyLabel, qrs }: DocProps) {
  const upi = safeImage(qrs.upi);
  const einv = safeImage(qrs.einvoice);
  const c = doc.company;
  const sides = doc.layout === 'voucher' ? voucherSides(doc) : null;
  const mrp = showMrp(doc);
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
          {doc.referenceNo ? (
            <tr>
              <td colSpan={2}>
                Ref: {doc.referenceNo}
                {doc.referenceDate ? ` dated ${dateText(doc.referenceDate)}` : ''}
              </td>
            </tr>
          ) : null}
          {doc.originalInvoice ? (
            <tr>
              <td colSpan={2}>
                Against invoice: {doc.originalInvoice.number}
                {doc.originalInvoice.date ? ` dated ${dateText(doc.originalInvoice.date)}` : ''}
                {doc.originalInvoice.reason ? <span className="bp-sub">Reason: {doc.originalInvoice.reason}</span> : null}
              </td>
            </tr>
          ) : null}
          {doc.party?.name ? (
            <tr>
              <td colSpan={2}>
                {doc.partyLabel.replace(/ \(.*\)$/, '')}: <b>{doc.party.name}</b>
                {addressLines(doc.party).map((l, i) => (
                  <span key={i} className="bp-sub">
                    {l}
                  </span>
                ))}
                {doc.party.gstin ? <span className="bp-sub">GSTIN: {doc.party.gstin}</span> : null}
                {doc.party.stateCode && (doc.party.gstin || doc.party.address) ? (
                  <span className="bp-sub">
                    State code: {doc.party.stateCode}
                    {doc.party.stateName ? ` (${doc.party.stateName})` : ''}
                  </span>
                ) : null}
              </td>
            </tr>
          ) : null}
          {doc.consignee && !doc.consigneeSameAsParty && doc.layout !== 'voucher' ? (
            <tr>
              <td colSpan={2}>
                {doc.consigneeLabel.replace(/ \(.*\)$/, '')}: <b>{doc.consignee.name ?? ''}</b>
                {addressLines(doc.consignee).map((l, i) => (
                  <span key={i} className="bp-sub">
                    {l}
                  </span>
                ))}
              </td>
            </tr>
          ) : null}
          {doc.placeOfSupply && (doc.gst.showTax || doc.kind === 'delivery_challan') ? (
            <tr>
              <td colSpan={2}>Place of supply: {doc.placeOfSupply.label}</td>
            </tr>
          ) : null}
          {doc.layout === 'invoice' && doc.gst.showTax ? (
            <tr>
              <td colSpan={2}>Reverse charge: {doc.reverseCharge ? 'Yes' : 'No'}</td>
            </tr>
          ) : null}
          {doc.ewayBill ? (
            <tr>
              <td colSpan={2}>e-Way Bill: {doc.ewayBill.number}</td>
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
                  {compactLineInfo(l, doc.gst.showTax) ? <span className="bp-sub">{compactLineInfo(l, doc.gst.showTax)}</span> : null}
                  {l.qty !== null ? (
                    <span className="bp-sub">
                      {qtyText(l.qty, l.qtyDecimals)} {l.unit ?? ''}
                      {l.rate !== null && doc.layout !== 'inventory' ? ` × ${rateText(l.rate)}` : ''}
                      {l.discountPct ? ` − ${pctText(l.discountPct)}` : ''}
                    </span>
                  ) : null}
                  {mrp && mrpText(l) ? <span className="bp-sub">MRP {mrpText(l)}*</span> : null}
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
            {mrp && doc.mrpSummary && doc.mrpSummary.savings > 0 ? (
              <tr className="bp-c-saved">
                <td>You saved</td>
                <td className="bp-num">{rupees(doc.mrpSummary.savings)}</td>
              </tr>
            ) : null}
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
          {einv ? <img className="bp-qr" src={einv} alt="e-Invoice QR code" /> : null}
          <div className="bp-small bp-irn">IRN: {doc.einvoice.irn}</div>
          {doc.einvoice.ackNo ? <div className="bp-small">Ack No. {doc.einvoice.ackNo}</div> : null}
        </div>
      ) : null}
      {doc.totals.reverseChargeTax !== 0 ? <div className="bp-small">Tax payable on reverse charge: {rupees(doc.totals.reverseChargeTax)} (not included above)</div> : null}
      {mrp ? <div className="bp-small">* MRP per unit, inclusive of all taxes</div> : null}
      {doc.terms ? <div className="bp-small bp-pre">{doc.terms}</div> : null}
      {doc.declaration ? <div className="bp-small bp-pre">{doc.declaration}</div> : null}
      <div className="bp-c-sign">
        <div>For {c.displayName}</div>
        <div className="bp-c-sign-space" />
        <div>{doc.signatoryLabel}</div>
      </div>
      <div className="bp-c-center bp-small">Thank you</div>
    </article>
  );
}
