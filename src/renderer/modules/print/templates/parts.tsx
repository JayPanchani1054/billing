/**
 * Building blocks shared by the document templates. Pure presentational components: props are the
 * print DTO (shared/types/print.ts) plus the pre-rendered QR images; no hooks, no API calls.
 * Every value is rendered as text (React escapes it); images are data: URLs only.
 *
 * (2.0) Print layouts: each printable block carries `data-part="<catalogue id>"` (click-to-select in the
 * preview editor; harmless in print) and honours the layout applied to the document (`doc.applied`,
 * shared/printLayout.ts): `isPartShown(doc, id)` gates, `printText(doc, id, templateText(…))` wording.
 * With no layout every gate is open and every text is the template's own: the 1.0 output.
 */
import type { InvoiceTemplate } from '../../../../shared/settings.ts';
import { isPartShown, printText } from '../../../../shared/printLayout.ts';
import type { PrintAddress, PrintBank, PrintCompany, PrintLine, PrintPageSize, PrintVoucherData } from '../../../../shared/types/print.ts';
import {
  addressLines,
  dateText,
  headerRefsWithParts,
  money,
  moneyOrBlank,
  mrpText,
  partyIds,
  pctText,
  qtyText,
  rateText,
  rupees,
  showMrp,
  taxabilityText,
  totalRows,
  type ItemColumns,
} from '../lib/layout.ts';
import { signForText, templateText, type TemplateKind } from '../lib/layoutParts.ts';
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
    <div className="bp-stamp" aria-hidden="true" data-part="stamp">
      {text}
    </div>
  ) : null;
}

export function CompanyBlock({ doc, compact = false }: { doc: PrintVoucherData; compact?: boolean }) {
  const company: PrintCompany = doc.company;
  const logo = safeImage(company.logo);
  const contact = [company.phone ? `Ph: ${company.phone}` : null, company.email, company.website].filter(Boolean).join(' · ');
  return (
    <div className="bp-brand">
      {logo && !compact ? <img className="bp-logo" src={logo} alt="Logo" data-part="logo" /> : null}
      <div>
        {isPartShown(doc, 'company.name') ? (
          <div className="bp-co-name" data-part="company.name">
            {company.displayName}
          </div>
        ) : null}
        <div className="bp-co-lines">
          {isPartShown(doc, 'company.address')
            ? addressLines(company).map((l, i) => (
                <div key={i} data-part="company.address">
                  {l}
                </div>
              ))
            : null}
          {company.gstin ? (
            <div data-part="company.gstin">
              GSTIN/UIN: <b>{company.gstin}</b>
              {company.stateCode ? ` · State: ${company.stateName ?? ''}, Code ${company.stateCode}` : ''}
            </div>
          ) : null}
          {!company.gstin && company.pan ? <div data-part="company.pan">PAN: {company.pan}</div> : null}
          {company.cin ? <div data-part="company.cin">CIN: {company.cin}</div> : null}
          {contact ? <div data-part="company.contact">{contact}</div> : null}
        </div>
      </div>
    </div>
  );
}

export function TitleBlock({ doc, copyLabel }: { doc: PrintVoucherData; copyLabel: string | null }) {
  return (
    <div className="bp-titlebox">
      {isPartShown(doc, 'title') ? (
        <h2 className="bp-title" data-part="title">
          {doc.title}
        </h2>
      ) : null}
      {copyLabel && isPartShown(doc, 'copyLabel') ? (
        <div className="bp-copy" data-part="copyLabel">
          {copyLabel}
        </div>
      ) : null}
      {doc.endorsement ? (
        <div className="bp-endorse" data-part="endorsement">
          {doc.endorsement}
        </div>
      ) : null}
      {doc.notes.map((n, i) => (
        <div key={i} className="bp-notes" data-part="statutoryNotes">
          {n}
        </div>
      ))}
    </div>
  );
}

export function RefsGrid({ doc }: { doc: PrintVoucherData }) {
  return (
    <div className="bp-refs">
      {headerRefsWithParts(doc).map((r, i) => (
        <div key={i} className="bp-ref" data-part={r.part}>
          <div className="bp-cap">{r.label}</div>
          <div className="bp-v">{r.value}</div>
        </div>
      ))}
    </div>
  );
}

