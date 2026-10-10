/**
 * 'accounts.numbering' — Invoice Numbering (2.0, docs/ARCHITECTURE.md › Invoice numbering and renumbering): every number series (one per voucher type)
 * on one screen, with a simple editor. A focused facade over the voucher types: the Voucher Type form
 * keeps every option for experts (dated prefix / suffix rows, behaviour, defaults, printing).
 *
 *   List: "Invoices & notes" (sales, credit and debit notes — GST documents) first, then "Other vouchers"
 *   (collapsed). Enter / Alt+A edits the highlighted series · Alt+C creates a series based on it (a new
 *   voucher type with its own numbers, entered with F10) · Alt+H edit history.
 *   Editor (drawer): prefix / suffix with token chips inserted at the caret, digits, starting number,
 *   "start again every financial year", the next number (needs "Change voucher numbers"), a live preview,
 *   the shared GST checks, the numbers missing this financial year. Ctrl+A (or Ctrl+S) saves, Esc closes.
 *
 * Save = 'accounts.voucherType.save { id, numbering }' (only the changed keys), then
 * 'accounts.voucherType.setNextNumber' when the next number was changed (after the save succeeded).
 * Pure logic: lib/numbering.ts (tested).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { VoucherBaseType } from '../../../shared/constants.ts';
import { financialYear, formatDate } from '../../../shared/dates.ts';
import type { VoucherTypeRow } from '../../../shared/types/accounts.ts';
import { useConfirm } from '../../app/confirm.tsx';
import { api } from '../../app/api.ts';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { confirmationOf, fieldErrorsOf, userMessage } from '../../app/lib/apiErrors.ts';
import { useNav } from '../../app/nav.tsx';
import { Screen } from '../../app/Screen.tsx';
import { useCan, useCompany } from '../../app/state.tsx';
import { useBooks, useWorkingDate } from '../../app/working.tsx';
import { Banner, Button, Checkbox, DataTable, Drawer, EmptyState, Field, Inline, NumberInput, RadioGroup, Select, Stack, Switch, TextInput, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { DialogAccept, NameCell, OkHint } from './components.tsx';
import {
  BASE_TYPE_LABELS,
  buildSeriesRows,
  checkNumbering,
  confirmWarningsOf,
  DIGIT_OPTIONS,
  draftFromNumbering,
  draftNumbering,
  formatNumber,
  fyUniquenessNote,
  gapsSummary,
  GST_DOCUMENT_BASE_TYPES,
  gstValidText,
  insertToken,
  isAutomatic,
  lengthNote,
  MAX_NEXT_NUMBER,
  monthFix,
  newSeriesNumbering,
  nextNumberProblem,
  nextNumberToSet,
  numberingPatch,
  previewNextSeq,
  restartForMonthly,
  restartForSwitch,
  seriesClashes,
  seriesGroup,
  seriesClashWarning,
  seriesNameProblem,
  seriesPreview,
  SIMPLE_METHOD_OPTIONS,
  tokenChips,
  yearlySwitchOn,
} from './lib/numbering.ts';
import type { SeriesDraft, SeriesListRow, SeriesStatus } from './lib/numbering.ts';

const RENUMBER_HINT = 'Needs "Change voucher numbers and the next number" (Users & Roles).';

type EditorTarget = { kind: 'alter'; type: VoucherTypeRow } | { kind: 'create'; parent: VoucherTypeRow };

export function NumberingScreen() {
  const nav = useNav();
  const { fyStartMonth } = useBooks();
  const { date: today } = useWorkingDate();
  const canCreate = useCan('masters.create');
  const canAudit = useCan('audit.view');
  const list = useApiQuery('accounts.voucherType.list', {});
  const types = list.data?.rows ?? [];
  // One status call for every series (staleTime 0: vouchers saved elsewhere move the next numbers).
  const status = useApiQuery('accounts.voucherType.numberingStatus', { date: today }, { enabled: list.data !== undefined, staleTime: 0, keepPrevious: true });
  const rows = useMemo(() => buildSeriesRows(types, status.data ?? [], today, fyStartMonth), [types, status.data, today, fyStartMonth]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(['group:gst']));
  const [cursor, setCursor] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  // An alteration opens once the series' status (its next number) is current — a refetch after a voucher
  // saved elsewhere must not leave a stale next number in the editor; later refetches do not reset it.
  const [editorShown, setEditorShown] = useState(false);
  const statusReady = (status.data !== undefined && !status.refreshing) || status.error !== null;
  if (editor && !editorShown && (editor.kind === 'create' || statusReady)) setEditorShown(true);
  const current = rows.find((r): r is Extract<SeriesListRow, { kind: 'series' }> => r.kind === 'series' && r.key === cursor) ?? null;

  const open = (row: SeriesListRow | null) => {
    if (!row) return;
    if (row.kind === 'group') {
      setExpanded((s) => {
        const next = new Set(s);
        if (next.has(row.key)) next.delete(row.key);
        else next.add(row.key);
        return next;
      });
      return;
    }
    setEditor({ kind: 'alter', type: row.type });
  };
  const createFrom = () => {
    const parent = current?.type ?? types.find((t) => t.isPredefined && t.baseType === 'sales') ?? null;
    if (parent) setEditor({ kind: 'create', parent });
  };
  const closeEditor = (savedId?: number) => {
    setEditor(null);
    setEditorShown(false);
    setEditorDirty(false);
    if (savedId !== undefined && editor) {
      // Show the saved (or just created) series: open its group and highlight it once the list reloads.
      const baseType = editor.kind === 'alter' ? editor.type.baseType : editor.parent.baseType;
      setExpanded((s) => new Set([...s, `group:${seriesGroup(baseType)}`]));
      setCursor(String(savedId));
    }
  };

  const columns = useMemo<Column<SeriesListRow>[]>(
    () => [
      {
        key: 'name',
        header: 'Series',
        render: (r) =>
          r.kind === 'group' ? (
            <span>
              {r.label} <span className="bx-acc-name__alias">({r.count})</span>
            </span>
          ) : (
            <NameCell name={r.type.name} alias={r.type.isPredefined ? null : BASE_TYPE_LABELS[r.type.baseType]} inactive={!r.type.isActive} />
          ),
        value: (r) => (r.kind === 'group' ? r.label : r.type.name),
      },
      { key: 'example', header: 'Example (today)', width: 170, render: (r) => (r.kind === 'series' ? <span className="bx-num">{r.example}</span> : null), value: (r) => (r.kind === 'series' ? r.example : '') },
      { key: 'restarts', header: 'Restarts', width: 170, value: (r) => (r.kind === 'series' ? r.restarts : '') },
      { key: 'next', header: 'Next no.', width: 170, render: (r) => (r.kind === 'series' ? <span className="bx-num">{r.next}</span> : null), value: (r) => (r.kind === 'series' ? r.next : '') },
      { key: 'vouchers', header: 'Vouchers this period', kind: 'number', width: 150, blankZero: true, value: (r) => (r.kind === 'series' ? r.vouchers : null) },
    ],
    [],
  );

  return (
    <Screen
      title="Invoice Numbering"
      subtitle={`Prefix, suffix, next number and yearly restart of each number series · numbers as on ${formatDate(today)}`}
      icon="hash"
      dirty={editorDirty}
      loading={list.loading && !list.data}
      error={list.error}
      onRetry={() => void list.refetch()}
      hint="Enter Alter · Alt+C Create series · Alt+H Edit history · Esc Back"
      toolbar={
        <Button variant="ghost" size="sm" icon="sliders" onClick={() => nav.push('accounts.voucherTypes')}>
          Voucher Types
        </Button>
      }
      actions={[
        { key: 'Alt+A', label: 'Alter', icon: 'edit', onClick: () => open(current), disabled: !current, hint: current ? undefined : 'Highlight a series first.' },
        { key: 'Alt+C', label: 'Create series', icon: 'plus', onClick: createFrom, hidden: !canCreate, primary: true, hint: 'A new voucher type based on the highlighted one, with its own numbers (entered with F10).' },
        {
          key: 'Alt+H',
          label: 'Edit history',
          icon: 'clock',
          onClick: () => current && nav.push('security.audit', { entityType: 'voucher_type', entityId: current.type.id, entityGuid: current.type.guid, label: current.type.name }),
          hidden: !canAudit,
          disabled: !current,
          group: 'more',
        },
      ]}
    >
      <Stack gap={3} grow>
        {status.error ? (
          <Banner tone="warning" inline action={<Button size="sm" onClick={() => void status.refetch()}>Retry</Button>}>
            The next numbers could not be read: {userMessage(status.error)}
          </Banner>
        ) : null}
        <DataTable
          aria-label="Number series"
          autoFocus
          columns={columns}
          rows={rows}
          getRowKey={(r) => r.key}
          getRowLevel={(r) => (r.kind === 'group' ? 0 : 1)}
          isGroupRow={(r) => r.kind === 'group'}
          expandable
          expandedKeys={expanded}
          onExpandedChange={(keys) => setExpanded(keys)}
          selectedKey={cursor}
          onSelect={(k) => setCursor(k)}
          onRowActivate={(r) => open(r)}
          loading={list.loading}
          empty={<EmptyState icon="hash" title="No number series" body="Voucher types carry the number series. Open Voucher Types to check them." />}
        />
      </Stack>
      {editor && editorShown ? (
        <SeriesDrawer
          key={editor.kind === 'alter' ? `alter:${editor.type.id}` : `create:${editor.parent.id}`}
          target={editor}
          types={types}
          status={editor.kind === 'alter' ? ((status.data ?? []).find((s) => s.id === editor.type.id) ?? null) : null}
          today={today}
          fyStartMonth={fyStartMonth}
          onDirtyChange={setEditorDirty}
          onClose={closeEditor}
          onOpenForm={(id) => {
            closeEditor();
            nav.push('accounts.voucherType.form', { id });
          }}
        />
      ) : null}
    </Screen>
  );
}

// ───────────────────────────── Editor ─────────────────────────────

/** "invoice numbers" (sales), "note numbers" (credit / debit notes), "voucher numbers" (others). */
function numbersWord(baseType: VoucherBaseType): string {
  if (baseType === 'sales') return 'invoice numbers';
  if (baseType === 'credit_note' || baseType === 'debit_note') return 'note numbers';
  return 'voucher numbers';
}

