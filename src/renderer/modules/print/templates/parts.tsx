/**
 * Building blocks shared by the document templates. Pure presentational components: props are the
 * print DTO (shared/types/print.ts) plus the pre-rendered QR images; no hooks, no API calls.
 * Every value is rendered as text (React escapes it); images are data: URLs only.
 */
import type { ReactNode } from 'react';
import type { InvoiceTemplate } from '../../../../shared/settings.ts';
import type { PrintAddress, PrintBank, PrintCompany, PrintLine, PrintPageSize, PrintVoucherData } from '../../../../shared/types/print.ts';
import {
  addressLines,
  dateText,
  headerRefs,
  money,
  moneyOrBlank,
  partyIds,
  pctText,
  qtyText,
  rateText,
  rupees,
  taxabilityText,
  totalRows,
  type ItemColumns,
} from '../lib/layout.ts';
import type { DocumentQrs } from '../lib/qr.ts';

export interface DocProps {
  doc: PrintVoucherData;
  /** 'Original for Recipient' …, or null when no copy label is printed. */
  copyLabel: string | null;
  qrs: DocumentQrs;
  pageSize: PrintPageSize;
  template: InvoiceTemplate;
}

/** Only data: image URLs are ever placed in an <img> (never a remote or file URL). */
export function safeImage(src: string | null | undefined): string | null {
  return typeof src === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(src) ? src : null;
}

export function Stamp({ doc }: { doc: PrintVoucherData }) {
  const text = doc.status.cancelled ? 'CANCELLED' : doc.status.optional ? 'OPTIONAL' : doc.sample ? 'SAMPLE' : null;
  return text ? (
    <div className="bp-stamp" aria-hidden="true">
      {text}
    </div>
  ) : null;
}

export function CompanyBlock({ company, compact = false }: { company: PrintCompany; compact?: boolean }) {
  const logo = safeImage(company.logo);
  const contact = [company.phone ? `Ph: ${company.phone}` : null, company.email, company.website].filter(Boolean).join(' · ');
  return (
    <div className="bp-brand">
      {logo && !compact ? <img className="bp-logo" src={logo} alt="Logo" /> : null}
      <div>
        <div className="bp-co-name">{company.displayName}</div>
        <div className="bp-co-lines">
          {addressLines(company).map((l, i) => (
            <div key={i}>{l}</div>
          ))}
          {company.gstin ? (
            <div>
              GSTIN/UIN: <b>{company.gstin}</b>
              {company.stateCode ? ` · State: ${company.stateName ?? ''}, Code ${company.stateCode}` : ''}
            </div>
          ) : null}
          {!company.gstin && company.pan ? <div>PAN: {company.pan}</div> : null}
          {company.cin ? <div>CIN: {company.cin}</div> : null}
          {contact ? <div>{contact}</div> : null}
        </div>
      </div>
    </div>
  );
}

export function TitleBlock({ doc, copyLabel }: { doc: PrintVoucherData; copyLabel: string | null }) {
  return (
    <div className="bp-titlebox">
      <h2 className="bp-title">{doc.title}</h2>
      {copyLabel ? <div className="bp-copy">{copyLabel}</div> : null}
      {doc.endorsement ? <div className="bp-endorse">{doc.endorsement}</div> : null}
      {doc.notes.map((n, i) => (
        <div key={i} className="bp-notes">
          {n}
        </div>
      ))}
    </div>
  );
}

export function RefsGrid({ doc }: { doc: PrintVoucherData }) {
  return (
    <div className="bp-refs">
      {headerRefs(doc).map((r, i) => (
        <div key={i} className="bp-ref">
          <div className="bp-cap">{r.label}</div>
          <div className="bp-v">{r.value}</div>
        </div>
      ))}
    </div>
  );
}