/** Print part of a party identifier line: the party's GSTIN / PAN and contact are parts of their own. */
export function partyIdPart(box: 'party' | 'consignee', label: string): 'party.gstin' | 'party.contact' | undefined {
  if (box !== 'party') return undefined;
  if (label === 'GSTIN/UIN' || label === 'PAN') return 'party.gstin';
  if (label === 'Phone' || label === 'E-mail') return 'party.contact';
  return undefined;
}

export function PartyBox({ label, address, showState = true, part }: { label: string; address: PrintAddress | null; showState?: boolean; part: 'party' | 'consignee' }) {
  if (!address) return null;
  return (
    <div data-part={part}>
      <div className="bp-cap">{label}</div>
      <div className="bp-party-name">{address.name ?? ''}</div>
      {addressLines(address).map((l, i) => (
        <div key={i}>{l}</div>
      ))}
      <div className="bp-ids">
        {partyIds(address, showState).map((p) => (
          <span key={p.label} data-part={partyIdPart(part, p.label)}>
            {p.label}: <b>{p.value}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

export function Parties({ doc }: { doc: PrintVoucherData }) {
  const party = isPartShown(doc, 'party') ? doc.party : null;
  if (!party && !doc.consignee) return null;
  const showConsignee = doc.consignee && (doc.layout === 'invoice' || !doc.consigneeSameAsParty);
  return (
    <div className="bp-parties">
      <PartyBox label={doc.partyLabel} address={party} part="party" />
      {showConsignee ? <PartyBox label={doc.consigneeLabel} address={doc.consignee} part="consignee" /> : <div />}
    </div>
  );
}

/** Item / line table of the modern layout (also used for orders, notes and challans). */
export function ItemsTable({ doc, cols }: { doc: PrintVoucherData; cols: ItemColumns }) {
  const sgst = doc.gst.sgstLabel;
  const showGstRate = cols.gstRate && !cols.lineTax;
  const lines = doc.lines;
  const t = doc.totals;
  const h = (id: 'col.description' | 'col.hsn' | 'col.qty' | 'col.rate' | 'col.discount' | 'col.taxable' | 'col.amount'): string =>
    printText(doc, id, templateText('modern', id, doc, { lineTax: cols.lineTax }));
  const unit = (u: string | null): string => (cols.unit ? (u ?? '') : '');
  // The value column: the line amount, or with per-line tax columns the taxable value (then a Total column).
  const valueCol = cols.lineTax ? cols.taxable : cols.amount;
  const valuePart = cols.lineTax ? 'col.taxable' : 'col.amount';
  const totalCol = cols.lineTax && cols.amount;
  // Footer: 'Total' under # / Description / HSN, the quantity, blanks under Rate / Disc. / GST, then amounts.
  const lead = (cols.sno ? 1 : 0) + 1 + (cols.hsn ? 1 : 0) + (cols.mrp ? 1 : 0);
  const mid = (cols.rate ? 1 : 0) + (cols.discount ? 1 : 0) + (showGstRate ? 1 : 0);
  return (
    <table className="bp-items">
      <thead>
        <tr data-part={cols.lineTax ? 'lineTax' : undefined}>
          {cols.sno ? (
            <th className="bp-sl" data-part="col.sno">
              #
            </th>
          ) : null}
          <th data-part="col.description">{h('col.description')}</th>
          {cols.hsn ? <th data-part="col.hsn">{h('col.hsn')}</th> : null}
          {cols.mrp ? (
            <th className="bp-num" data-part="col.mrp">
              MRP*
            </th>
          ) : null}
          {cols.qty ? (
            <th className="bp-num" data-part="col.qty">
              {h('col.qty')}
            </th>
          ) : null}
          {cols.rate ? (
            <th className="bp-num" data-part="col.rate">
              {h('col.rate')}
            </th>
          ) : null}
          {cols.discount ? (
            <th className="bp-num" data-part="col.discount">
              {h('col.discount')}
            </th>
          ) : null}
          {showGstRate ? (
            <th className="bp-num" data-part="col.gstRate">
              GST
            </th>
          ) : null}
          {valueCol ? (
            <th className="bp-num" data-part={valuePart}>
              {h(valuePart)}
            </th>
          ) : null}
          {cols.lineHeads.cgst ? (
            <th className="bp-num" data-part="col.cgst">
              CGST
            </th>
          ) : null}
          {cols.lineHeads.sgst ? (
            <th className="bp-num" data-part="col.sgst">
              {sgst}
            </th>
          ) : null}
          {cols.lineHeads.igst ? (
            <th className="bp-num" data-part="col.igst">
              IGST
            </th>
          ) : null}
          {cols.lineHeads.cess ? (
            <th className="bp-num" data-part="col.cess">
              Cess
            </th>
          ) : null}
          {totalCol ? (
            <th className="bp-num" data-part="col.amount">
              {h('col.amount')}
            </th>
          ) : null}
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.sl} className={l.absorbed ? 'bp-absorbed' : undefined}>
            {cols.sno ? (
              <td className="bp-sl" data-part="col.sno">
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
              {l.absorbed ? <span className="bp-sub">Included in the taxable value of the goods</span> : null}
              {l.reverseCharge && l.tax !== 0 ? <span className="bp-sub">Tax payable on reverse charge</span> : null}
            </td>
            {cols.hsn ? <td data-part="col.hsn">{l.hsnSac ?? ''}</td> : null}
            {cols.mrp ? (
              <td className="bp-num" data-part="col.mrp">
                {mrpText(l)}
              </td>
            ) : null}
            {cols.qty ? (
              <td className="bp-num" data-part="col.qty">
                {l.qty === null ? '' : `${qtyText(l.qty, l.qtyDecimals)} ${unit(l.unit)}`.trim()}
              </td>
            ) : null}
            {cols.rate ? (
              <td className="bp-num" data-part="col.rate">
                {rateText(l.rate)}
              </td>
            ) : null}
            {cols.discount ? (
              <td className="bp-num" data-part="col.discount">
                {l.discountPct ? pctText(l.discountPct) : moneyOrBlank(l.discount)}
              </td>
            ) : null}
            {showGstRate ? (
              <td className="bp-num" data-part="col.gstRate">
                {l.absorbed ? '' : l.taxability === 'taxable' ? pctText(l.gstRate) : taxabilityShort(l.taxability)}
              </td>
            ) : null}
            {valueCol ? (
              <td className="bp-num" data-part={valuePart}>
                {cols.lineTax ? (l.absorbed ? '' : money(l.taxableValue)) : money(l.amount)}
              </td>
            ) : null}
            {cols.lineHeads.cgst ? <TaxCell rate={l.gstRate / 2} amount={l.cgst} part="col.cgst" /> : null}
            {cols.lineHeads.sgst ? <TaxCell rate={l.gstRate / 2} amount={l.sgst} part="col.sgst" /> : null}
            {cols.lineHeads.igst ? <TaxCell rate={l.gstRate} amount={l.igst} part="col.igst" /> : null}
            {cols.lineHeads.cess ? <TaxCell rate={l.cessRate} amount={l.cess} part="col.cess" /> : null}
            {totalCol ? (
              <td className="bp-num" data-part="col.amount">
                {l.absorbed ? '' : money(l.taxableValue + l.tax)}
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={lead}>Total</td>
          {cols.qty ? <td className="bp-num">{t.qty !== null ? `${qtyText(t.qty, t.qtyDecimals)} ${unit(t.unit)}`.trim() : ''}</td> : null}
          {mid > 0 ? <td colSpan={mid} /> : null}
          {valueCol ? <td className="bp-num">{money(t.taxable)}</td> : null}
          {cols.lineHeads.cgst ? <td className="bp-num">{money(sumLines(doc, 'cgst'))}</td> : null}
          {cols.lineHeads.sgst ? <td className="bp-num">{money(sumLines(doc, 'sgst'))}</td> : null}
          {cols.lineHeads.igst ? <td className="bp-num">{money(sumLines(doc, 'igst'))}</td> : null}
          {cols.lineHeads.cess ? <td className="bp-num">{money(sumLines(doc, 'cess'))}</td> : null}
          {totalCol ? <td className="bp-num">{money(t.taxable + sumLines(doc, 'tax'))}</td> : null}
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

function TaxCell({ rate, amount, part }: { rate: number; amount: number; part: 'col.cgst' | 'col.sgst' | 'col.igst' | 'col.cess' }) {
  return (
    <td className="bp-num" data-part={part}>
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
          <tr key={i} className={r.kind === 'total' ? 'bp-total' : undefined} data-part={r.part}>
            <td>{r.kind === 'total' ? printText(doc, 'label.total', r.label) : r.label}</td>
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
        <MrpRows doc={doc} />
      </tbody>
    </table>
  );
}

/** (print group) Under the totals: what the buyer saved against MRP, and the MRP footnote. */
export function MrpRows({ doc, colSpan = 2 }: { doc: PrintVoucherData; colSpan?: number }) {
  if (!showMrp(doc) || !doc.mrpSummary) return null;
  const saved = doc.mrpSummary.savings;
  return (
    <>
      {saved > 0 && isPartShown(doc, 'mrpSaved') ? (
        <tr data-part="mrpSaved">
          <td className="bp-strong">You saved</td>
          <td className="bp-num bp-strong" colSpan={colSpan - 1}>
            {rupees(saved)}
          </td>
        </tr>
      ) : null}
      <tr data-part="col.mrp">
        <td className="bp-small" colSpan={colSpan}>
          * MRP per unit, inclusive of all taxes
        </td>
      </tr>
    </>
  );
}

export function Words({ doc, kind }: { doc: PrintVoucherData; kind: TemplateKind }) {
  const words = isPartShown(doc, 'amountInWords');
  const tax = !!doc.taxInWords && isPartShown(doc, 'taxInWords');
  if (!words && !tax) return null;
  return (
    <div>
      {words ? (
        <>
          <div className="bp-cap" data-part="amountInWords">
            {printText(doc, 'label.amountInWords', templateText(kind, 'label.amountInWords', doc))}
          </div>
          <div className="bp-words" data-part="amountInWords">
            {doc.amountInWords}
          </div>
        </>
      ) : null}
      {tax ? (
        <div className="bp-small" data-part="taxInWords">
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
    <div data-part="bank">
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
    <div className="bp-pay" data-part="upiQr">
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
    <table className="bp-taxsum bp-avoid" data-part="taxSummary">
      <thead>
        <tr>
          <th data-part={byHsn ? 'hsnSummary' : undefined}>{byHsn ? 'HSN/SAC' : 'GST rate'}</th>
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
    <div className="bp-einv" data-part="einvoice">
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

export function Signature({ doc, kind }: { doc: PrintVoucherData; kind: TemplateKind }) {
  if (!isPartShown(doc, 'signature')) return null;
  return (
    <div className="bp-sign" data-part="signature">
      <div className="bp-sign-for">{signForText(printText(doc, 'signFor', templateText(kind, 'signFor', doc)), doc)}</div>
      <div className="bp-sign-space" />
      <div>{doc.signatoryLabel}</div>
    </div>
  );
}

/** The layout's "Notes" text (printed above the terms), '' when none or hidden. */
export function notesText(doc: PrintVoucherData): string {
  return isPartShown(doc, 'notes') ? printText(doc, 'notes', '') : '';
}

export function NotesBlock({ doc }: { doc: PrintVoucherData }) {
  const items: Array<{ label: string; text: string; part: 'narration' | 'notes' | 'terms' | 'declaration' }> = [];
  if (doc.narration) items.push({ label: 'Narration', text: doc.narration, part: 'narration' });
  const notes = notesText(doc);
  if (notes) items.push({ label: 'Notes', text: notes, part: 'notes' });
  if (doc.terms) items.push({ label: 'Terms & conditions', text: doc.terms, part: 'terms' });
  if (doc.declaration) items.push({ label: 'Declaration', text: doc.declaration, part: 'declaration' });
  if (items.length === 0) return null;
  return (
    <>
      {items.map((it) => (
        <div key={it.label} data-part={it.part}>
          <div className="bp-cap">{it.label}</div>
          <div className="bp-pre bp-small">{it.text}</div>
        </div>
      ))}
    </>
  );
}

export function GeneratedLine({ doc, kind }: { doc: PrintVoucherData; kind: TemplateKind }) {
  if (!isPartShown(doc, 'generatedLine')) return null;
  return (
    <div className="bp-generated" data-part="generatedLine">
      {printText(doc, 'generatedLine', templateText(kind, 'generatedLine', doc))}
    </div>
  );
}

/** The layout's "Footer line" text at the foot of the document (nothing unless a layout sets it). */
export function FooterLine({ doc, className = 'bp-generated bp-pre' }: { doc: PrintVoucherData; className?: string }) {
  const text = isPartShown(doc, 'footer') ? printText(doc, 'footer', '') : '';
  if (!text) return null;
  return (
    <div className={className} data-part="footer">
      {text}
    </div>
  );
}
