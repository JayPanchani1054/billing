/**
 * Stock documents entered as quantities: delivery challan, orders, receipt notes, rejections,
 * stock journal (source / destination) and physical stock. Prices and amounts appear only when the
 * voucher has them.
 * (2.0) Honours the print layout applied to the document (SUPPORTED_PARTS below).
 */
import { isPartShown, printText } from '../../../../shared/printLayout.ts';
import type { PrintLine, PrintVoucherData } from '../../../../shared/types/print.ts';
import { itemColumns, money, moneyOrBlank, mrpText, pctText, qtyText, rateText, rupees, type ItemColumns } from '../lib/layout.ts';
import { TEMPLATE_PARTS, templateText } from '../lib/layoutParts.ts';
import { CompanyBlock, FooterLine, NotesBlock, Parties, RefsGrid, Signature, Stamp, TitleBlock, type DocProps } from './parts.tsx';

/** Parts this template prints and honours (the layout editor lists these). */
export const SUPPORTED_PARTS = TEMPLATE_PARTS.inventory;

function StockTable({ doc, caption, lines, cols }: { doc: PrintVoucherData; caption?: string; lines: readonly PrintLine[]; cols: ItemColumns }) {
  const qty = lines.reduce((a, l) => a + (l.qty ?? 0), 0);
  const units = new Set(lines.map((l) => l.unit));
  const amount = lines.reduce((a, l) => a + l.amount, 0);
  const qtyCol = isPartShown(doc, 'col.qty');
  const h = (id: 'col.description' | 'col.hsn' | 'col.qty' | 'col.rate' | 'col.discount' | 'col.amount'): string => printText(doc, id, templateText('inventory', id, doc));
  const unit = (u: string | null): string => (cols.unit ? (u ?? '') : '');
  const lead = (cols.sno ? 1 : 0) + 1 + (cols.hsn ? 1 : 0) + (cols.batch ? 1 : 0) + (cols.mrp ? 1 : 0);
  const mid = (cols.rate ? 1 : 0) + (cols.discount ? 1 : 0);
  return (
    <>
      {caption ? <div className="bp-cap bp-pad-v">{caption}</div> : null}
      <table className="bp-items">
        <thead>
          <tr>
            {cols.sno ? (
              <th className="bp-sl" data-part="col.sno">
                #
              </th>
            ) : null}
            <th data-part="col.description">{h('col.description')}</th>
            {cols.hsn ? <th data-part="col.hsn">{h('col.hsn')}</th> : null}
            {cols.batch ? <th data-part="col.batch">Batch</th> : null}
            {cols.mrp ? (
              <th className="bp-num" data-part="col.mrp">
                MRP*
              </th>
            ) : null}
            {qtyCol ? (
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
            {cols.amount ? (
              <th className="bp-num" data-part="col.amount">
                {h('col.amount')}
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={`${l.sl}-${i}`}>
              {cols.sno ? (
                <td className="bp-sl" data-part="col.sno">
                  {i + 1}
                </td>
              ) : null}
              <td data-part="col.description">
                <span className="bp-strong">{l.name}</span>
                {l.description ? <span className="bp-sub bp-pre">{l.description}</span> : null}
              </td>
              {cols.hsn ? <td data-part="col.hsn">{l.hsnSac ?? ''}</td> : null}
              {cols.batch ? <td data-part="col.batch">{l.batch ?? ''}</td> : null}
              {cols.mrp ? (
                <td className="bp-num" data-part="col.mrp">
                  {mrpText(l)}
                </td>
              ) : null}
              {qtyCol ? (
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
              {cols.amount ? (
                <td className="bp-num" data-part="col.amount">
                  {money(l.amount)}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={lead}>Total</td>
            {qtyCol ? (
              <td className="bp-num">{units.size === 1 ? `${qtyText(qty, Math.max(0, ...lines.map((l) => l.qtyDecimals)))} ${unit([...units][0] ?? null)}`.trim() : ''}</td>
            ) : null}
            {mid > 0 ? <td colSpan={mid} /> : null}
            {cols.amount ? <td className="bp-num">{money(amount)}</td> : null}
          </tr>
        </tfoot>
      </table>
    </>
  );
}

export function InventoryDoc({ doc, copyLabel, pageSize, template }: DocProps) {
  const cols = itemColumns(doc, { pageSize, template });
  const boxed = template === 'classic';
  const journal = doc.baseType === 'stock_journal';
  const consumption = doc.lines.filter((l) => l.section === 'consumption');
  const production = doc.lines.filter((l) => l.section !== 'consumption');
  return (
    <article className={`bp-doc ${boxed ? 'bp-classic' : 'bp-modern'}`}>
      <Stamp doc={doc} />
      <header className="bp-head">
        <CompanyBlock doc={doc} />
        <TitleBlock doc={doc} copyLabel={copyLabel} />
      </header>
      <RefsGrid doc={doc} />
      <Parties doc={doc} />
      {journal ? (
        <>
          <StockTable doc={doc} caption="Source (consumption)" lines={consumption} cols={cols} />
          <StockTable doc={doc} caption="Destination (production)" lines={production} cols={cols} />
        </>
      ) : (
        <StockTable doc={doc} lines={doc.lines} cols={cols} />
      )}
      {cols.mrp ? (
        <div className="bp-small bp-pad-v" data-part="col.mrp">
          * MRP per unit, inclusive of all taxes
        </div>
      ) : null}
      {cols.amount && doc.totals.grandTotal !== 0 ? (
        <section className="bp-summary bp-avoid">
          <div className="bp-summary-left">
            {isPartShown(doc, 'amountInWords') ? (
              <div data-part="amountInWords">
                <div className="bp-cap">{printText(doc, 'label.amountInWords', templateText('inventory', 'label.amountInWords', doc))}</div>
                <div className="bp-words">{doc.amountInWords}</div>
              </div>
            ) : null}
          </div>
          <table className="bp-totals">
            <tbody>
              <tr className="bp-total">
                <td>{printText(doc, 'label.total', templateText('inventory', 'label.total', doc))}</td>
                <td className="bp-num">{rupees(doc.totals.grandTotal)}</td>
              </tr>
            </tbody>
          </table>
        </section>
      ) : null}
      <footer className="bp-foot">
        <div className="bp-foot-left">
          <NotesBlock doc={doc} />
          {doc.kind === 'delivery_challan' ? <div className="bp-small">Received the above goods in good condition.</div> : null}
        </div>
        <Signature doc={doc} kind="inventory" />
      </footer>
      {doc.kind === 'delivery_challan' ? (
        <div className="bp-sigs bp-avoid">
          <div>Receiver&apos;s Signature</div>
          <div>Transporter</div>
          <div>Date &amp; Time of Receipt</div>
        </div>
      ) : null}
      <FooterLine doc={doc} />
    </article>
  );
}
