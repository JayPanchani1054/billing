/**
 * Printed foreign-currency block (rendered by the print templates under the item table / voucher
 * entries; nothing when the document has no foreign-currency side). Print classes only (bp-*), so the
 * preview and the printed HTML look the same. `data-part="forex"`: the print layout part (2.0 preview editor).
 */
import type { PrintVoucherData } from '../../../shared/types/print.ts';
import { forexInvoiceBlock, forexVoucherLines } from './lib/print.ts';

export function ForexPrintBlock({ doc }: { doc: PrintVoucherData }) {
  const inv = forexInvoiceBlock(doc);
  if (inv) {
    return (
      <section className="bp-avoid" data-part="forex">
        <table className="bp-taxsum">
          <thead>
            <tr>
              <th>{inv.title}</th>
              <th className="bp-num">Rate ({inv.code})</th>
              <th className="bp-num">Amount ({inv.code})</th>
              <th className="bp-num">Amount (₹)</th>
            </tr>
          </thead>
          <tbody>
            {inv.rows
              .filter((r) => r.kind !== 'total')
              .map((r) => (
                <tr key={r.key}>
                  <td>{r.label}</td>
                  <td className="bp-num">{r.rate}</td>
                  <td className="bp-num">{r.foreign}</td>
                  <td className="bp-num">{r.rupees}</td>
                </tr>
              ))}
          </tbody>
          <tfoot>
            {inv.rows
              .filter((r) => r.kind === 'total')
              .map((r) => (
                <tr key={r.key}>
                  <td>{r.label}</td>
                  <td />
                  <td className="bp-num">
                    {inv.code} {r.foreign}
                  </td>
                  <td className="bp-num">₹ {r.rupees}</td>
                </tr>
              ))}
          </tfoot>
        </table>
        {inv.words ? (
          <div className="bp-small">
            Amount in words ({inv.code}): <b>{inv.words}</b>
          </div>
        ) : null}
        <div className="bp-small">{inv.note}</div>
      </section>
    );
  }
  const lines = forexVoucherLines(doc);
  if (lines.length === 0) return null;
  return (
    <section className="bp-avoid" data-part="forex">
      <div className="bp-cap">In foreign currency</div>
      {lines.map((l, i) => (
        <div key={i} className="bp-small">
          {l}
        </div>
      ))}
      {doc.forex?.note ? <div className="bp-small">{doc.forex.note}</div> : null}
    </section>
  );
}
