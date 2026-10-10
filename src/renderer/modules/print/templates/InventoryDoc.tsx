/**
 * Stock documents entered as quantities: delivery challan, orders, receipt notes, rejections,
 * stock journal (source / destination) and physical stock. Prices and amounts appear only when the
 * voucher has them.
 */
import type { PrintLine } from '../../../../shared/types/print.ts';
import { itemColumns, money, moneyOrBlank, mrpText, pctText, qtyText, rateText, rupees, type ItemColumns } from '../lib/layout.ts';
import { CompanyBlock, NotesBlock, Parties, RefsGrid, Signature, Stamp, TitleBlock, type DocProps } from './parts.tsx';

function StockTable({ caption, lines, cols }: { caption?: string; lines: readonly PrintLine[]; cols: ItemColumns }) {
  const qty = lines.reduce((a, l) => a + (l.qty ?? 0), 0);
  const units = new Set(lines.map((l) => l.unit));
  const amount = lines.reduce((a, l) => a + l.amount, 0);
  const lead = 2 + (cols.hsn ? 1 : 0) + (cols.batch ? 1 : 0) + (cols.mrp ? 1 : 0);
  const mid = (cols.rate ? 1 : 0) + (cols.discount ? 1 : 0);
  return (
    <>
      {caption ? <div className="bp-cap bp-pad-v">{caption}</div> : null}
      <table className="bp-items">
        <thead>
          <tr>
            <th className="bp-sl">#</th>
            <th>Description</th>
            {cols.hsn ? <th>HSN/SAC</th> : null}
            {cols.batch ? <th>Batch</th> : null}
            {cols.mrp ? <th className="bp-num">MRP*</th> : null}
            <th className="bp-num">Quantity</th>
            {cols.rate ? <th className="bp-num">Rate</th> : null}
            {cols.discount ? <th className="bp-num">Disc.</th> : null}
            {cols.amount ? <th className="bp-num">Amount</th> : null}
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={`${l.sl}-${i}`}>
              <td className="bp-sl">{i + 1}</td>
              <td>
                <span className="bp-strong">{l.name}</span>
                {l.description ? <span className="bp-sub bp-pre">{l.description}</span> : null}
              </td>
              {cols.hsn ? <td>{l.hsnSac ?? ''}</td> : null}
              {cols.batch ? <td>{l.batch ?? ''}</td> : null}
              {cols.mrp ? <td className="bp-num">{mrpText(l)}</td> : null}
              <td className="bp-num">{l.qty === null ? '' : `${qtyText(l.qty, l.qtyDecimals)} ${l.unit ?? ''}`.trim()}</td>
              {cols.rate ? <td className="bp-num">{rateText(l.rate)}</td> : null}
              {cols.discount ? <td className="bp-num">{l.discountPct ? pctText(l.discountPct) : moneyOrBlank(l.discount)}</td> : null}
              {cols.amount ? <td className="bp-num">{money(l.amount)}</td> : null}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={lead}>Total</td>
            <td className="bp-num">{units.size === 1 ? `${qtyText(qty, Math.max(0, ...lines.map((l) => l.qtyDecimals)))} ${[...units][0] ?? ''}`.trim() : ''}</td>
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
        <CompanyBlock company={doc.company} />
        <TitleBlock doc={doc} copyLabel={copyLabel} />
      </header>
      <RefsGrid doc={doc} />
      <Parties doc={doc} />
      {journal ? (
        <>
          <StockTable caption="Source (consumption)" lines={consumption} cols={cols} />
          <StockTable caption="Destination (production)" lines={production} cols={cols} />
        </>
      ) : (
        <StockTable lines={doc.lines} cols={cols} />
      )}
      {cols.mrp ? <div className="bp-small bp-pad-v">* MRP per unit, inclusive of all taxes</div> : null}
      {cols.amount && doc.totals.grandTotal !== 0 ? (
        <section className="bp-summary bp-avoid">
          <div className="bp-summary-left">
            <div>
              <div className="bp-cap">Value in words</div>
              <div className="bp-words">{doc.amountInWords}</div>
            </div>
          </div>
          <table className="bp-totals">
            <tbody>
              <tr className="bp-total">
                <td>{journal ? 'Production value' : 'Total value'}</td>
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
        <Signature doc={doc} />
      </footer>
      {doc.kind === 'delivery_challan' ? (
        <div className="bp-sigs bp-avoid">
          <div>Receiver&apos;s Signature</div>
          <div>Transporter</div>
          <div>Date &amp; Time of Receipt</div>
        </div>
      ) : null}
    </article>
  );
}
