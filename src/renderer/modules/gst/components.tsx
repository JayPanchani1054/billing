/**
 * Shared pieces of the GST screens: return-period selector, one-line help, uncertain-transaction
 * panel with fix links, saving generated JSON files and the "file saved" result dialog.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import type { GstIssue, GstJsonFile, GstPeriodsResult } from '../../../shared/types/gst-returns.ts';
import { formatDateTime, native, showInFolder, useApiQuery, useNav, usePeriod, userMessage } from '../../app/index.ts';
import { Badge, Banner, Button, Drawer, EmptyState, Icon, Inline, Modal, Panel, ScrollArea, Select, Stack } from '../../ui/index.ts';
import type { SelectOptionGroup } from '../../ui/index.ts';
import { periodOptionGroups, initialPeriodKey, findPeriod } from './lib/periods.ts';
import { countIssues, fixLinks, issueKey, issueSummaryText, ISSUE_CODE_LABELS } from './lib/issues.ts';
import { docEventDetail, docEventLabel } from './lib/compliance.ts';

// ───────────────────────────── Help line ─────────────────────────────

/** One plain-language sentence under the report header saying what the screen is for. */
export function GstHelp({ children }: { children: ReactNode }) {
  return (
    <p className="bx-gst-help">
      <Icon name="info" size="sm" />
      <span>{children}</span>
    </p>
  );
}

// ───────────────────────────── Return period ─────────────────────────────

export interface ReturnPeriodState {
  periods: GstPeriodsResult | undefined;
  key: string | null;
  setKey: (key: string) => void;
  label: string;
  loading: boolean;
  error: unknown;
  refetch: () => void;
}

/** Loads 'gst.periods' and keeps the chosen return period (requested → suggested → current). */
export function useReturnPeriod(requested?: string | null): ReturnPeriodState {
  const q = useApiQuery('gst.periods', {}, { staleTime: 60_000 });
  const [key, setKey] = useState<string | null>(null);
  useEffect(() => {
    if (key === null && q.data) setKey(initialPeriodKey(q.data, requested));
  }, [key, q.data, requested]);
  const period = findPeriod(q.data, key);
  return {
    periods: q.data,
    key,
    setKey,
    label: period?.label ?? '',
    loading: q.loading,
    error: q.error,
    refetch: () => void q.refetch(),
  };
}

export interface PeriodSelectProps {
  periods: GstPeriodsResult | undefined;
  value: string | null;
  /** Called with the chosen key; the caller may refuse (e.g. unsaved entries) by not updating `value`. */
  onChange: (key: string) => void;
  selectRef?: RefObject<HTMLSelectElement | null>;
  label?: string;
}

/** Return-period dropdown grouped by GST financial year (Alt+F2 focuses it). */
export function PeriodSelect({ periods, value, onChange, selectRef, label = 'Return period' }: PeriodSelectProps) {
  const groups = useMemo<SelectOptionGroup[]>(() => (periods ? periodOptionGroups(periods) : []), [periods]);
  return (
    <label className="bx-gst-period">
      <span className="bx-gst-period__label">{label}</span>
      <Select
        ref={selectRef}
        size="sm"
        aria-label={label}
        aria-keyshortcuts="Alt+F2"
        options={groups}
        value={value ?? ''}
        placeholder={periods ? 'Choose a period' : 'Loading periods…'}
        disabled={!periods || groups.length === 0}
        onChange={(v) => onChange(v)}
      />
    </label>
  );
}

// ───────────────────────────── Issues ─────────────────────────────

export function SeverityBadge({ severity }: { severity: GstIssue['severity'] }) {
  return severity === 'error' ? (
    <Badge tone="danger" icon="x-circle" size="sm">
      Error
    </Badge>
  ) : (
    <Badge tone="warning" icon="alert" size="sm">
      Warning
    </Badge>
  );
}

/** Issue text + fix + buttons that open the master / voucher to correct. */
export function IssueItem({ issue }: { issue: GstIssue }) {
  const nav = useNav();
  const links = fixLinks(issue);
  return (
    <li className="bx-gst-issue">
      <div className="bx-gst-issue__head">
        <SeverityBadge severity={issue.severity} />
        <span className="bx-gst-issue__code">{ISSUE_CODE_LABELS[issue.code] ?? issue.code}</span>
      </div>
      <p className="bx-gst-issue__message">{issue.message}</p>
      <p className="bx-gst-issue__fix">
        <span className="bx-sr-only">How to fix: </span>
        {issue.fix}
      </p>
      {links.length > 0 ? (
        <Inline gap={1} className="bx-gst-issue__links">
          {links.map((l) => (
            <Button key={l.label} size="sm" variant="ghost" icon="external" title={l.hint} aria-label={`${l.label}: ${l.hint}`} onClick={() => nav.push(l.screen, l.params)}>
              {l.label}
            </Button>
          ))}
        </Inline>
      ) : null}
    </li>
  );
}