type TextField = 'prefix' | 'suffix';

function SeriesDrawer({
  target,
  types,
  status,
  today,
  fyStartMonth,
  onDirtyChange,
  onClose,
  onOpenForm,
}: {
  target: EditorTarget;
  types: readonly VoucherTypeRow[];
  status: SeriesStatus | null;
  today: string;
  fyStartMonth: number;
  onDirtyChange: (dirty: boolean) => void;
  onClose: (savedId?: number) => void;
  onOpenForm: (id: number) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const company = useCompany();
  const isCreate = target.kind === 'create';
  const type = target.kind === 'alter' ? target.type : null;
  const baseType = target.kind === 'alter' ? target.type.baseType : target.parent.baseType;
  const base = target.kind === 'alter' ? target.type.numbering : newSeriesNumbering(target.parent.numbering);
  const canSave = useCan(isCreate ? 'masters.create' : 'masters.alter');
  const canRenumber = useCan('vouchers.renumber');
  const canSeeVouchers = useCan('vouchers.view');
  const readOnly = !canSave;
  // 'dashboard': Home's Get started step "Set your invoice number series" follows these two.
  const save = useApiMutation('accounts.voucherType.save', { invalidates: ['vouchers', 'print', 'dashboard'] });
  const setNext = useApiMutation('accounts.voucherType.setNextNumber', { invalidates: ['vouchers', 'dashboard'] });
  const fy = financialYear(today, fyStartMonth);
  const automaticSaved = isAutomatic(base.method);
  const gaps = useApiQuery('accounts.voucherType.numberGaps', { id: type?.id ?? 0, from: fy.start, to: fy.end }, { enabled: type !== null && automaticSaved && canSeeVouchers, staleTime: 0 });

  const initialRef = useRef<SeriesDraft>(draftFromNumbering(base, status?.nextSeq ?? null));
  const [d, setD] = useState<SeriesDraft>(initialRef.current);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [advanced, setAdvanced] = useState(() => base.method !== 'automatic' || base.restart === 'monthly');
  const [showGaps, setShowGaps] = useState(false);
  const [busy, setBusy] = useState(false);
  const prefixRef = useRef<HTMLInputElement | null>(null);
  const suffixRef = useRef<HTMLInputElement | null>(null);
  const caret = useRef<{ field: TextField; start: number | null; end: number | null }>({ field: 'prefix', start: null, end: null });

  const scheme = draftNumbering(base, d);
  const automatic = isAutomatic(d.method);
  const gst = company.gstEnabled;
  const gstDoc = GST_DOCUMENT_BASE_TYPES.includes(baseType);
  const check = checkNumbering(baseType, scheme, gst);
  const clash = gst ? seriesClashWarning(seriesClashes(types, type?.id ?? null, baseType, scheme), scheme) : null;
  const warnings = clash ? [...check.warnings, clash] : check.warnings;
  // A new series has no vouchers: it starts at its starting number. An alteration shows the number the
  // core will give after the save; after a restart change that is known only once saved (seeded counter).
  const previewSeq = isCreate ? d.start : previewNextSeq(d, initialRef.current, status);
  const nextAfterSave = !isCreate && automatic && previewSeq === null;
  const preview = seriesPreview(scheme, today, fyStartMonth, previewSeq);
  const fyNote = fyUniquenessNote(baseType, scheme, gst);
  const fixPrefix = monthFix(baseType, scheme, gst);
  const patch = isCreate ? null : numberingPatch(base, d);
  const nextChanged = !isCreate && automatic && d.next !== initialRef.current.next;
  const nextProblem = nextChanged ? nextNumberProblem(d.next, d.start) : null;
  const dirty = isCreate ? d.name.trim() !== '' || JSON.stringify(d) !== JSON.stringify(initialRef.current) : patch !== null || nextChanged;
  const hasDatedRows = (base.prefixRows?.length ?? 0) > 0 || (base.suffixRows?.length ?? 0) > 0;
  const chips = useMemo(() => tokenChips(today, fyStartMonth), [today, fyStartMonth]);
  const lastUsed = status && status.highestUsed !== null ? formatNumber(base, status.highestUsed, today, fyStartMonth) : null;

  // The screen asks before closing the window while the drawer holds changes.
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const set = <K extends keyof SeriesDraft>(k: K, v: SeriesDraft[K]) => {
    setD((x) => ({ ...x, [k]: v }));
    setErrors((e) => {
      if (!(k in e) && !(`numbering.${k}` in e)) return e;
      const copy = { ...e };
      delete copy[k];
      delete copy[`numbering.${k}`];
      return copy;
    });
  };

  const rememberCaret = (field: TextField) => (e: { currentTarget: HTMLInputElement }) => {
    caret.current = { field, start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd };
  };

  const insert = (token: string) => {
    const { field, start, end } = caret.current;
    const r = insertToken(d[field], token, start, end);
    if (!r) {
      toast.info(`The ${field} can have at most 16 characters`, { message: 'Remove some text first, or use a shorter code.' });
      return;
    }
    set(field, r.text);
    caret.current = { field, start: r.caret, end: r.caret };
    const el = field === 'prefix' ? prefixRef.current : suffixRef.current;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(r.caret, r.caret);
    });
  };

  /** setNextNumber with the confirm-warnings protocol; resolves with the next number, or null when declined. */
  const applyNext = async (id: number, next: number): Promise<string | null> => {
    try {
      return (await setNext.mutate({ id, date: today, next })).next;
    } catch (err) {
      if (!confirmationOf(err)) throw err;
      const listed = confirmWarningsOf((err as { details?: unknown }).details);
      const ok = await confirm({
        title: 'Set the next number?',
        message: listed.length > 0 ? undefined : userMessage(err),
        warnings: listed,
        confirmLabel: 'Set next number',
        cancelLabel: 'Go back',
      });
      if (!ok) return null;
      return (await setNext.mutate({ id, date: today, next, acknowledgeWarnings: true })).next;
    }
  };

  /** The next number of a saved automatic series as the core now gives it (null when unknown). */
  const savedNext = async (id: number): Promise<string | null> => {
    if (!automatic) return null;
    try {
      const [row] = await api('accounts.voucherType.numberingStatus', { ids: [id], date: today });
      return row?.next || null;
    } catch {
      return null; // the save succeeded; the list shows the next number once it reloads
    }
  };

  const setNextOnly = async () => {
    if (!type || busy || d.next === null || nextProblem) return;
    setBusy(true);
    try {
      const next = await applyNext(type.id, d.next);
      if (next !== null) {
        initialRef.current = { ...initialRef.current, next: d.next };
        toast.success(`Next ${type.name} number: ${next}`);
      }
    } catch (err) {
      const f = fieldErrorsOf(err);
      setErrors((e) => ({ ...e, next: f.next ?? userMessage(err) }));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (readOnly || busy) return;
    const e: Record<string, string> = {};
    if (isCreate) {
      const p = seriesNameProblem(d.name, types);
      if (p) e.name = p;
    }
    for (const x of check.errors) e[x.path] = x.message;
    if (nextProblem) e.next = nextProblem;
    setErrors(e);
    if (Object.keys(e).length > 0) {
      toast.error('Please correct the highlighted fields', { message: Object.values(e)[0] });
      return;
    }
    if (!isCreate && patch === null && !nextChanged) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      if (target.kind === 'create') {
        const out = await save.mutate({ parentId: target.parent.id, name: d.name.trim(), numbering: scheme });
        toast.success(`Series “${out.name}” created`, { message: `Enter it with F10 (Other vouchers…). First number: ${preview?.today.number ?? 'typed by hand'}.` });
        onClose(out.id);
        return;
      }
      const vt = target.type;
      if (patch) {
        if (vt.voucherCount > 0) {
          const ok = await confirm({
            title: 'Change the numbering?',
            message: `${vt.voucherCount} voucher${vt.voucherCount === 1 ? '' : 's'} already use this series. Their numbers stay as they are; only new vouchers follow the new numbering.`,
            confirmLabel: 'Change numbering',
          });
          if (!ok) return;
        }
        await save.mutate({ id: vt.id, numbering: patch });
      }
      const nextSeq = nextNumberToSet(d, initialRef.current);
      let nextText: string | null = null;
      if (nextSeq !== null) {
        try {
          nextText = await applyNext(vt.id, nextSeq);
        } catch (err) {
          toast.error(patch ? 'The numbering was saved, but the next number was not changed' : 'The next number was not changed', { message: userMessage(err), duration: 10_000 });
          if (patch) onClose(vt.id);
          else setErrors((x) => ({ ...x, next: fieldErrorsOf(err).next ?? userMessage(err) }));
          return;
        }
        if (nextText === null && !patch) return; // declined: keep editing
      }
      if (nextText === null && nextSeq === null) nextText = await savedNext(vt.id);
      toast.success(`${vt.name} numbering saved`, { message: nextText ? `Next number: ${nextText}` : nextSeq !== null ? 'The next number was left as it was.' : undefined });
      onClose(vt.id);
    } catch (err) {
      const f = fieldErrorsOf(err);
      if (Object.keys(f).length > 0) setErrors(f);
      toast.error(isCreate ? 'The series was not created' : 'The numbering was not saved', { message: Object.values(f)[0] ?? userMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  /** Leave the editor; asks first when something changed (the next number included). */
  const confirmDiscard = async (): Promise<boolean> =>
    !dirty || confirm({ title: 'Discard the changes to this series?', confirmLabel: 'Discard changes', cancelLabel: 'Keep editing' });
  const requestClose = async () => {
    if (await confirmDiscard()) onClose();
  };
  const openForm = async (id: number) => {
    if (await confirmDiscard()) onOpenForm(id);
  };

  const err = (k: string): string | undefined => errors[k] ?? errors[`numbering.${k}`];
  const title = type ? `${type.name} — ${numbersWord(baseType)}` : `Create a series based on ${target.kind === 'create' ? target.parent.name : ''}`;
  const description = isCreate
    ? `A new ${BASE_TYPE_LABELS[baseType]} voucher type with its own numbers, for example Cash Sales or Export Invoice. Enter it with F10 (Other vouchers…).`
    : `${BASE_TYPE_LABELS[baseType]}${type && !type.isActive ? ' · inactive' : ''}${status ? ` · ${status.vouchersInPeriod} voucher${status.vouchersInPeriod === 1 ? '' : 's'} in ${status.periodLabel}` : ''}`;

  return (
    <Drawer
      open
      size="md"
      title={title}
      description={description}
      onClose={() => void requestClose()}
      footer={
        <>
          <Button onClick={() => void requestClose()}>
            {readOnly ? 'Close' : 'Cancel'}
          </Button>
          {readOnly ? null : (
            <Button variant="primary" icon="save" loading={busy} onClick={() => void submit()} shortcut="Ctrl+A">
              {isCreate ? 'Create series' : 'Save'}
            </Button>
          )}
        </>
      }
    >
      {readOnly ? null : <DialogAccept onAccept={() => void submit()} />}
      <Stack gap={4}>
        {readOnly ? (
          <Banner tone="info" inline>
            View only — changing a series needs the Masters › {isCreate ? 'Create' : 'Alter'} permission.
          </Banner>
        ) : null}
        {isCreate ? (
          <Field label="Name of the series" required error={err('name')} hint={`Works like ${target.kind === 'create' ? target.parent.name : ''}; its numbers are counted separately.`}>
            <TextInput value={d.name} onChange={(e) => set('name', e.target.value)} maxLength={60} placeholder="e.g. Cash Sales, Export Invoice" readOnly={readOnly} />
          </Field>
        ) : null}

        {automatic ? (
          <Stack gap={2}>
            <Field label="Prefix" optional error={err('prefix')} hint="Text before the number, e.g. INV/{FY}/ gives INV/26-27/.">
              <TextInput
                ref={prefixRef}
                value={d.prefix}
                onChange={(e) => set('prefix', e.target.value)}
                onFocus={rememberCaret('prefix')}
                onBlur={rememberCaret('prefix')}
                maxLength={16}
                mono
                readOnly={readOnly}
              />
            </Field>
            {readOnly ? null : (
              <Inline gap={1} align="center" role="group" aria-label="Insert a code at the cursor">
                <span className="bx-acc-preview__meta">Insert:</span>
                {chips.map((c) => (
                  <Button key={c.token} size="sm" variant="secondary" aria-label={c.name} title={c.title} onClick={() => insert(c.token)}>
                    {c.label}
                  </Button>
                ))}
              </Inline>
            )}
            <Field label="Suffix" optional error={err('suffix')} hint="Text after the number; the codes work here too.">
              <TextInput
                ref={suffixRef}
                value={d.suffix}
                onChange={(e) => set('suffix', e.target.value)}
                onFocus={rememberCaret('suffix')}
                onBlur={rememberCaret('suffix')}
                maxLength={16}
                mono
                readOnly={readOnly}
              />
            </Field>
            {hasDatedRows ? (
              <Banner tone="info" inline>
                This series changes its prefix or suffix from a date (shown in the preview). Change those rows under Advanced › More options.
              </Banner>
            ) : null}
            <Inline gap={3} align="start">
              <Field label="Digits" error={err('width')} hint="Zeros in front of the number.">
                <Select value={String(d.width)} onChange={(v) => set('width', Number(v))} options={DIGIT_OPTIONS} disabled={readOnly} />
              </Field>
              <Field label="Start at" error={err('start')}>
                <NumberInput value={d.start} onChange={(v) => set('start', Math.max(1, Math.floor(v ?? 1)))} min={1} max={MAX_NEXT_NUMBER} grouping={false} readOnly={readOnly} />
              </Field>
            </Inline>
          </Stack>
        ) : null}

        {d.method !== 'none' ? (
          <Switch
            checked={yearlySwitchOn(d.restart)}
            onChange={(on) => set('restart', restartForSwitch(on))}
            disabled={readOnly}
            label="Start again from the first number every financial year"
          />
        ) : null}
        {fyNote ? (
          <Banner tone="info" inline>
            {fyNote}
          </Banner>
        ) : null}

        <div>
          <Button variant="ghost" size="sm" icon={advanced ? 'chevron-down' : 'chevron-right'} aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)}>
            Advanced
          </Button>
        </div>
        {advanced ? (
          <Stack gap={3} role="group" aria-label="Advanced numbering">
            {d.method !== 'none' ? (
              <Checkbox
                checked={d.restart === 'monthly'}
                onChange={(on) => set('restart', restartForMonthly(on))}
                disabled={readOnly}
                label="Start again every month"
              />
            ) : null}
            {fixPrefix !== null && !readOnly ? (
              <div>
                <Button size="sm" icon="plus" onClick={() => set('prefix', fixPrefix)}>
                  Add month to prefix → {fixPrefix}
                </Button>
              </div>
            ) : null}
            <RadioGroup
              label="How numbers are given"
              options={SIMPLE_METHOD_OPTIONS.map((o) => ({ value: o.value, label: o.label, description: o.description }))}
              value={d.method}
              onChange={(m) => set('method', m)}
              disabled={readOnly}
              error={err('method')}
            />
            {type ? (
              <div>
                <Button variant="link" icon="sliders" onClick={() => void openForm(type.id)}>
                  More options: dated prefix / suffix, behaviour, printing…
                </Button>
              </div>
            ) : null}
          </Stack>
        ) : null}

        {!isCreate && automatic && status ? (
          <Inline gap={2} align="end">
            <Field
              label="Next number"
              error={err('next')}
              hint={
                !canRenumber
                  ? RENUMBER_HINT
                  : nextAfterSave
                    ? 'With the new restart it continues after the numbers already used; type a number to choose it.'
                    : lastUsed
                      ? `Last used ${lastUsed} (${status.periodLabel}).`
                      : `Nothing used yet in ${status.periodLabel}.`
              }
            >
              <NumberInput value={d.next} onChange={(v) => set('next', v === null ? null : Math.floor(v))} min={1} max={MAX_NEXT_NUMBER} grouping={false} readOnly={!canRenumber} />
            </Field>
            <Button
              aria-label="Set next number"
              onClick={() => void setNextOnly()}
              disabled={!canRenumber || !nextChanged || nextProblem !== null || patch !== null || busy}
              title={!canRenumber ? RENUMBER_HINT : patch !== null ? 'Save the numbering first (Ctrl+A also sets the next number).' : undefined}
            >
              Set
            </Button>
          </Inline>
        ) : null}

        <div className="bx-acc-preview" role="status" aria-live="polite" aria-label="Numbering preview">
          {preview && nextAfterSave ? (
            <>
              <span className="bx-acc-preview__meta">Numbers look like</span>
              <span className="bx-acc-preview__number">{preview.today.number}</span>
              <span className="bx-acc-preview__meta">· the next number is worked out when you save · {lengthNote(preview.longest, gstDoc && gst)}</span>
            </>
          ) : preview ? (
            <>
              <span className="bx-acc-preview__meta">{formatDate(preview.today.date)} →</span>
              <span className="bx-acc-preview__number">{preview.today.number}</span>
              <span className="bx-acc-preview__meta">· {formatDate(preview.nextFy.date)} →</span>
              <span className="bx-acc-preview__number">{preview.nextFy.number}</span>
              <span className="bx-acc-preview__meta">· {lengthNote(preview.longest, gstDoc && gst)}</span>
            </>
          ) : (
            <span className="bx-acc-preview__meta">{d.method === 'manual' ? 'You type each number yourself.' : 'Vouchers of this type carry no number.'}</span>
          )}
        </div>
        {gstDoc && gst && automatic && check.errors.length === 0 ? (
          <OkHint>{gstValidText(baseType)}</OkHint>
        ) : null}
        {check.errors.length > 0 ? (
          <Banner tone="danger" title={gstDoc && gst ? 'These numbers cannot be used for GST documents' : 'Fix the numbering'}>
            <ul>
              {check.errors.map((x) => (
                <li key={x.path + x.message}>{x.message}</li>
              ))}
            </ul>
          </Banner>
        ) : null}
        {warnings.length > 0 ? (
          <Banner tone="warning" title="Check the numbering">
            <ul>
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Banner>
        ) : null}

        {gaps.data && type ? (
          <div>
            <Inline gap={2} align="center">
              <span>
                Gaps in {fy.label}: {gapsSummary(gaps.data)}
              </span>
              {gaps.data.missingCount > 0 ? (
                <Button size="sm" variant="ghost" aria-expanded={showGaps} onClick={() => setShowGaps((s) => !s)}>
                  {showGaps ? 'Hide' : 'Show'}
                </Button>
              ) : null}
            </Inline>
            {showGaps && gaps.data.missingCount > 0 ? (
              <div role="group" aria-label="Missing numbers">
                <p className="bx-acc-preview__meta">
                  {gaps.data.missing.join(', ')}
                  {gaps.data.missingCount > gaps.data.missing.length ? ` … and ${gaps.data.missingCount - gaps.data.missing.length} more` : ''}.{gstDoc && gst ? ' Numbers not issued are reported in GSTR-1 Table 13.' : ''}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </Stack>
    </Drawer>
  );
}
