/**
 * 'classic' — the familiar Tally-style boxed GST invoice: seller / consignee / buyer boxes on the
 * left, reference grid on the right, goods table with tax ledgers listed under the items, amount
 * chargeable in words, HSN/SAC tax table, declaration and "for <company>" signature box.
 */
import {
  addressLines,
  classicTaxRows,
  headerRefs,
  itemColumns,
  money,
  mrpText,
  partyBoxLabel,
  partyIds,
  pctText,
  qtyText,
  rateText,
  rupees,
  taxabilityText,
} from '../lib/layout.ts';
import type { PrintAddress, PrintVoucherData } from '../../../../shared/types/print.ts';
import { BankBlock, EInvoiceBlock, safeImage, Stamp, UpiBlock, type DocProps } from './parts.tsx';
import { ForexPrintBlock } from '../../forex/PrintBlock.tsx';

function AddressCell({ label, a, bold = true }: { label?: string; a: PrintAddress | null; bold?: boolean }) {
  if (!a) return null;
  return (
    <div className="bp-cell">
      {label ? <div className="bp-cap">{label}</div> : null}
      <div className={bold ? 'bp-strong' : undefined}>{a.name ?? ''}</div>
      {addressLines(a).map((l, i) => (
        <div key={i}>{l}</div>
      ))}
      {partyIds(a).map((p) => (
        <div key={p.label}>
          {p.label}: {p.value}
        </div>
      ))}
    </div>
  );
}

