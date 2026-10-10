/**
 * Cheque sheets: one page per cheque (or the calibration sheet), every mark absolutely positioned in
 * millimetres (lib/cheque.ts). The same element is the on-screen preview and, serialised, the printed
 * document (WYSIWYG). Plus the print job helper shared by the print and layout screens.
 */
import { useCallback, useRef, useState } from 'react';
import type { CSSProperties, Ref } from 'react';
import type { ChequeBank, ChequeLayoutSpec } from '../../../shared/types/cheques.ts';
import { native, Screen, useApiQuery, useFeatures, useNav, userMessage } from '../../app/index.ts';
import { Button, EmptyState, ScrollArea, Select, useToast } from '../../ui/index.ts';
import { CHEQUES_OFF } from './lib/model.ts';
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

/** Bank ledgers (Bank Accounts / Bank OD) with their cheque set-up. */
export function useChequeBanks(): { banks: readonly ChequeBank[]; loading: boolean } {
  const q = useApiQuery('cheques.banks', {}, { staleTime: 30_000 });
  return { banks: q.data ?? NO_BANKS, loading: q.loading };
}

const NO_BANKS: readonly ChequeBank[] = [];

export function bankOptionLabel(b: Pick<ChequeBank, 'name' | 'accountNo'>): string {
  return b.accountNo ? `${b.name} (A/c ${b.accountNo})` : b.name;
}

/** Bank chooser of the cheques screens; `allowAll` adds "All banks" (value null). */
export function ChequeBankSelect({
  banks,
  value,
  onChange,
  allowAll = false,
  autoFocus,
  disabled,
}: {
  banks: readonly ChequeBank[];
  value: number | null;
  onChange: (id: number | null) => void;
  allowAll?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const options = [...(allowAll ? [{ value: '', label: 'All banks' }] : []), ...banks.map((b) => ({ value: String(b.ledgerId), label: bankOptionLabel(b) }))];
  return (
    <Select
      aria-label="Bank"
      size="sm"
      value={value === null ? '' : String(value)}
      placeholder={allowAll ? undefined : 'Choose the bank'}
      options={options}
      disabled={disabled}
      data-autofocus={autoFocus ? '' : undefined}
      onChange={(v: string) => onChange(v === '' ? null : Number(v))}
    />
  );
}

/** The feature is off: say how to turn it on (F11). */
export function ChequesOff({ title }: { title: string }) {
  const nav = useNav();
  return (
    <Screen title={title} icon="bank">
      <EmptyState
        icon="bank"
        title="Cheque printing is turned off"
        body={CHEQUES_OFF}
        action={
          <Button variant="primary" onClick={() => nav.push('company.features')}>
            Open Features (F11)
          </Button>
        }
      />
    </Screen>
  );
}

/** No bank ledger yet. */
export function NoChequeBanks() {
  const nav = useNav();
  return (
    <EmptyState
      icon="bank"
      title="No bank accounts yet"
      body="Cheque books belong to a bank ledger (under Bank Accounts or Bank OD A/c). Create the bank ledger first."
      action={
        <Button variant="primary" icon="plus" onClick={() => nav.push('accounts.ledger.form', { groupCode: 'BANK_ACCOUNTS' })}>
          Create bank ledger
        </Button>
      }
    />
  );
}
