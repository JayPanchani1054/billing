/**
 * Side-by-side comparison of one reconciliation row: portal vs books with the differences
 * highlighted (marker + tint, never colour alone), notes, probable matches to link, and the
 * actions accept (Ctrl+A) / ignore (Alt+I) / undo or unlink (Alt+U) / open voucher (Alt+V) /
 * supplier follow-up (Alt+M) with remarks.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReconRow, ReconSource, ReconSuggestion } from '../../../shared/types/gstrecon.ts';
import { formatDate, formatMoney, useApiMutation, useApiQuery, useCan, useNav, userMessage } from '../../app/index.ts';
import { Badge, Banner, Button, Drawer, Field, Inline, Spinner, Stack, TextArea, useHotkeys, useToast, VisuallyHidden } from '../../ui/index.ts';
import { compareLines, decisionTarget, partyWord, rowActions, rowExplanation, statusLabel, STATUS_TONES } from './lib/recon.ts';

export interface CompareDrawerProps {
  row: ReconRow | null;
  period: string;
  source: ReconSource;
  onClose: () => void;
  /** The row after a link/unlink (null: it no longer exists as such — close). */
  onRowChange: (row: ReconRow | null) => void;
  onFollowUp: (gstin: string) => void;
}

export function CompareDrawer({ row, period, source, onClose, onRowChange, onFollowUp }: CompareDrawerProps) {
  if (!row) return null;
  return <CompareDrawerBody key={row.key} row={row} period={period} source={source} onClose={onClose} onRowChange={onRowChange} onFollowUp={onFollowUp} />;
}

