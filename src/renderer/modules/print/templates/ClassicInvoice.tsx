/**
 * 'classic' — the familiar boxed GST invoice: seller / consignee / buyer boxes on the
 * left, reference grid on the right, goods table with tax ledgers listed under the items, amount
 * chargeable in words, HSN/SAC tax table, declaration and "for <company>" signature box.
 * (2.0) Honours the print layout applied to the document (SUPPORTED_PARTS below; the boxed table keeps
 * its Amount column, which carries the tax rows and the total).
 */
import { isPartShown, printText } from '../../../../shared/printLayout.ts';
import {
  addressLines,
  classicTaxRows,
  headerRefsWithParts,
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
import { signForText, TEMPLATE_PARTS, templateText } from '../lib/layoutParts.ts';
import type { PrintAddress, PrintVoucherData } from '../../../../shared/types/print.ts';
import { BankBlock, EInvoiceBlock, FooterLine, notesText, partyIdPart, safeImage, Stamp, UpiBlock, type DocProps } from './parts.tsx';
import { ForexPrintBlock } from '../../forex/PrintBlock.tsx';
import { PosPrintBlock } from '../../pos/PrintBlock.tsx';

/** Parts this template prints and honours (the layout editor lists these). */
export const SUPPORTED_PARTS = TEMPLATE_PARTS.classic;

function AddressCell({ label, a, bold = true, part }: { label?: string; a: PrintAddress | null; bold?: boolean; part: 'party' | 'consignee' }) {
  if (!a) return null;
  return (
    <div className="bp-cell" data-part={part}>
      {label ? <div className="bp-cap">{label}</div> : null}
      <div className={bold ? 'bp-strong' : undefined}>{a.name ?? ''}</div>
      {addressLines(a).map((l, i) => (
        <div key={i}>{l}</div>
      ))}
      {partyIds(a).map((p) => (
        <div key={p.label} data-part={partyIdPart(part, p.label)}>
          {p.label}: {p.value}
        </div>
      ))}
    </div>
  );
}

/** Print part of each identifier line of the seller box. */
const COMPANY_ID_PARTS: Readonly<Record<string, 'company.gstin' | 'company.pan' | 'company.address' | 'company.contact'>> = {
  'GSTIN/UIN': 'company.gstin',
  PAN: 'company.pan',
  State: 'company.address',
  Phone: 'company.contact',
  'E-mail': 'company.contact',
};

/** The seller box: name, address, GSTIN / PAN / State, phone and e-mail. */
function CompanyCell({ doc }: { doc: PrintVoucherData }) {
  const a: PrintAddress = { ...doc.company, name: doc.company.displayName, registrationType: null };
  const address = isPartShown(doc, 'company.address');
  return (
    <div className="bp-cell">
      {isPartShown(doc, 'company.name') ? (
        <div className="bp-strong" data-part="company.name">
          {a.name ?? ''}
        </div>
      ) : null}
      {address
        ? addressLines(a).map((l, i) => (
            <div key={i} data-part="company.address">
              {l}
            </div>
          ))
        : null}
      {partyIds(a)
        .filter((p) => address || p.label !== 'State')
        .map((p) => (
          <div key={p.label} data-part={COMPANY_ID_PARTS[p.label]}>
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
    <table className="bp-box bp-taxsum" data-part="taxSummary">
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
  const refs = headerRefsWithParts(doc);
  const pairs: Array<typeof refs> = [];
  for (let i = 0; i < refs.length; i += 2) pairs.push(refs.slice(i, i + 2));
  const logo = safeImage(doc.company.logo);
  const taxRows = isPartShown(doc, 'totals.taxHeads') ? classicTaxRows(doc) : [];
  const charges = isPartShown(doc, 'totals.charges') ? doc.charges : [];
  const t = doc.totals;
  const h = (id: 'col.description' | 'col.hsn' | 'col.qty' | 'col.rate' | 'col.discount' | 'col.amount'): string => printText(doc, id, templateText('classic', id, doc));
  const unit = (u: string | null): string => (cols.unit ? (u ?? '') : '');
  // Rule 46(i): the rate of tax per line — the "GST Rate" column next to HSN/SAC.
  const gstCol = cols.gstRate;
  const sno = cols.sno ? 1 : 0;
  /** The "per" (unit of the rate) column. */
  const perCol = cols.rate && cols.unit;
  const nCols = sno + 2 + (cols.hsn ? 1 : 0) + (gstCol ? 1 : 0) + (cols.mrp ? 1 : 0) + (cols.qty ? 1 : 0) + (cols.rate ? 1 : 0) + (perCol ? 1 : 0) + (cols.discount ? 1 : 0);
  const descSpan = sno + 1 + (cols.hsn ? 1 : 0) + (gstCol ? 1 : 0) + (cols.mrp ? 1 : 0);
  /** Blank cells between the description and the Amount column of a tax / charge row. */
  const gap = nCols - sno - 2;
  const showConsignee = !doc.consigneeSameAsParty && doc.consignee;
  const party = isPartShown(doc, 'party') ? doc.party : null;
  const notes = notesText(doc);
  return (
    <article className="bp-doc bp-classic">
      <Stamp doc={doc} />
      <div className="bp-topline">
        <span data-part="einvoice">{doc.einvoice ? `IRN: ${doc.einvoice.irn}` : ''}</span>
        <span className="bp-strong" data-part="copyLabel">
          {copyLabel && isPartShown(doc, 'copyLabel') ? copyLabel : ''}
        </span>
      </div>
      {isPartShown(doc, 'title') ? (
        <h2 className="bp-title-c" data-part="title">
          {doc.title}
        </h2>
      ) : null}
      {doc.endorsement ? (
        <div className="bp-center bp-strong bp-small" data-part="endorsement">
          {doc.endorsement}
        </div>
      ) : null}
      {doc.notes.map((n, i) => (
        <div key={i} className="bp-center bp-small" data-part="statutoryNotes">
          {n}
        </div>
      ))}
      <table className="bp-box">
        <tbody>
          <tr>
            <td className="bp-w50 bp-p0">
              <div className="bp-cell bp-row">
                {logo ? <img className="bp-logo" src={logo} alt="Logo" data-part="logo" /> : null}
                <CompanyCell doc={doc} />
              </div>
              {showConsignee ? (
                <div className="bp-sep-top">
                  <AddressCell label={doc.consigneeLabel} a={doc.consignee} part="consignee" />
                </div>
              ) : null}
              {party ? (
                <div className="bp-sep-top">
                  <AddressCell label={partyBoxLabel(doc)} a={party} part="party" />
                </div>
              ) : null}
            </td>
            <td className="bp-w50 bp-p0">
              <table className="bp-box bp-inner">
                <tbody>
                  {pairs.map((pair, i) => (
                    <tr key={i}>
                      {pair.map((r) => (
                        <td key={r.label} className="bp-cell bp-w50" colSpan={pair.length === 1 ? 2 : 1} data-part={r.part}>
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
            {sno ? (
              <th className="bp-sl" data-part="col.sno">
                Sl No.
              </th>
            ) : null}
            <th data-part="col.description">{h('col.description')}</th>
            {cols.hsn ? <th data-part="col.hsn">{h('col.hsn')}</th> : null}
            {gstCol ? <th data-part="col.gstRate">GST Rate</th> : null}
            {cols.mrp ? <th data-part="col.mrp">MRP*</th> : null}
            {cols.qty ? <th data-part="col.qty">{h('col.qty')}</th> : null}
            {cols.rate ? <th data-part="col.rate">{h('col.rate')}</th> : null}
            {perCol ? <th data-part="col.unit">per</th> : null}
            {cols.discount ? <th data-part="col.discount">{h('col.discount')}</th> : null}
            <th>{h('col.amount')}</th>
          </tr>
        </thead>
        <tbody>
          {doc.lines.map((l) => (
            <tr key={l.sl}>
              {sno ? (
                <td className="bp-sl bp-center" data-part="col.sno">
                  {l.absorbed ? '' : l.sl}
                </td>
              ) : null}
              <td data-part="col.description">
                <span className="bp-strong">{l.name}</span>
                {l.description ? <span className="bp-sub bp-pre">{l.description}</span> : null}
                {l.batch && cols.batch ? (
                  <span className="bp-sub" data-part="col.batch">
                    Batch: {l.batch}
                  </span>
                ) : null}
                {l.absorbed ? <span className="bp-sub">Included in the taxable value</span> : null}
              </td>
              {cols.hsn ? <td data-part="col.hsn">{l.hsnSac ?? ''}</td> : null}
              {gstCol ? (
                <td className="bp-num" data-part="col.gstRate">
                  {l.absorbed ? '' : l.taxability === 'taxable' ? pctText(l.gstRate) : taxabilityText(l.taxability)}
                </td>
              ) : null}
              {cols.mrp ? (
                <td className="bp-num" data-part="col.mrp">
                  {mrpText(l)}
                </td>
              ) : null}
              {cols.qty ? (
                <td className="bp-num bp-strong" data-part="col.qty">
                  {l.qty === null ? '' : `${qtyText(l.qty, l.qtyDecimals)} ${unit(l.unit)}`.trim()}
                </td>
              ) : null}
              {cols.rate ? (
                <td className="bp-num" data-part="col.rate">
                  {rateText(l.rate)}
                </td>
              ) : null}
              {perCol ? <td data-part="col.unit">{l.qty === null ? '' : (l.unit ?? '')}</td> : null}
              {cols.discount ? (
                <td className="bp-num" data-part="col.discount">
                  {l.discountPct ? pctText(l.discountPct) : ''}
                </td>
              ) : null}
              <td className="bp-num bp-strong">{money(l.amount)}</td>
            </tr>
          ))}
          {taxRows.map((r) => (
            <tr key={r.label} className="bp-taxrow" data-part="totals.taxHeads">
              {sno ? <td /> : null}
              <td className="bp-num bp-strong">{r.label}</td>
              {cols.hsn ? <td /> : null}
              {gstCol ? <td /> : null}
              {cols.mrp ? <td /> : null}
              {cols.qty ? <td /> : null}
              {cols.rate ? <td className="bp-num">{r.rate}</td> : null}
              {perCol ? <td>{r.rate ? '%' : ''}</td> : null}
              {cols.discount ? <td /> : null}
              <td className="bp-num bp-strong">{money(r.amount)}</td>
            </tr>
          ))}
          {charges.map((c) => (
            <tr key={c.name} className="bp-taxrow" data-part="totals.charges">
              {sno ? <td /> : null}
              <td className="bp-num bp-strong">{c.name}</td>
              {gap > 0 ? <td colSpan={gap} /> : null}
              <td className="bp-num bp-strong">{money(c.amount)}</td>
            </tr>
          ))}
          {t.roundOff !== 0 && isPartShown(doc, 'totals.roundOff') ? (
            <tr className="bp-taxrow" data-part="totals.roundOff">
              {sno ? <td /> : null}
              <td className="bp-num bp-strong">Round Off</td>
              {gap > 0 ? <td colSpan={gap} /> : null}
              <td className="bp-num bp-strong">{money(t.roundOff)}</td>
            </tr>
          ) : null}
          {t.reverseChargeTax !== 0 ? (
            <tr className="bp-taxrow">
              {sno ? <td /> : null}
              <td className="bp-num bp-small" colSpan={nCols - sno}>
                Tax payable on reverse charge {rupees(t.reverseChargeTax)} (not included)
              </td>
            </tr>
          ) : null}
        </tbody>
        <tfoot>
          <tr data-part="totals.grand">
            <td colSpan={descSpan} className="bp-num">
              {printText(doc, 'label.total', templateText('classic', 'label.total', doc))}
            </td>
            {cols.qty ? <td className="bp-num">{t.qty !== null ? `${qtyText(t.qty, t.qtyDecimals)} ${unit(t.unit)}`.trim() : ''}</td> : null}
            {nCols - descSpan - (cols.qty ? 1 : 0) - 1 > 0 ? <td colSpan={nCols - descSpan - (cols.qty ? 1 : 0) - 1} /> : null}
            <td className="bp-num">{rupees(t.grandTotal)}</td>
          </tr>
          {cols.mrp && doc.mrpSummary ? (
            <tr data-part="col.mrp">
              <td colSpan={nCols} className="bp-cell bp-normal bp-small">
                {doc.mrpSummary.savings > 0 && isPartShown(doc, 'mrpSaved') ? (
                  <>
                    <b data-part="mrpSaved">You saved {rupees(doc.mrpSummary.savings)}</b> on MRP ·{' '}
                  </>
                ) : null}
                * MRP per unit, inclusive of all taxes
              </td>
            </tr>
          ) : null}
          {isPartShown(doc, 'amountInWords') ? (
            <tr data-part="amountInWords">
              <td colSpan={nCols} className="bp-cell bp-normal">
                <div className="bp-eoe">
                  <span className="bp-cap">{printText(doc, 'label.amountInWords', templateText('classic', 'label.amountInWords', doc))}</span>
                  <span className="bp-small">E. &amp; O.E</span>
                </div>
                <div className="bp-strong">{doc.amountInWords}</div>
              </td>
            </tr>
          ) : null}
        </tfoot>
      </table>
      {isPartShown(doc, 'taxSummary') ? <HsnTable doc={doc} /> : null}
      {doc.taxInWords && doc.taxByHsn.length > 0 && isPartShown(doc, 'taxInWords') ? (
        <div className="bp-small bp-pad-v" data-part="taxInWords">
          Tax Amount (in words): <b>{doc.taxInWords}</b>
        </div>
      ) : null}
      {/* (forex group) Export / import invoice in a foreign currency: amounts in it with the rate. */}
      <ForexPrintBlock doc={doc} />
      {/* (pos group) POS bill / return: tenders, cash tendered, change, on account. */}
      <PosPrintBlock doc={doc} />
      <EInvoiceBlock doc={doc} qr={qrs.einvoice} />
      <table className="bp-box bp-avoid">
        <tbody>
          <tr>
            <td className="bp-cell bp-w50">
              {doc.company.pan ? (
                <div data-part="company.pan">
                  Company&apos;s PAN: <b>{doc.company.pan}</b>
                </div>
              ) : null}
              {doc.narration ? (
                <div data-part="narration">
                  <div className="bp-cap">Remarks</div>
                  <div className="bp-pre">{doc.narration}</div>
                </div>
              ) : null}
              {notes ? (
                <div data-part="notes">
                  <div className="bp-cap">Notes</div>
                  <div className="bp-pre bp-small">{notes}</div>
                </div>
              ) : null}
              {doc.terms ? (
                <div data-part="terms">
                  <div className="bp-cap">Terms &amp; conditions</div>
                  <div className="bp-pre bp-small">{doc.terms}</div>
                </div>
              ) : null}
              {doc.declaration ? (
                <div data-part="declaration">
                  <div className="bp-cap">Declaration</div>
                  <div className="bp-pre bp-small">{doc.declaration}</div>
                </div>
              ) : null}
            </td>
            <td className="bp-cell bp-w50">
              <BankBlock bank={doc.bank} />
              <UpiBlock doc={doc} qr={qrs.upi} />
              {isPartShown(doc, 'signature') ? (
                <div className="bp-sign bp-sign-c" data-part="signature">
                  <div className="bp-sign-for">{signForText(printText(doc, 'signFor', templateText('classic', 'signFor', doc)), doc)}</div>
                  <div className="bp-sign-space" />
                  <div>{doc.signatoryLabel}</div>
                </div>
              ) : null}
            </td>
          </tr>
        </tbody>
      </table>
      {isPartShown(doc, 'generatedLine') ? (
        <div className="bp-generated" data-part="generatedLine">
          {printText(doc, 'generatedLine', templateText('classic', 'generatedLine', doc))}
        </div>
      ) : null}
      <FooterLine doc={doc} />
    </article>
  );
}