function HsnTable({ doc }: { doc: PrintVoucherData }) {
  if (!doc.gst.showTax || doc.taxByHsn.length === 0) return null;
  const split = doc.gst.taxMode !== 'igst';
  const cess = doc.taxByHsn.some((r) => r.cess !== 0);
  const sum = (k: 'taxableValue' | 'cgst' | 'sgst' | 'igst' | 'cess' | 'tax'): number => doc.taxByHsn.reduce((a, r) => a + r[k], 0);
  return (
    <table className="bp-box bp-taxsum">
      <thead>
        <tr>
          <th rowSpan={2}>HSN/SAC</th>
          <th rowSpan={2}>Taxable Value</th>
          {split ? <th colSpan={2}>Central Tax</th> : <th colSpan={2}>Integrated Tax</th>}
          {split ? <th colSpan={2}>{doc.gst.sgstLabel === 'UTGST' ? 'UT Tax' : 'State Tax'}</th> : null}
          {cess ? <th rowSpan={2}>Cess</th> : null}
          <th rowSpan={2}>Total Tax Amount</th>
        </tr>
        <tr>
          <th>Rate</th>
          <th>Amount</th>
          {split ? <th>Rate</th> : null}
          {split ? <th>Amount</th> : null}
        </tr>
      </thead>
      <tbody>
        {doc.taxByHsn.map((r) => (
          <tr key={`${r.hsnSac}|${r.rate}`}>
            <td>{r.hsnSac || '—'}</td>
            <td className="bp-num">{money(r.taxableValue)}</td>
            <td className="bp-num">{pctText(split ? r.rate / 2 : r.rate)}</td>
            <td className="bp-num">{money(split ? r.cgst : r.igst)}</td>
            {split ? <td className="bp-num">{pctText(r.rate / 2)}</td> : null}
            {split ? <td className="bp-num">{money(r.sgst)}</td> : null}
            {cess ? <td className="bp-num">{money(r.cess)}</td> : null}
            <td className="bp-num">{money(r.tax)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td className="bp-num bp-strong">Total</td>
          <td className="bp-num">{money(sum('taxableValue'))}</td>
          <td />
          <td className="bp-num">{money(split ? sum('cgst') : sum('igst'))}</td>
          {split ? <td /> : null}
          {split ? <td className="bp-num">{money(sum('sgst'))}</td> : null}
          {cess ? <td className="bp-num">{money(sum('cess'))}</td> : null}
          <td className="bp-num">{money(sum('tax'))}</td>
        </tr>
      </tfoot>
    </table>
  );
}

export function ClassicInvoice({ doc, copyLabel, qrs, pageSize, template }: DocProps) {
  const cols = itemColumns(doc, { pageSize, template });
  const refs = headerRefs(doc);
  const pairs: Array<typeof refs> = [];
  for (let i = 0; i < refs.length; i += 2) pairs.push(refs.slice(i, i + 2));
  const logo = safeImage(doc.company.logo);
  const taxRows = classicTaxRows(doc);
  const t = doc.totals;
  // Rule 46(i): the rate of tax per line — Tally's "GST Rate" column next to HSN/SAC.
  const gstCol = doc.gst.showTax;
  const nCols = 3 + (cols.hsn ? 1 : 0) + (gstCol ? 1 : 0) + (cols.mrp ? 1 : 0) + (cols.qty ? 1 : 0) + (cols.rate ? 2 : 0) + (cols.discount ? 1 : 0);
  const descSpan = 2 + (cols.hsn ? 1 : 0) + (gstCol ? 1 : 0) + (cols.mrp ? 1 : 0);
  /** Blank cells between the description and the Amount column of a tax / charge row. */
  const gap = nCols - 3;
  const showConsignee = !doc.consigneeSameAsParty && doc.consignee;
  return (
    <article className="bp-doc bp-classic">
      <Stamp doc={doc} />
      <div className="bp-topline">
        <span>{doc.einvoice ? `IRN: ${doc.einvoice.irn}` : ''}</span>
        <span className="bp-strong">{copyLabel ?? ''}</span>
      </div>
      <h2 className="bp-title-c">{doc.title}</h2>
      {doc.endorsement ? <div className="bp-center bp-strong bp-small">{doc.endorsement}</div> : null}
      {doc.notes.map((n, i) => (
        <div key={i} className="bp-center bp-small">
          {n}
        </div>
      ))}
      <table className="bp-box">
        <tbody>
          <tr>
            <td className="bp-w50 bp-p0">
              <div className="bp-cell bp-row">
                {logo ? <img className="bp-logo" src={logo} alt="Logo" /> : null}
                <AddressCell a={{ ...doc.company, name: doc.company.displayName, registrationType: null }} />
              </div>
              {showConsignee ? (
                <div className="bp-sep-top">
                  <AddressCell label={doc.consigneeLabel} a={doc.consignee} />
                </div>
              ) : null}
              {doc.party ? (
                <div className="bp-sep-top">
                  <AddressCell label={partyBoxLabel(doc)} a={doc.party} />
                </div>
              ) : null}
            </td>
            <td className="bp-w50 bp-p0">
              <table className="bp-box bp-inner">
                <tbody>
                  {pairs.map((pair, i) => (
                    <tr key={i}>
                      {pair.map((r) => (
                        <td key={r.label} className="bp-cell bp-w50" colSpan={pair.length === 1 ? 2 : 1}>
                          <div className="bp-cap">{r.label}</div>
                          <div className="bp-strong">{r.value}</div>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </td>
          </tr>
        </tbody>
      </table>
      <table className="bp-box bp-items-c">
        <thead>
          <tr>
            <th className="bp-sl">Sl No.</th>
            <th>Description of Goods / Services</th>
            {cols.hsn ? <th>HSN/SAC</th> : null}
            {gstCol ? <th>GST Rate</th> : null}
            {cols.mrp ? <th>MRP*</th> : null}
            {cols.qty ? <th>Quantity</th> : null}
            {cols.rate ? <th>Rate</th> : null}
            {cols.rate ? <th>per</th> : null}
            {cols.discount ? <th>Disc. %</th> : null}
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {doc.lines.map((l) => (
            <tr key={l.sl}>
              <td className="bp-sl bp-center">{l.absorbed ? '' : l.sl}</td>
              <td>
                <span className="bp-strong">{l.name}</span>
                {l.description ? <span className="bp-sub bp-pre">{l.description}</span> : null}
                {l.batch ? <span className="bp-sub">Batch: {l.batch}</span> : null}
                {l.absorbed ? <span className="bp-sub">Included in the taxable value</span> : null}
              </td>
              {cols.hsn ? <td>{l.hsnSac ?? ''}</td> : null}
              {gstCol ? <td className="bp-num">{l.absorbed ? '' : l.taxability === 'taxable' ? pctText(l.gstRate) : taxabilityText(l.taxability)}</td> : null}
              {cols.mrp ? <td className="bp-num">{mrpText(l)}</td> : null}
              {cols.qty ? <td className="bp-num bp-strong">{l.qty === null ? '' : `${qtyText(l.qty, l.qtyDecimals)} ${l.unit ?? ''}`.trim()}</td> : null}
              {cols.rate ? <td className="bp-num">{rateText(l.rate)}</td> : null}
              {cols.rate ? <td>{l.qty === null ? '' : (l.unit ?? '')}</td> : null}
              {cols.discount ? <td className="bp-num">{l.discountPct ? pctText(l.discountPct) : ''}</td> : null}
              <td className="bp-num bp-strong">{money(l.amount)}</td>
            </tr>
          ))}
          {taxRows.map((r) => (
            <tr key={r.label} className="bp-taxrow">
              <td />
              <td className="bp-num bp-strong">{r.label}</td>
              {cols.hsn ? <td /> : null}
              {gstCol ? <td /> : null}
              {cols.mrp ? <td /> : null}
              {cols.qty ? <td /> : null}
              {cols.rate ? <td className="bp-num">{r.rate}</td> : null}
              {cols.rate ? <td>{r.rate ? '%' : ''}</td> : null}
              {cols.discount ? <td /> : null}
              <td className="bp-num bp-strong">{money(r.amount)}</td>
            </tr>
          ))}
          {doc.charges.map((c) => (
            <tr key={c.name} className="bp-taxrow">
              <td />
              <td className="bp-num bp-strong">{c.name}</td>
              {gap > 0 ? <td colSpan={gap} /> : null}
              <td className="bp-num bp-strong">{money(c.amount)}</td>
            </tr>
          ))}
          {t.roundOff !== 0 ? (
            <tr className="bp-taxrow">
              <td />
              <td className="bp-num bp-strong">Round Off</td>
              {gap > 0 ? <td colSpan={gap} /> : null}
              <td className="bp-num bp-strong">{money(t.roundOff)}</td>
            </tr>
          ) : null}
          {t.reverseChargeTax !== 0 ? (
            <tr className="bp-taxrow">
              <td />
              <td className="bp-num bp-small" colSpan={nCols - 1}>
                Tax payable on reverse charge {rupees(t.reverseChargeTax)} (not included)
              </td>
            </tr>
          ) : null}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={descSpan} className="bp-num">
              Total
            </td>
            {cols.qty ? <td className="bp-num">{t.qty !== null ? `${qtyText(t.qty, t.qtyDecimals)} ${t.unit ?? ''}`.trim() : ''}</td> : null}
            {nCols - descSpan - (cols.qty ? 1 : 0) - 1 > 0 ? <td colSpan={nCols - descSpan - (cols.qty ? 1 : 0) - 1} /> : null}
            <td className="bp-num">{rupees(t.grandTotal)}</td>
          </tr>
          {cols.mrp && doc.mrpSummary ? (
            <tr>
              <td colSpan={nCols} className="bp-cell bp-normal bp-small">
                {doc.mrpSummary.savings > 0 ? (
                  <>
                    <b>You saved {rupees(doc.mrpSummary.savings)}</b> on MRP ·{' '}
                  </>
                ) : null}
                * MRP per unit, inclusive of all taxes
              </td>
            </tr>
          ) : null}
          <tr>
            <td colSpan={nCols} className="bp-cell bp-normal">
              <div className="bp-eoe">
                <span className="bp-cap">Amount Chargeable (in words)</span>
                <span className="bp-small">E. &amp; O.E</span>
              </div>
              <div className="bp-strong">{doc.amountInWords}</div>
            </td>
          </tr>
        </tfoot>
      </table>
      <HsnTable doc={doc} />
      {doc.taxInWords && doc.taxByHsn.length > 0 ? (
        <div className="bp-small bp-pad-v">
          Tax Amount (in words): <b>{doc.taxInWords}</b>
        </div>
      ) : null}
      {/* (forex group) Export / import invoice in a foreign currency: amounts in it with the rate. */}
      <ForexPrintBlock doc={doc} />
      <EInvoiceBlock doc={doc} qr={qrs.einvoice} />
      <table className="bp-box bp-avoid">
        <tbody>
          <tr>
            <td className="bp-cell bp-w50">
              {doc.company.pan ? (
                <div>
                  Company&apos;s PAN: <b>{doc.company.pan}</b>
                </div>
              ) : null}
              {doc.narration ? (
                <div>
                  <div className="bp-cap">Remarks</div>
                  <div className="bp-pre">{doc.narration}</div>
                </div>
              ) : null}
              {doc.terms ? (
                <div>
                  <div className="bp-cap">Terms &amp; conditions</div>
                  <div className="bp-pre bp-small">{doc.terms}</div>
                </div>
              ) : null}
              {doc.declaration ? (
                <div>
                  <div className="bp-cap">Declaration</div>
                  <div className="bp-pre bp-small">{doc.declaration}</div>
                </div>
              ) : null}
            </td>
            <td className="bp-cell bp-w50">
              <BankBlock bank={doc.bank} />
              <UpiBlock doc={doc} qr={qrs.upi} />
              <div className="bp-sign bp-sign-c">
                <div className="bp-sign-for">for {doc.company.displayName}</div>
                <div className="bp-sign-space" />
                <div>{doc.signatoryLabel}</div>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div className="bp-generated">This is a Computer Generated {doc.layout === 'invoice' && doc.baseType === 'sales' ? 'Invoice' : 'Document'}</div>
    </article>
  );
}

