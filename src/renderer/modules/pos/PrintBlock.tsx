/**
 * Printed "Paid by" / "Refunded by" block of a POS bill or return (rendered by the print templates:
 * Compact receipt, Modern and Classic invoices; nothing for other documents). Print classes only
 * (bp-*), so the preview and the printed HTML look the same.
 */
import type { PrintVoucherData } from '../../../shared/types/print.ts';
import { posPrintRows } from './lib/print.ts';

export function PosPrintBlock({ doc, compact = false }: { doc: PrintVoucherData; compact?: boolean }) {
  if (!doc.pos) return null;
  const { title, rows, footer } = posPrintRows(doc.pos);
  if (rows.length === 0 && !footer) return null;
  if (compact) {
    return (
      <>
        <div className="bp-c-rule" />
        <table>
          <tbody>
            <tr>
              <td colSpan={2}>
                <b>{title}</b>
              </td>
            </tr>
            {rows.map((r) => (
              <tr key={r.key} className={r.strong ? 'bp-c-total' : undefined}>
                <td>{r.label}</td>
                <td className="bp-num">{r.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {footer ? <div className="bp-small">{footer}</div> : null}
      </>
    );
  }
  return (
    <section className="bp-avoid">
      <table className="bp-taxsum">
        <thead>
          <tr>
            <th>{title}</th>
            <th className="bp-num">Amount (₹)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.strong ? <b>{r.label}</b> : r.label}</td>
              <td className="bp-num">{r.strong ? <b>{r.amount}</b> : r.amount}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {footer ? <div className="bp-small">{footer}</div> : null}
    </section>
  );
}
