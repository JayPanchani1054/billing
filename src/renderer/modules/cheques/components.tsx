/**
 * Cheque sheets: one page per cheque (or the calibration sheet), every mark absolutely positioned in
 * millimetres (lib/cheque.ts). The same element is the on-screen preview and, serialised, the printed
 * document (WYSIWYG). Plus the print job helper shared by the print and layout screens.
 */
import { useCallback, useRef, useState } from 'react';
import type { CSSProperties, Ref } from 'react';
import type { ChequeLayoutSpec } from '../../../shared/types/cheques.ts';
import { native, useFeatures, userMessage } from '../../app/index.ts';
import { ScrollArea, useToast } from '../../ui/index.ts';
import { buildChequeHtml, chequeCss, chequePage, type ChequeMark } from './lib/cheque.ts';

function MarkView({ m }: { m: ChequeMark }) {
  const style: CSSProperties = { left: `${m.x}mm`, top: `${m.y}mm`, fontSize: `${m.fontPt}pt` };
  if (m.w !== undefined && m.kind !== 'crossing') style.width = `${m.w}mm`;
  if (m.kind === 'rule') {
    if (m.w === 0) style.height = `${m.h ?? 0}mm`;
    else style.width = `${m.w ?? 0}mm`;
    return (
      <div className="cq-m cq-rule" style={style}>
        {m.text}
      </div>
    );
  }
  if (m.kind === 'box') {
    style.height = `${m.h ?? 4}mm`;
    return (
      <div className="cq-m cq-box" style={style}>
        {m.text}
      </div>
    );
  }
  if (m.kind === 'crossing') {
    style.width = `${m.w ?? 30}mm`;
    return (
      <div className="cq-m cq-cross cq-b" style={style}>
        {m.text}
      </div>
    );
  }
  const cls = ['cq-m', m.bold ? 'cq-b' : '', m.align === 'center' ? 'cq-c' : ''].filter(Boolean).join(' ');
  return (
    <div className={cls} style={style}>
      {m.text}
    </div>
  );
}

/** Pages to print: each a list of marks. The `.cq-docs` root is what gets printed. */
export function ChequeSheets({ pages, spec, rootRef, label }: { pages: ReadonlyArray<{ key: string; marks: readonly ChequeMark[] }>; spec: ChequeLayoutSpec; rootRef: Ref<HTMLDivElement>; label: string }) {
  const page = chequePage(spec);
  return (
    <ScrollArea className="cq-preview" aria-label={label} shadows>
      <style>{chequeCss(spec, false) + PREVIEW_CSS}</style>
      <div ref={rootRef} className="cq-docs">
        {pages.map((p) => (
          <div key={p.key} className="cq-page" style={{ width: `${page.widthMm}mm`, height: `${page.heightMm}mm` }}>
            {p.marks.map((m) => (
              <MarkView key={m.key} m={m} />
            ))}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

/** Preview only (never printed): pages as paper with a shadow, the leaf outline dashed. */
const PREVIEW_CSS = `
.cq-preview { padding: var(--space-4); }
.cq-preview .cq-page { margin: 0 auto var(--space-5); box-shadow: var(--shadow-2); }
`;

/** Print the `.cq-docs` element with the layout's page; returns true when sent to the printer. */
export function useChequePrintJob(rootRef: { current: HTMLDivElement | null }): {
  busy: boolean;
  run: (opts: { spec: ChequeLayoutSpec; title: string; before?: () => Promise<void> }) => Promise<boolean>;
} {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const run = useCallback(
    async (opts: { spec: ChequeLayoutSpec; title: string; before?: () => Promise<void> }): Promise<boolean> => {
      const el = rootRef.current;
      if (!el || busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      try {
        const html = buildChequeHtml({ title: opts.title, body: el.outerHTML, spec: opts.spec });
        await opts.before?.();
        const page = chequePage(opts.spec);
        const res = await native('print.print', { html, ...page.native });
        return res.printed;
      } catch (err) {
        toast.error('Could not print', { message: userMessage(err) });
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [rootRef, toast],
  );
  return { busy, run };
}

/** F11 › Cheque printing is on. */
export function useChequesOn(): boolean {
  return useFeatures().chequePrinting;
}
