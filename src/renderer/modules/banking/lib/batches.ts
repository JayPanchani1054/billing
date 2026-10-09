/**
 * Deleting an imported bank statement (Match screen › Alt+D) — pure, tested in batches.test.ts.
 *
 * Statement lines are de-duplicated per bank ledger, so a statement imported into the wrong bank, or
 * with a wrong column mapping (withdrawal / deposit swapped), can only be re-imported after the wrong
 * import is deleted ('banking.statement.deleteBatch'). Lines already reconciled with vouchers block
 * the delete unless they are unmatched with it (their vouchers lose the bank date; a voucher created
 * from a line is kept).
 */
import { formatDate } from '../../../../shared/dates.ts';
import type { DeleteBatchResult, StatementBatch } from '../../../../shared/types/banking.ts';

export type BatchLike = Pick<StatementBatch, 'id' | 'fileName' | 'ledgerName' | 'from' | 'to' | 'lineCount' | 'counts'>;

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;

/** "HDFC Apr.csv · 01 Apr 2026 – 30 Apr 2026 · 42 lines". */
export function batchLabel(b: BatchLike): string {
  return `${b.fileName ?? 'Statement'} · ${formatDate(b.from)} – ${formatDate(b.to)} · ${plural(b.lineCount, 'line')}`;
}

/** Lines of the statement reconciled with a voucher (matched, or a voucher created from the line). */
export function linkedLines(b: BatchLike): number {
  return (b.counts.matched ?? 0) + (b.counts.created ?? 0);
}

export interface DeleteBatchPlan {
  title: string;
  /** What will happen, for the confirmation. */
  message: string;
  linked: number;
  /** False while reconciled lines exist and "also unmatch" is off (the server would refuse). */
  canDelete: boolean;
  /** Route input. */
  input: { batchId: number; unmatch?: true };
}

export function deleteBatchPlan(b: BatchLike, unmatch: boolean): DeleteBatchPlan {
  const linked = linkedLines(b);
  const parts = [`${plural(b.lineCount, 'statement line')} imported into ${b.ledgerName} will be removed. You can import the corrected statement again afterwards.`];
  if (linked > 0) {
    parts.push(
      unmatch
        ? `${plural(linked, 'line is', 'lines are')} reconciled with vouchers: they are unmatched first, so those vouchers lose their bank date (vouchers created from lines are kept).`
        : `${plural(linked, 'line is', 'lines are')} reconciled with vouchers. Tick "Also unmatch" to delete the statement anyway, or unmatch them first.`,
    );
  }
  return {
    title: `Delete the imported statement “${b.fileName ?? 'Statement'}”?`,
    message: parts.join(' '),
    linked,
    canDelete: linked === 0 || unmatch,
    input: linked > 0 && unmatch ? { batchId: b.id, unmatch: true } : { batchId: b.id },
  };
}

/** Toast after the delete. */
export function deleteBatchResultText(r: DeleteBatchResult): string {
  const base = `Imported statement deleted — ${plural(r.deletedLines, 'line')} removed`;
  return r.unmatched > 0 ? `${base}, ${plural(r.unmatched, 'voucher')} unmatched` : base;
}