function CompareDrawerBody({ row, period, source, onClose, onRowChange, onFollowUp }: CompareDrawerProps & { row: ReconRow }) {
  const nav = useNav();
  const toast = useToast();
  const canFile = useCan('gst.file');
  const [remarks, setRemarks] = useState(row.remarks ?? '');
  const actions = rowActions(row);
  const link = useApiMutation('gstrecon.link');
  const unlink = useApiMutation('gstrecon.unlink');
  const accept = useApiMutation('gstrecon.accept');
  const ignore = useApiMutation('gstrecon.ignore');
  const busy = link.pending || unlink.pending || accept.pending || ignore.pending;
  const suggestionsInput = row.kind === 'portal' && row.portalDocId !== null ? { portalDocId: row.portalDocId } : { voucherId: row.voucherId ?? 0, period, source };
  const sugg = useApiQuery('gstrecon.suggestions', suggestionsInput, { enabled: actions.canLink && (row.portalDocId !== null || row.voucherId !== null) });
  const lines = compareLines(row);
  const party = partyWord(source);
  const docNo = row.portal?.docNo ?? row.books?.docNo ?? '';
  const firstRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => setRemarks(row.remarks ?? ''), [row.remarks]);

  const fail = (what: string, err: unknown): void => {
    toast.error(what, { message: userMessage(err) });
  };

  const doLink = async (s: ReconSuggestion): Promise<void> => {
    if (!canFile || busy) return;
    const portalDocId = row.portalDocId ?? s.portalDocId;
    const voucherId = row.kind === 'portal' ? s.voucherId : row.voucherId;
    if (portalDocId === null || voucherId === null) return;
    try {
      const out = await link.mutate({ portalDocId, voucherId });
      toast.success(`Linked ${out?.portal?.docNo ?? docNo} with ${out?.books ? `${out.books.voucherType} ${out.books.voucherNumber ?? ''}`.trim() : 'the voucher'}`);
      onRowChange(out);
    } catch (err) {
      fail('Could not link', err);
    }
  };

  const doUnlink = async (): Promise<void> => {
    if (!canFile || busy) return;
    try {
      const out = await unlink.mutate(row.kind === 'portal' && row.portalDocId !== null ? { portalDocId: row.portalDocId } : { voucherId: row.voucherId ?? 0, period, source });
      toast.success(row.manual ? `Link removed — ${docNo} is matched automatically again` : `${docNo} is open again`);
      onRowChange(out);
    } catch (err) {
      fail(row.manual ? 'Could not remove the link' : 'Could not undo', err);
    }
  };

  const decide = async (kind: 'accept' | 'ignore'): Promise<void> => {
    if (!canFile || busy) return;
    if (kind === 'accept' ? !actions.canAccept : !actions.canIgnore) return;
    const input = { ...decisionTarget(row, period, source), remarks: remarks.trim() || undefined };
    try {
      await (kind === 'accept' ? accept : ignore).mutate(input);
      toast.success(kind === 'accept' ? `Differences accepted — ${docNo}` : `Ignored — ${docNo}`);
      onRowChange(null);
    } catch (err) {
      fail(kind === 'accept' ? 'Could not accept' : 'Could not ignore', err);
    }
  };

  const openVoucher = (): void => {
    if (row.voucherId !== null) nav.push('vouchers.view', { id: row.voucherId });
  };

  const title = `${row.portal ? (row.portal.docType === 'invoice' ? 'Invoice' : row.portal.docType === 'credit_note' ? 'Credit note' : 'Debit note') : 'Voucher'} ${docNo}`;
  const undoLabel = row.manual ? 'Remove link' : 'Undo decision';

  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={title}
      description={`${row.name ?? ''}${row.name ? ' · ' : ''}${party} GSTIN ${row.gstin || '—'}`}
      initialFocusRef={actions.canAccept ? firstRef : undefined}
      footer={
        <Inline gap={2} justify="end" wrap>
          {row.voucherId !== null ? (
            <Button icon="eye" shortcut="Alt+V" onClick={openVoucher}>
              Open voucher
            </Button>
          ) : null}
          {source !== 'gstr1' && row.gstin ? (
            <Button icon="mail" shortcut="Alt+M" onClick={() => onFollowUp(row.gstin)}>
              {party} e-mail
            </Button>
          ) : null}
          {actions.canUndo || actions.canUnlink ? (
            <Button icon="undo" shortcut="Alt+U" onClick={() => void doUnlink()} disabled={!canFile} loading={unlink.pending}>
              {undoLabel}
            </Button>
          ) : null}
          {actions.canIgnore ? (
            <Button icon="eye-off" shortcut="Alt+I" onClick={() => void decide('ignore')} disabled={!canFile} loading={ignore.pending}>
              Ignore
            </Button>
          ) : null}
          {actions.canAccept ? (
            <Button ref={firstRef} variant="primary" icon="check" shortcut="Ctrl+A" onClick={() => void decide('accept')} disabled={!canFile} loading={accept.pending}>
              Accept differences
            </Button>
          ) : null}
        </Inline>
      }
    >
      <DrawerKeys
        onAccept={actions.canAccept ? () => void decide('accept') : undefined}
        onIgnore={actions.canIgnore ? () => void decide('ignore') : undefined}
        onUndo={actions.canUndo || actions.canUnlink ? () => void doUnlink() : undefined}
        onVoucher={row.voucherId !== null ? openVoucher : undefined}
        onFollowUp={source !== 'gstr1' && row.gstin ? () => onFollowUp(row.gstin) : undefined}
      />
      <Stack gap={4}>
        <Stack gap={2}>
          <Inline gap={2} align="center">
            <Badge tone={STATUS_TONES[row.status]} dot>
              {statusLabel(row.status, source)}
            </Badge>
            {row.status !== row.baseStatus && row.baseStatus !== 'pending' ? <span className="bx-gr-meta">Found as: {statusLabel(row.baseStatus, source)}</span> : null}
            {row.manual ? <Badge tone="brand">Linked manually</Badge> : null}
          </Inline>
          <p className="bx-gr-help">{rowExplanation(row, source)}</p>
          {!canFile ? <Banner tone="info">You can view this reconciliation. Linking, accepting and ignoring need the “Prepare GST filings” permission.</Banner> : null}
        </Stack>

        <table className="bx-gr-compare" aria-label="Portal and books side by side">
          <thead>
            <tr>
              <th scope="col">Detail</th>
              <th scope="col">{source === 'gstr1' ? 'GSTR-1' : 'Portal'}</th>
              <th scope="col">Books</th>
              <th scope="col" className="is-num">
                Difference
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const numeric = ['taxable', 'igst', 'cgst', 'sgst', 'cess', 'tax', 'invoice_value'].includes(l.key);
              return (
                <tr key={l.key} className={l.mismatch ? 'is-mismatch' : l.info ? 'is-info' : undefined}>
                  <th scope="row">
                    <span className="bx-gr-mark" aria-hidden="true">
                      {l.mismatch ? '≠' : l.info ? '~' : ''}
                    </span>
                    {l.label}
                    {l.mismatch ? <VisuallyHidden> (differs)</VisuallyHidden> : l.info ? <VisuallyHidden> (small difference, within tolerance)</VisuallyHidden> : null}
                  </th>
                  <td className={numeric ? 'is-num' : undefined}>{l.portal || '—'}</td>
                  <td className={numeric ? 'is-num' : undefined}>{l.books || '—'}</td>
                  <td className="is-num">{l.difference}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {row.books ? (
          <p className="bx-gr-meta">
            Voucher: {row.books.voucherType} {row.books.voucherNumber ?? ''} dated {formatDate(row.books.voucherDate)}
            {row.books.docNoBasis === 'voucher_number' && source !== 'gstr1' ? ' · supplier invoice no. not entered' : ''}
          </p>
        ) : null}

        {row.notes.length > 0 ? (
          <ul className="bx-gr-notes" aria-label="Notes">
            {row.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        ) : null}

        {actions.canLink ? (
          <Stack gap={2}>
            <h3 className="bx-gr-bar__label">{row.kind === 'portal' ? 'Probable vouchers' : `Probable documents in the ${source === 'gstr1' ? 'GSTR-1' : 'portal'} file`}</h3>
            {sugg.loading ? (
              <Spinner size="sm" label="Looking for probable matches" />
            ) : sugg.error ? (
              <Banner tone="warning">{userMessage(sugg.error)}</Banner>
            ) : (sugg.data ?? []).length === 0 ? (
              <p className="bx-gr-meta">
                No probable match: nothing with the same {party.toLowerCase()}, amount within the tolerance and a similar number or the same date.
                {row.kind === 'portal' && source !== 'gstr1' ? ' Enter the purchase with this supplier invoice number, then reconcile again.' : ''}
              </p>
            ) : (
              <ul className="bx-gr-suggestions">
                {(sugg.data ?? []).map((s) => (
                  <li key={`${s.voucherId ?? ''}-${s.portalDocId ?? ''}`} className="bx-gr-suggestion">
                    <div className="bx-gr-suggestion__main">
                      <strong>
                        {s.docNo} · {formatDate(s.docDate)}
                        {s.voucherNumber ? ` · voucher ${s.voucherNumber}` : ''}
                      </strong>
                      <span className="bx-num">
                        Taxable ₹ {formatMoney(s.taxable)} · tax ₹ {formatMoney(s.tax)}
                      </span>
                      <span className="bx-gr-suggestion__reasons">{s.reasons.join(' · ')}</span>
                    </div>
                    <Badge tone={s.score >= 80 ? 'success' : s.score >= 60 ? 'info' : 'neutral'}>{s.score}% likely</Badge>
                    <Button
                      size="sm"
                      icon="link"
                      onClick={() => void doLink(s)}
                      disabled={!canFile || busy}
                      aria-label={`Link with ${s.docNo}`}
                    >
                      Link
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Stack>
        ) : null}

        {actions.canAccept || actions.canIgnore ? (
          <Field label="Remarks" optional hint="Saved with Accept or Ignore, shown in the export (e.g. “Supplier rounded tax”).">
            <TextArea value={remarks} onValueChange={setRemarks} rows={2} maxLength={500} disabled={!canFile} />
          </Field>
        ) : row.remarks ? (
          <p className="bx-gr-meta">Remarks: {row.remarks}</p>
        ) : null}
      </Stack>
    </Drawer>
  );
}

function DrawerKeys(props: { onAccept?: () => void; onIgnore?: () => void; onUndo?: () => void; onVoucher?: () => void; onFollowUp?: () => void }) {
  useHotkeys(
    {
      'Ctrl+A': props.onAccept,
      'Alt+I': props.onIgnore,
      'Alt+U': props.onUndo,
      'Alt+V': props.onVoucher,
      'Alt+M': props.onFollowUp,
    },
    [props.onAccept, props.onIgnore, props.onUndo, props.onVoucher, props.onFollowUp],
  );
  return null;
}