export interface IssuesPanelProps {
  issues: readonly GstIssue[];
  title?: string;
  /** Show at most this many; the rest are in GST Exceptions. */
  limit?: number;
  onShowAll?: () => void;
  defaultCollapsed?: boolean;
}

/** "Uncertain transactions": errors first, each with its fix links. */
export function IssuesPanel({ issues, title = 'Uncertain transactions', limit = 50, onShowAll, defaultCollapsed }: IssuesPanelProps) {
  const counts = countIssues(issues);
  const shown = issues.slice(0, limit);
  return (
    <Panel
      title={
        <Inline gap={2} wrap={false}>
          <span>{title}</span>
          {counts.errors > 0 ? (
            <Badge tone="danger" size="sm">
              {counts.errors} {counts.errors === 1 ? 'error' : 'errors'}
            </Badge>
          ) : null}
          {counts.warnings > 0 ? (
            <Badge tone="warning" size="sm">
              {counts.warnings} {counts.warnings === 1 ? 'warning' : 'warnings'}
            </Badge>
          ) : null}
        </Inline>
      }
      description={
        issues.length === 0
          ? 'No problems found in this period.'
          : 'Fix these before you file: errors would be rejected by the portal or make the return wrong; warnings are worth a look.'
      }
      collapsible
      defaultCollapsed={defaultCollapsed ?? issues.length === 0}
      actions={
        onShowAll && issues.length > 0 ? (
          <Button size="sm" variant="ghost" iconRight="chevron-right" onClick={onShowAll}>
            Open GST exceptions
          </Button>
        ) : undefined
      }
    >
      {issues.length === 0 ? (
        <EmptyState size="sm" icon="check-circle" title="Nothing to fix" body={issueSummaryText(counts)} />
      ) : (
        <Stack gap={2}>
          <ul className="bx-gst-issues" aria-label={title}>
            {shown.map((i, idx) => (
              <IssueItem key={issueKey(i, idx)} issue={i} />
            ))}
          </ul>
          {issues.length > shown.length ? (
            <p className="bx-muted">
              Showing {shown.length} of {issues.length}. {onShowAll ? 'Open GST exceptions to see all of them.' : ''}
            </p>
          ) : null}
        </Stack>
      )}
    </Panel>
  );
}

// ───────────────────────────── Generated files ─────────────────────────────

const JSON_FILTERS = [{ name: 'JSON file', extensions: ['json'] }];

/** Save a generated return / bulk file where the user chooses. Resolves the path, or null when cancelled. */
export async function saveJsonFile(file: Pick<GstJsonFile, 'fileName' | 'json'>, title: string): Promise<string | null> {
  const saved = await native('dialog.saveFile', { title, defaultName: file.fileName, filters: JSON_FILTERS, data: file.json });
  return saved ? saved.path : null;
}

export interface FileResult {
  title: string;
  path: string;
  summary: string;
  warnings: readonly string[];
  rejected?: ReadonlyArray<{ voucherId: number; number: string | null; errors: readonly string[] }>;
  /** What to do next (upload on the portal …). */
  nextStep?: string;
}

/** After saving a file: where it is, the next step, warnings and documents left out. */
export function FileResultDialog({ result, onClose }: { result: FileResult | null; onClose: () => void }) {
  const nav = useNav();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  if (!result) return null;
  const name = result.path.split(/[\\/]/).pop() ?? result.path;
  return (
    <Modal
      open
      onClose={onClose}
      title={result.title}
      description={result.summary}
      size="lg"
      initialFocusRef={closeRef}
      footer={
        <>
          <Button icon="folder" onClick={() => showInFolder(result.path)}>
            Show in folder
          </Button>
          <Button ref={closeRef} variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <Stack gap={3}>
        <Banner tone="success" title={`Saved ${name}`}>
          {result.nextStep ?? 'Upload this file on the portal.'}
        </Banner>
        {result.warnings.length > 0 ? (
          <Banner tone="warning" title="Check before uploading">
            <ul className="bx-gst-list">
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </Banner>
        ) : null}
        {result.rejected && result.rejected.length > 0 ? (
          <Banner tone="danger" title={`${result.rejected.length} document${result.rejected.length === 1 ? ' was' : 's were'} left out — fix and export again`}>
            <ul className="bx-gst-list">
              {result.rejected.map((r) => (
                <li key={r.voucherId}>
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => {
                      onClose();
                      nav.push('vouchers.entry', { id: r.voucherId });
                    }}
                  >
                    {r.number ?? `Voucher ${r.voucherId}`}
                  </Button>
                  : {r.errors.join(' ')}
                </li>
              ))}
            </ul>
          </Banner>
        ) : null}
      </Stack>
    </Modal>
  );
}

