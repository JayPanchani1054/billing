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
import { documentTitle, nativePageSize, pdfFileName, rollHeightMm } from './lib/layout.ts';
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

export type PrintBusy = 'print' | 'pdf' | 'share' | null;

/** The printable document as main needs it: HTML + paper (rolls with their measured length). */
export interface RenderedDocument {
  html: string;
  pageSize: ReturnType<typeof nativePageSize>['pageSize'];
  landscape: boolean;
  rollHeightMm?: number;
  /** Suggested PDF file name. */
  fileName: string;
}

export interface PrintActions {
  busy: PrintBusy;
  print: () => Promise<boolean>;
  savePdf: () => Promise<boolean>;
  /** The document ready to hand to 'share.*' (null while preparing or when there is nothing). */
  render: () => RenderedDocument | null;
}

/** Heights (CSS px) of each printed document in the rendered root — a roll page is as long as the tallest. */
function docHeights(root: HTMLElement): number[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.bp-doc')).map((d) => d.offsetHeight);
}

/**
 * Print / Save as PDF the element in `rootRef`. `docs` gives the title and file name; `documents` is
 * the number of printed documents (copies × vouchers) for page numbering.
 */
export function usePrintActions(
  rootRef: RefObject<HTMLDivElement | null>,
  opts: {
    docs: readonly PrintVoucherData[];
    pageSize: PrintPageSize;
    documents: number;
    ready: boolean;
    /** Print straight to this printer without the dialog (usePrinterChoice); undefined: the OS dialog. */
    deviceName?: string;
    /** (2.0) false when the print layout hides page numbers (layoutParts.ts pageNumbersShown). */
    pageNumbers?: boolean;
  },
): PrintActions {
  const toast = useToast();
  const [busy, setBusy] = useState<PrintBusy>(null);
  const busyRef = useRef<PrintBusy>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const render = useCallback((): RenderedDocument | null => {
    const el = rootRef.current;
    const o = optsRef.current;
    if (!el || o.docs.length === 0 || !o.ready) return null;
    const roll = rollHeightMm(o.pageSize, docHeights(el));
    const html = buildPrintHtml({
      title: documentTitle(o.docs),
      body: el.outerHTML,
      pageSize: o.pageSize,
      documents: o.documents,
      rollHeightMm: roll,
      ...(o.pageNumbers === false ? { pageNumbers: false } : {}),
    });
    const page = nativePageSize(o.pageSize);
    const fileName = o.docs.length === 1 ? pdfFileName(o.docs[0]) : `${documentTitle(o.docs)}.pdf`;
    return { html, pageSize: page.pageSize, landscape: page.landscape, ...(roll !== null ? { rollHeightMm: roll } : {}), fileName };
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
        const doc = render();
        if (!doc) return false;
        const paper = { pageSize: doc.pageSize, landscape: doc.landscape, ...(doc.rollHeightMm !== undefined ? { rollHeightMm: doc.rollHeightMm } : {}) };
        if (kind === 'print') {
          const direct = o.deviceName ? { silent: true, deviceName: o.deviceName } : {};
          const res = await native('print.print', { html: doc.html, ...paper, ...direct });
          if (res.printed) toast.success(o.docs.length > 1 ? `${o.docs.length} documents sent to the printer` : o.deviceName ? `Sent to ${o.deviceName}` : 'Sent to the printer');
          return res.printed;
        }
        const saved = await native('print.savePdf', { html: doc.html, defaultName: doc.fileName, ...paper });
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
    [render, toast],
  );

  return { busy, print: useCallback(() => run('print'), [run]), savePdf: useCallback(() => run('pdf'), [run]), render };
}

// ───────────────────────────── Direct printing (receipt printers) ─────────────────────────────

const PRINTER_KEY = 'pevqori.print.printer.v1';

function readPrinterPrefs(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(PRINTER_KEY);
    const v: unknown = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * The printer chosen for direct printing, remembered on this computer per paper kind ('roll' / 'sheet'):
 * a counter's receipt printer prints without the dialog. '' = ask every time (OS print dialog).
 */
export function usePrinterChoice(kind: 'roll' | 'sheet'): {
  printer: string;
  setPrinter: (name: string) => void;
  printers: ReadonlyArray<{ name: string; displayName: string }> | null;
  load: () => void;
} {
  const [printer, setPrinterState] = useState<string>(() => readPrinterPrefs()[kind] ?? '');
  const [printers, setPrinters] = useState<ReadonlyArray<{ name: string; displayName: string }> | null>(null);
  useEffect(() => setPrinterState(readPrinterPrefs()[kind] ?? ''), [kind]);
  const setPrinter = useCallback(
    (name: string) => {
      setPrinterState(name);
      try {
        window.localStorage.setItem(PRINTER_KEY, JSON.stringify({ ...readPrinterPrefs(), [kind]: name }));
      } catch {
        /* per-computer convenience only */
      }
    },
    [kind],
  );
  const load = useCallback(() => {
    if (printers !== null) return;
    void native('print.printers', undefined).then(
      (list) => setPrinters(list),
      () => setPrinters([]),
    );
  }, [printers]);
  return { printer, setPrinter, printers, load };
}