export function PartyBox({ label, address, showState = true }: { label: string; address: PrintAddress | null; showState?: boolean }) {
  if (!address) return null;
  return (
    <div>
      <div className="bp-cap">{label}</div>
      <div className="bp-party-name">{address.name ?? ''}</div>
      {addressLines(address).map((l, i) => (
        <div key={i}>{l}</div>
      ))}
      <div className="bp-ids">
        {partyIds(address, showState).map((p) => (
          <span key={p.label}>
            {p.label}: <b>{p.value}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

export function Parties({ doc }: { doc: PrintVoucherData }) {
  if (!doc.party && !doc.consignee) return null;
  const showConsignee = doc.consignee && (doc.layout === 'invoice' || !doc.consigneeSameAsParty);
  return (
    <div className="bp-parties">
      <PartyBox label={doc.partyLabel} address={doc.party} />
      {showConsignee ? <PartyBox label={doc.consigneeLabel} address={doc.consignee} /> : <div />}
    </div>
  );
}

/** Item / line table of the modern layout (also used for orders, notes and challans). */
export function ItemsTable({ doc, cols }: { doc: PrintVoucherData; cols: ItemColumns }) {
  const sgst = doc.gst.sgstLabel;
  const showGstRate = doc.gst.showTax && !cols.lineTax;
  const lines = doc.lines;
  const t = doc.totals;
  // Footer: 'Total' under # / Description / HSN, the quantity, blanks under Rate / Disc. / GST, then amounts.
  const lead = 2 + (cols.hsn ? 1 : 0);
  const mid = (cols.rate ? 1 : 0) + (cols.discount ? 1 : 0) + (showGstRate ? 1 : 0);
  return (
    <table className="bp-items">
      <thead>
        <tr>
          <th className="bp-sl">#</th>
          <th>Description</th>
          {cols.hsn ? <th>HSN/SAC</th> : null}
          {cols.qty ? <th className="bp-num">Qty</th> : null}
          {cols.rate ? <th className="bp-num">Rate</th> : null}
          {cols.discount ? <th className="bp-num">Disc.</th> : null}
          {showGstRate ? <th className="bp-num">GST</th> : null}
          {cols.amount ? <th className="bp-num">{cols.lineTax ? 'Taxable' : 'Amount'}</th> : null}
          {cols.lineTax && cols.cgstSgst ? <th className="bp-num">CGST</th> : null}
          {cols.lineTax && cols.cgstSgst ? <th className="bp-num">{sgst}</th> : null}
          {cols.lineTax && cols.igst ? <th className="bp-num">IGST</th> : null}
          {cols.lineTax && cols.cess ? <th className="bp-num">Cess</th> : null}
          {cols.lineTax ? <th className="bp-num">Total</th> : null}
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.sl} className={l.absorbed ? 'bp-absorbed' : undefined}>
            <td className="bp-sl">{l.absorbed ? '' : l.sl}</td>
            <td>
              <span className="bp-strong">{l.name}</span>
              {l.description ? <span className="bp-sub bp-pre">{l.description}</span> : null}
              {l.batch ? <span className="bp-sub">Batch: {l.batch}</span> : null}
              {l.absorbed ? <span className="bp-sub">Included in the taxable value of the goods</span> : null}
              {l.reverseCharge && l.tax !== 0 ? <span className="bp-sub">Tax payable on reverse charge</span> : null}
            </td>
            {cols.hsn ? <td>{l.hsnSac ?? ''}</td> : null}
            {cols.qty ? <td className="bp-num">{l.qty === null ? '' : `${qtyText(l.qty, l.qtyDecimals)} ${l.unit ?? ''}`.trim()}</td> : null}
            {cols.rate ? <td className="bp-num">{rateText(l.rate)}</td> : null}
            {cols.discount ? <td className="bp-num">{l.discountPct ? pctText(l.discountPct) : moneyOrBlank(l.discount)}</td> : null}
            {showGstRate ? <td className="bp-num">{l.absorbed ? '' : l.taxability === 'taxable' ? pctText(l.gstRate) : taxabilityShort(l.taxability)}</td> : null}
            {cols.amount ? <td className="bp-num">{cols.lineTax ? (l.absorbed ? '' : money(l.taxableValue)) : money(l.amount)}</td> : null}
            {cols.lineTax && cols.cgstSgst ? <TaxCell rate={l.gstRate / 2} amount={l.cgst} /> : null}
            {cols.lineTax && cols.cgstSgst ? <TaxCell rate={l.gstRate / 2} amount={l.sgst} /> : null}
            {cols.lineTax && cols.igst ? <TaxCell rate={l.gstRate} amount={l.igst} /> : null}
            {cols.lineTax && cols.cess ? <TaxCell rate={l.cessRate} amount={l.cess} /> : null}
            {cols.lineTax ? <td className="bp-num">{l.absorbed ? '' : money(l.taxableValue + l.tax)}</td> : null}
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={lead}>Total</td>
          {cols.qty ? <td className="bp-num">{t.qty !== null ? `${qtyText(t.qty, t.qtyDecimals)} ${t.unit ?? ''}`.trim() : ''}</td> : null}
          {mid > 0 ? <td colSpan={mid} /> : null}
          {cols.amount ? <td className="bp-num">{money(t.taxable)}</td> : null}
          {cols.lineTax && cols.cgstSgst ? <td className="bp-num">{money(sumLines(doc, 'cgst'))}</td> : null}
          {cols.lineTax && cols.cgstSgst ? <td className="bp-num">{money(sumLines(doc, 'sgst'))}</td> : null}
          {cols.lineTax && cols.igst ? <td className="bp-num">{money(sumLines(doc, 'igst'))}</td> : null}
          {cols.lineTax && cols.cess ? <td className="bp-num">{money(sumLines(doc, 'cess'))}</td> : null}
          {cols.lineTax ? <td className="bp-num">{money(t.taxable + sumLines(doc, 'tax'))}</td> : null}
        </tr>
      </tfoot>
    </table>
  );
}

function sumLines(doc: PrintVoucherData, key: 'cgst' | 'sgst' | 'igst' | 'cess' | 'tax'): number {
  return doc.lines.reduce((a, l) => a + l[key], 0);
}

/** Tax head amount in a summary row, with the head's rate under it (Rule 46(i): rate per tax head). */
function SummaryTaxCell({ rate, amount }: { rate: number | null; amount: number }) {
  return (
    <td className="bp-num">
      {money(amount)}
      {amount !== 0 && rate !== null ? <span className="bp-sub">@ {pctText(rate)}</span> : null}
    </td>
  );
}

function TaxCell({ rate, amount }: { rate: number; amount: number }) {
  return (
    <td className="bp-num">
      {amount !== 0 ? money(amount) : ''}
      {amount !== 0 ? <span className="bp-sub">@ {pctText(rate)}</span> : null}
    </td>
  );
}

export function taxabilityShort(t: PrintLine['taxability']): string {
  return taxabilityText(t);
}

export function TotalsTable({ doc }: { doc: PrintVoucherData }) {
  return (
    <table className="bp-totals">
      <tbody>
        {totalRows(doc).map((r, i) => (
          <tr key={i} className={r.kind === 'total' ? 'bp-total' : undefined}>
            <td>{r.kind === 'total' ? `${r.label}` : r.label}</td>
            <td className="bp-num">{r.kind === 'total' ? rupees(r.amount) : money(r.amount)}</td>
          </tr>
        ))}
        {doc.totals.reverseChargeTax !== 0 ? (
          <tr>
            <td className="bp-small" colSpan={2}>
              Tax payable on reverse charge: {rupees(doc.totals.reverseChargeTax)} (not included above)
            </td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

export function Words({ doc, label = 'Amount in words' }: { doc: PrintVoucherData; label?: string }) {
  return (
    <div>
      <div className="bp-cap">{label}</div>
      <div className="bp-words">{doc.amountInWords}</div>
      {doc.taxInWords ? (
        <div className="bp-small">
          Tax amount: <b>{doc.taxInWords}</b>
        </div>
      ) : null}
    </div>
  );
}

export function BankBlock({ bank }: { bank: PrintBank | null }) {
  if (!bank || (!bank.accountNo && !bank.ifsc)) return null;
  const rows: Array<[string, string | null]> = [
    ['A/c Holder', bank.accountHolder],
    ['Bank', bank.bankName],
    ['A/c No.', bank.accountNo],
    ['IFSC', bank.ifsc],
    ['Branch', bank.branch],
  ];
  return (
    <div>
      <div className="bp-cap">Bank details</div>
      <table className="bp-bank">
        <tbody>
          {rows
            .filter((r): r is [string, string] => !!r[1])
            .map(([k, val]) => (
              <tr key={k}>
                <td className="bp-muted">{k}</td>
                <td className="bp-strong">{val}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

export function UpiBlock({ doc, qr }: { doc: PrintVoucherData; qr: string | null }) {
  const src = safeImage(qr);
  if (!doc.upi || !src) return null;
  return (
    <div className="bp-pay">
      <img className="bp-qr" src={src} alt="UPI QR code" />
      <div>
        <div className="bp-cap">Scan to pay with any UPI app</div>
        <div className="bp-strong">{rupees(doc.upi.amount)}</div>
        <div className="bp-small">UPI ID: {doc.upi.id}</div>
      </div>
    </div>
  );
}

/** HSN/SAC-wise tax summary (or rate-wise when HSN summary is off). */
export function TaxSummary({ doc, cols, byHsn }: { doc: PrintVoucherData; cols: ItemColumns; byHsn: boolean }) {
  if (!doc.gst.showTax) return null;
  const rows = byHsn
    ? doc.taxByHsn.map((r) => ({
        key: `${r.hsnSac}|${r.rate}`,
        first: r.hsnSac || '—',
        qtyLabel: r.qty !== null ? `${qtyText(r.qty, 3).replace(/\.?0+$/, '')} ${r.unit ?? ''}`.trim() : '',
        rate: r.rate,
        cessRate: null as number | null,
        taxableValue: r.taxableValue,
        cgst: r.cgst,
        sgst: r.sgst,
        igst: r.igst,
        cess: r.cess,
        tax: r.tax,
      }))
    : doc.taxByRate.map((r) => ({
        key: `${r.taxability}|${r.rate}|${r.reverseCharge}`,
        first: r.taxability === 'taxable' ? pctText(r.rate) + (r.reverseCharge ? ' (RCM)' : '') : taxabilityShort(r.taxability),
        qtyLabel: '',
        rate: r.rate,
        cessRate: r.cessRate as number | null,
        taxableValue: r.taxableValue,
        cgst: r.cgst,
        sgst: r.sgst,
        igst: r.igst,
        cess: r.cess,
        tax: r.tax,
      }));
  if (rows.length === 0) return null;
  const sgst = doc.gst.sgstLabel;
  const total = (k: 'taxableValue' | 'cgst' | 'sgst' | 'igst' | 'cess' | 'tax'): number => rows.reduce((a, r) => a + r[k], 0);
  return (
    <table className="bp-taxsum bp-avoid">
      <thead>
        <tr>
          <th>{byHsn ? 'HSN/SAC' : 'GST rate'}</th>
          {byHsn ? <th className="bp-num">Qty</th> : null}
          {byHsn ? <th className="bp-num">Rate</th> : null}
          <th className="bp-num">Taxable value</th>
          {cols.cgstSgst ? <th className="bp-num">CGST</th> : null}
          {cols.cgstSgst ? <th className="bp-num">{sgst}</th> : null}
          {cols.igst ? <th className="bp-num">IGST</th> : null}
          {cols.cess ? <th className="bp-num">Cess</th> : null}
          <th className="bp-num">Total tax</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>{r.first}</td>
            {byHsn ? <td className="bp-num">{r.qtyLabel}</td> : null}
            {byHsn ? <td className="bp-num">{pctText(r.rate)}</td> : null}
            <td className="bp-num">{money(r.taxableValue)}</td>
            {cols.cgstSgst ? <SummaryTaxCell amount={r.cgst} rate={r.rate / 2} /> : null}
            {cols.cgstSgst ? <SummaryTaxCell amount={r.sgst} rate={r.rate / 2} /> : null}
            {cols.igst ? <SummaryTaxCell amount={r.igst} rate={r.rate} /> : null}
            {cols.cess ? <SummaryTaxCell amount={r.cess} rate={r.cessRate} /> : null}
            <td className="bp-num">{money(r.tax)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={byHsn ? 3 : 1}>Total</td>
          <td className="bp-num">{money(total('taxableValue'))}</td>
          {cols.cgstSgst ? <td className="bp-num">{money(total('cgst'))}</td> : null}
          {cols.cgstSgst ? <td className="bp-num">{money(total('sgst'))}</td> : null}
          {cols.igst ? <td className="bp-num">{money(total('igst'))}</td> : null}
          {cols.cess ? <td className="bp-num">{money(total('cess'))}</td> : null}
          <td className="bp-num">{money(total('tax'))}</td>
        </tr>
      </tfoot>
    </table>
  );
}

export function EInvoiceBlock({ doc, qr }: { doc: PrintVoucherData; qr: string | null }) {
  if (!doc.einvoice) return null;
  const src = safeImage(qr);
  return (
    <div className="bp-einv">
      {src ? <img className="bp-qr-lg" src={src} alt="e-Invoice QR code" /> : null}
      <div>
        <div className="bp-cap">e-Invoice</div>
        <div>
          IRN: <span className="bp-irn">{doc.einvoice.irn}</span>
        </div>
        {doc.einvoice.ackNo ? <div>Ack No.: {doc.einvoice.ackNo}</div> : null}
        {doc.einvoice.ackDate ? <div>Ack Date: {doc.einvoice.ackDate.length >= 10 ? `${dateText(doc.einvoice.ackDate.slice(0, 10))}${doc.einvoice.ackDate.slice(10)}` : doc.einvoice.ackDate}</div> : null}
      </div>
    </div>
  );
}

export function Signature({ doc }: { doc: PrintVoucherData }) {
  return (
    <div className="bp-sign">
      <div className="bp-sign-for">For {doc.company.displayName}</div>
      <div className="bp-sign-space" />
      <div>{doc.signatoryLabel}</div>
    </div>
  );
}

export function NotesBlock({ doc }: { doc: PrintVoucherData }) {
  const items: Array<{ label: string; text: string }> = [];
  if (doc.narration) items.push({ label: 'Narration', text: doc.narration });
  if (doc.terms) items.push({ label: 'Terms & conditions', text: doc.terms });
  if (doc.declaration) items.push({ label: 'Declaration', text: doc.declaration });
  if (items.length === 0) return null;
  return (
    <>
      {items.map((it) => (
        <div key={it.label}>
          <div className="bp-cap">{it.label}</div>
          <div className="bp-pre bp-small">{it.text}</div>
        </div>
      ))}
    </>
  );
}

export function GeneratedLine({ children }: { children?: ReactNode }) {
  return <div className="bp-generated">{children ?? 'This is a computer-generated document.'}</div>;
}