/** "No file was created": every selected voucher has errors — each links to Alter voucher. */
export function RejectedDocsDialog({ result, onClose }: { result: FileResult; onClose: () => void }) {
  const nav = useNav();
  return (
    <Modal
      open
      onClose={onClose}
      title={result.title}
      description={result.summary}
      size="lg"
      footer={
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <ul className="bx-gst-list">
        {(result.rejected ?? []).map((r) => (
          <li key={r.voucherId}>
            <Button
              variant="link"
              size="sm"
              onClick={() => {
                onClose();
                nav.push('vouchers.entry', { id: r.voucherId });
              }}
            >
              {r.number ?? `Voucher ${r.voucherId}`}
            </Button>
            : {r.errors.join(' ')}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/** A wide portal-style table that scrolls sideways (keyboard-scrollable region) on narrow windows. */
export function WideTable({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ScrollArea horizontal maxHeight="none" shadows={false} aria-label={label} className="bx-gst-wide">
      {children}
    </ScrollArea>
  );
}

/** Muted inline text. */
export function Muted({ children }: { children: ReactNode }) {
  return <span className="bx-muted">{children}</span>;
}

// ───────────────────────────── Date range ─────────────────────────────

/**
 * Reporting range for the register-style screens: the global period (Alt+F2), or the range a caller
 * passed (e.g. GSTR-1 → exceptions for its return period) until the user changes the global period.
 */
export function useGstRange(params: { from?: string; to?: string } | undefined): { from: string; to: string; override: { from: string; to: string } | undefined } {
  const g = usePeriod();
  const initial = params?.from && params.to && params.from <= params.to ? { from: params.from, to: params.to } : null;
  const [override, setOverride] = useState(initial);
  const seen = useRef(`${g.from}|${g.to}`);
  useEffect(() => {
    const now = `${g.from}|${g.to}`;
    if (now !== seen.current) {
      seen.current = now;
      setOverride(null);
    }
  }, [g.from, g.to]);
  const r = override ?? { from: g.from, to: g.to };
  return { from: r.from, to: r.to, override: override ?? undefined };
}

// ───────────────────────────── Document trail ─────────────────────────────

/** e-Invoice / e-way bill history of one voucher ('gst.docEvents'). */
export function DocEventsDrawer({ voucherId, title, onClose }: { voucherId: number | null; title: string; onClose: () => void }) {
  const q = useApiQuery('gst.docEvents', { voucherId: voucherId ?? 0 }, { enabled: voucherId !== null });
  if (voucherId === null) return null;
  const events = q.data ?? [];
  return (
    <Drawer open onClose={onClose} title="e-Invoice and e-way bill history" description={title} size="md">
      {q.loading ? (
        <p className="bx-muted">Loading…</p>
      ) : q.error ? (
        <Banner tone="danger" title="Could not load the history">
          {userMessage(q.error)}
        </Banner>
      ) : events.length === 0 ? (
        <EmptyState size="sm" icon="clock" title="Nothing recorded yet" body="Exports, IRNs, e-way bills and cancellations of this voucher will be listed here." />
      ) : (
        <ol className="bx-gst-issues" aria-label="History">
          {[...events].reverse().map((e) => (
            <li key={e.id} className="bx-gst-issue">
              <div className="bx-gst-issue__head">
                <Badge size="sm" tone={e.action === 'cancelled' ? 'danger' : e.action === 'generated' || e.action === 'updated' ? 'success' : 'neutral'}>
                  {docEventLabel(e)}
                </Badge>
                <span className="bx-muted">
                  {formatDateTime(e.at)}
                  {e.by ? ` · ${e.by}` : ''}
                </span>
              </div>
              {e.refNo ? <p className="bx-gst-issue__message bx-mono">{e.refNo}</p> : null}
              {e.detail ? <p className="bx-gst-issue__fix">{docEventDetail(e)}</p> : null}
            </li>
          ))}
        </ol>
      )}
    </Drawer>
  );
}
