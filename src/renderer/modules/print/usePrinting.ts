/**
 * Hooks shared by the print screens: QR images per document, and Print / Save as PDF of the rendered
 * `.bp-docs` element (serialised as-is, so what is printed is exactly what the preview shows).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { PrintPageSize, PrintVoucherData } from '../../../shared/types/print.ts';
import { native, showInFolder, userMessage } from '../../app/index.ts';
import { useToast } from '../../ui/index.ts';
import { buildPrintHtml } from './lib/document.ts';
import { documentTitle, nativePageSize, pdfFileName } from './lib/layout.ts';
import { documentQrs, NO_QRS, type DocumentQrs } from './lib/qr.ts';

/** QR images keyed by document id; `ready` once every document's images are generated. */
export function useDocumentQrs(docs: readonly PrintVoucherData[] | undefined): { qrs: ReadonlyMap<number, DocumentQrs>; ready: boolean } {
  const [state, setState] = useState<{ key: string; qrs: Map<number, DocumentQrs> }>({ key: '', qrs: new Map() });
  const key = docs ? docs.map((d) => `${d.id}:${d.upi?.uri ?? ''}:${d.einvoice?.signedQr?.length ?? 0}:${d.status.cancelled ? 1 : 0}`).join('|') : '';
  const docsRef = useRef(docs);
  docsRef.current = docs;
  useEffect(() => {
    const list = docsRef.current;
    if (!list) return;
    let cancelled = false;
    void Promise.all(list.map(async (d) => [d.id, await documentQrs(d)] as const)).then((pairs) => {
      if (!cancelled) setState({ key, qrs: new Map(pairs) });
    });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return { qrs: state.qrs, ready: docs !== undefined && state.key === key };
}

export function qrsOf(map: ReadonlyMap<number, DocumentQrs>, id: number): DocumentQrs {
  return map.get(id) ?? NO_QRS;
}

export type PrintBusy = 'print' | 'pdf' | null;

export interface PrintActions {
  busy: PrintBusy;
  print: () => Promise<boolean>;
  savePdf: () => Promise<boolean>;
}

/**
 * Print / Save as PDF the element in `rootRef`. `docs` gives the title and file name; `documents` is
 * the number of printed documents (copies × vouchers) for page numbering.
 */
export function usePrintActions(
  rootRef: RefObject<HTMLDivElement | null>,
  opts: { docs: readonly PrintVoucherData[]; pageSize: PrintPageSize; documents: number; ready: boolean },
): PrintActions {
  const toast = useToast();
  const [busy, setBusy] = useState<PrintBusy>(null);
  const busyRef = useRef<PrintBusy>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const html = useCallback((): string | null => {
    const el = rootRef.current;
    const o = optsRef.current;
    if (!el || o.docs.length === 0) return null;
    return buildPrintHtml({ title: documentTitle(o.docs), body: el.outerHTML, pageSize: o.pageSize, documents: o.documents });
  }, [rootRef]);

  const run = useCallback(
    async (kind: 'print' | 'pdf'): Promise<boolean> => {
      if (busyRef.current) return false;
      const o = optsRef.current;
      if (!o.ready) {
        toast.info('Still preparing the document', { message: 'Try again in a moment.' });
        return false;
      }
      busyRef.current = kind;
      setBusy(kind);
      try {
        const doc = html();
        if (!doc) return false;
        if (kind === 'print') {
          const res = await native('print.print', { html: doc });
          if (res.printed) toast.success(o.docs.length > 1 ? `${o.docs.length} documents sent to the printer` : 'Sent to the printer');
          return res.printed;
        }
        const name = o.docs.length === 1 ? pdfFileName(o.docs[0]) : `${documentTitle(o.docs)}.pdf`;
        const saved = await native('print.savePdf', { html: doc, defaultName: name, pageSize: nativePageSize(o.pageSize) });
        if (!saved) return false;
        toast.success('PDF saved', { message: saved.path, action: { label: 'Show in folder', onClick: () => showInFolder(saved.path) } });
        return true;
      } catch (err) {
        toast.error(kind === 'print' ? 'Could not print' : 'Could not save the PDF', { message: userMessage(err) });
        return false;
      } finally {
        busyRef.current = null;
        setBusy(null);
      }
    },
    [html, toast],
  );

  return { busy, print: useCallback(() => run('print'), [run]), savePdf: useCallback(() => run('pdf'), [run]) };
}
