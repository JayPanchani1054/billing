/**
 * Prints a POS receipt without leaving the counter: the bill is rendered off screen with the print
 * module's own template (Compact on the configured 80 / 58 mm roll, MRP and "You saved", the POS
 * "Paid by" block) and sent to the receipt printer chosen for rolls on this computer (Print preview ›
 * Printer) — silently when one is chosen, else through the OS print dialog. One copy (the buyer's).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useApiQuery } from '../../app/index.ts';
import { useToast } from '../../ui/index.ts';
import { PreviewPane } from '../print/components.tsx';
import { pageSizeFor, resolveCopies, resolveTemplate } from '../print/lib/layout.ts';
import { qrsOf, useDocumentQrs, usePrintActions, usePrinterChoice } from '../print/usePrinting.ts';

/** One print job: renders off screen, prints once when ready, then calls onDone. */
function ReceiptJob({ id, onDone }: { id: number; onDone: () => void }) {
  const toast = useToast();
  const q = useApiQuery('print.voucherData', { id }, { staleTime: 0 });
  const doc = q.data;
  const template = doc ? resolveTemplate(doc) : 'compact';
  const pageSize = pageSizeFor(template, undefined, doc?.options);
  const printer = usePrinterChoice('roll');
  const docs = useMemo(() => (doc ? [doc] : undefined), [doc]);
  const copies = useMemo(() => (doc ? resolveCopies(doc, 1) : []), [doc]);
  const { qrs, ready } = useDocumentQrs(docs);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const actions = usePrintActions(rootRef, { docs: docs ?? [], pageSize, documents: copies.length, ready, deviceName: printer.printer || undefined });
  const started = useRef(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    if (!q.error || started.current) return;
    started.current = true;
    toast.error('Could not prepare the receipt', { message: 'Open the bill and print it from there (Alt+P).' });
    doneRef.current();
  }, [q.error, toast]);
  useEffect(() => {
    if (started.current || !doc || !ready) return;
    started.current = true;
    // Let the off-screen document lay out (its roll length is measured) before printing.
    requestAnimationFrame(() => void actions.print().finally(() => doneRef.current()));
  }, [doc, ready, actions]);
  if (!doc) return null;
  return (
    <div className="pos-offscreen" aria-hidden="true">
      <PreviewPane items={[{ doc, copies, qrs: qrsOf(qrs, doc.id) }]} template={template} pageSize={pageSize} rootRef={rootRef} label="Receipt" />
    </div>
  );
}

/** `print(id)` queues a receipt; render `element` somewhere in the screen. */
export function useReceiptPrinter(): { print: (id: number) => void; busy: boolean; element: ReactNode } {
  const [queue, setQueue] = useState<number[]>([]);
  const done = useCallback(() => setQueue((q) => q.slice(1)), []);
  const print = useCallback((id: number) => setQueue((q) => (q.includes(id) ? q : [...q, id])), []);
  const current = queue[0];
  const element = current !== undefined ? <ReceiptJob key={current} id={current} onDone={done} /> : null;
  return { print, busy: current !== undefined, element };
}
