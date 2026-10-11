/**
 * The Invoice Numbering editor (2.0; 2.1 shared): a drawer over one number series — prefix / suffix with
 * token chips inserted at the caret, digits, starting number, "start again every financial year", and
 * under Advanced the monthly restart, the method and (2.1) the dated prefix / suffix rows; the next number
 * (needs "Change voucher numbers"), a live preview, the shared GST checks and the gaps of the year.
 *
 *   alter  (Invoice Numbering, Enter / Alt+A) .... saves 'accounts.voucherType.save { id, numbering }' with
 *                                                  only the changed keys, then setNextNumber when changed
 *   create (Invoice Numbering, Alt+C) ............ saves a new voucher type based on the highlighted one
 *   draft  (the Voucher Type form's numbering line) hands the scheme back (`onApply`); the form saves it
 *                                                  with everything else
 *
 * Ctrl+A (or Ctrl+S) saves / applies, Esc closes (asking first when something changed). Pure logic:
 * lib/numbering.ts (tested).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { VoucherBaseType } from '../../../shared/constants.ts';
import { financialYear, formatDate } from '../../../shared/dates.ts';
import { numberingRowProblems } from '../../../shared/numbering.ts';
import type { NumberingTextRow } from '../../../shared/numbering.ts';
import type { VoucherNumbering, VoucherTypeRow } from '../../../shared/types/accounts.ts';
import { api } from '../../app/api.ts';
import { useConfirm } from '../../app/confirm.tsx';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { confirmationOf, fieldErrorsOf, userMessage } from '../../app/lib/apiErrors.ts';
import { useCan, useCompany } from '../../app/state.tsx';
import { useBooks } from '../../app/working.tsx';
import { Banner, Button, Checkbox, DateInput, Drawer, Field, IconButton, Inline, NumberInput, RadioGroup, Select, Stack, Switch, TextInput, useToast } from '../../ui/index.ts';
import { DialogAccept, OkHint } from './components.tsx';
import {
  BASE_TYPE_LABELS,
  checkNumbering,
  cleanDatedRows,
  confirmWarningsOf,
  datedRowsPatch,
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
  mergeNumberingPatches,
  monthFix,
  newSeriesNumbering,
  nextNumberProblem,
  nextNumberToSet,
  numberingPatch,
  previewNextSeq,
  restartForMonthly,
  restartForSwitch,
  seriesClashes,
  seriesClashWarning,
  seriesNameProblem,
  seriesPreview,
  SIMPLE_METHOD_OPTIONS,
  tokenChips,
  withDatedRows,
  yearlySwitchOn,
} from './lib/numbering.ts';
import type { SeriesDraft, SeriesStatus } from './lib/numbering.ts';

const RENUMBER_HINT = 'Needs "Change voucher numbers and the next number" (Users & Roles).';

/** What the editor works on (see the file header). */
export type EditorTarget =
  | { kind: 'alter'; type: VoucherTypeRow }
  | { kind: 'create'; parent: VoucherTypeRow }
  | {
      kind: 'draft';
      /** The voucher type's name as typed in its form (the drawer's title). */
      name: string;
      baseType: VoucherBaseType;
      /** The type being altered (for the clash check), null for a new one. */
      typeId: number | null;
      numbering: VoucherNumbering;
      readOnly: boolean;
      onApply: (numbering: VoucherNumbering) => void;
    };

/** "invoice numbers" (sales), "note numbers" (credit / debit notes), "voucher numbers" (others). */
function numbersWord(baseType: VoucherBaseType): string {
  if (baseType === 'sales') return 'invoice numbers';
  if (baseType === 'credit_note' || baseType === 'debit_note') return 'note numbers';
  return 'voucher numbers';
}

type TextField = 'prefix' | 'suffix';

export function SeriesDrawer({
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
  /** Invoice Numbering: "More options…" opens the voucher type form (absent inside that form). */
  onOpenForm?: (id: number) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const company = useCompany();
  const { booksFrom } = useBooks();
  const isCreate = target.kind === 'create';
  const isDraft = target.kind === 'draft';
  const type = target.kind === 'alter' ? target.type : null;
  const baseType = target.kind === 'alter' ? target.type.baseType : target.kind === 'create' ? target.parent.baseType : target.baseType;
  const base = target.kind === 'alter' ? target.type.numbering : target.kind === 'create' ? newSeriesNumbering(target.parent.numbering) : target.numbering;
  const canSaveRole = useCan(isCreate ? 'masters.create' : 'masters.alter');
  const canSave = target.kind === 'draft' ? !target.readOnly : canSaveRole;
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
  // 2.1: the dated prefix / suffix rows are edited here too (Advanced opens by itself when there are some).
  const [rows, setRows] = useState<{ prefix: NumberingTextRow[]; suffix: NumberingTextRow[] }>(() => ({ prefix: [...(base.prefixRows ?? [])], suffix: [...(base.suffixRows ?? [])] }));
  const hasDatedRows = rows.prefix.length > 0 || rows.suffix.length > 0;
  const [advanced, setAdvanced] = useState(() => base.method !== 'automatic' || base.restart === 'monthly' || hasDatedRows);
  const [showGaps, setShowGaps] = useState(false);
  const [busy, setBusy] = useState(false);
  const prefixRef = useRef<HTMLInputElement | null>(null);
  const suffixRef = useRef<HTMLInputElement | null>(null);
  const caret = useRef<{ field: TextField; start: number | null; end: number | null }>({ field: 'prefix', start: null, end: null });

  const scheme = withDatedRows(draftNumbering(base, d), rows.prefix, rows.suffix);
  const rowIssues = [...numberingRowProblems('prefix', rows.prefix, booksFrom), ...numberingRowProblems('suffix', rows.suffix, booksFrom)];
  const automatic = isAutomatic(d.method);
  const gst = company.gstEnabled;
  const gstDoc = GST_DOCUMENT_BASE_TYPES.includes(baseType);
  const check = checkNumbering(baseType, scheme, gst);
  const clash = gst ? seriesClashWarning(seriesClashes(types, type?.id ?? (target.kind === 'draft' ? target.typeId : null), baseType, scheme), scheme) : null;
  const warnings = clash ? [...check.warnings, clash] : check.warnings;
  // A new series has no vouchers: it starts at its starting number. An alteration shows the number the
  // core will give after the save; after a restart change that is known only once saved (seeded counter).
  const previewSeq = isCreate || (target.kind === 'draft' && target.typeId === null) ? d.start : previewNextSeq(d, initialRef.current, status);
  const nextAfterSave = !isCreate && automatic && previewSeq === null;
  const preview = seriesPreview(scheme, today, fyStartMonth, previewSeq);
  const fyNote = fyUniquenessNote(baseType, scheme, gst);
  const fixPrefix = monthFix(baseType, scheme, gst);
  const patch = isCreate ? null : mergeNumberingPatches(numberingPatch(base, d), datedRowsPatch(base, rows.prefix, rows.suffix));
  const nextChanged = !isCreate && automatic && d.next !== initialRef.current.next;
  const nextProblem = nextChanged ? nextNumberProblem(d.next, d.start) : null;
  const dirty = isCreate ? d.name.trim() !== '' || hasDatedRows || JSON.stringify(d) !== JSON.stringify(initialRef.current) : patch !== null || nextChanged;
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

  const editRows = (kind: 'prefix' | 'suffix', next: NumberingTextRow[]) => {
    setRows((r) => ({ ...r, [kind]: next }));
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith(`numbering.${kind}Rows`))));
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
    for (const x of rowIssues) e[x.path] = x.message;
    if (nextProblem) e.next = nextProblem;
    setErrors(e);
    if (Object.keys(e).length > 0) {
      toast.error('Please correct the highlighted fields', { message: Object.values(e)[0] });
      if (rowIssues.length > 0) setAdvanced(true);
      return;
    }
    if (target.kind === 'draft') {
      // The voucher type form saves it with everything else (its own Save, Ctrl+A).
      // Both kinds of dated rows go explicitly (an emptied kind as []), so the form's save replaces them.
      if (patch !== null) target.onApply({ ...draftNumbering(base, d), prefixRows: cleanDatedRows(rows.prefix), suffixRows: cleanDatedRows(rows.suffix) });
      onClose();
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
    if (onOpenForm && (await confirmDiscard())) onOpenForm(id);
  };

  const err = (k: string): string | undefined => errors[k] ?? errors[`numbering.${k}`];
  const title =
    target.kind === 'draft'
      ? `${target.name.trim() || 'New voucher type'} — ${numbersWord(baseType)}`
      : type
        ? `${type.name} — ${numbersWord(baseType)}`
        : `Create a series based on ${target.kind === 'create' ? target.parent.name : ''}`;
  const description = isCreate
    ? `A new ${BASE_TYPE_LABELS[baseType]} voucher type with its own numbers, for example Cash Sales or Export Invoice. Enter it with F10 (Other vouchers…).`
    : isDraft
      ? `${BASE_TYPE_LABELS[baseType]} · kept when you save the voucher type`
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
              {isCreate ? 'Create series' : isDraft ? 'Done' : 'Save'}
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
            {automatic ? (
              <Stack gap={2} role="group" aria-label="Prefix and suffix from a date">
                <span className="bx-acc-preview__meta">A dated row replaces the prefix or suffix for vouchers dated on or after its date, e.g. a new series from 1-Apr. Numbers already given never change.</span>
                <DatedTextRows kind="prefix" rows={rows.prefix} onChange={(r) => editRows('prefix', r)} errors={errors} readOnly={readOnly} referenceDate={today} />
                <DatedTextRows kind="suffix" rows={rows.suffix} onChange={(r) => editRows('suffix', r)} errors={errors} readOnly={readOnly} referenceDate={today} />
              </Stack>
            ) : null}
            {type && onOpenForm ? (
              <div>
                <Button variant="link" onClick={() => void openForm(type.id)}>
                  More options: behaviour, defaults, printing…
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

/**
 * Dated prefix (or suffix) rows of the numbering (dataplus): each row = applicable-from date + text.
 * Keyboard: Enter moves through the date and text fields (form Enter-advance); the buttons add / remove.
 */
function DatedTextRows({
  kind,
  rows,
  onChange,
  errors,
  readOnly,
  referenceDate,
}: {
  kind: 'prefix' | 'suffix';
  rows: readonly NumberingTextRow[];
  onChange: (rows: NumberingTextRow[]) => void;
  errors: Record<string, string>;
  readOnly: boolean;
  referenceDate: string;
}) {
  const label = kind === 'prefix' ? 'Prefix' : 'Suffix';
  const errOf = (i: number, field: 'applicableFrom' | 'text'): string | undefined => errors[`numbering.${kind}Rows[${i}].${field}`];
  const edit = (i: number, patch: Partial<NumberingTextRow>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <Stack gap={2}>
      {rows.map((r, i) => (
        <Inline key={`${kind}-${i}`} gap={2} align="end">
          <Field label={`${label} from`} error={errOf(i, 'applicableFrom')}>
            <DateInput value={r.applicableFrom || null} onChange={(v) => edit(i, { applicableFrom: v ?? '' })} referenceDate={referenceDate} readOnly={readOnly} aria-label={`${label} row ${i + 1}: applicable from`} />
          </Field>
          <Field label={label} optional error={errOf(i, 'text')}>
            <TextInput value={r.text ?? ''} onChange={(e) => edit(i, { text: e.target.value || null })} readOnly={readOnly} maxLength={16} mono aria-label={`${label} row ${i + 1}: text`} placeholder="(none)" />
          </Field>
          {readOnly ? null : (
            <IconButton icon="trash" variant="ghost" aria-label={`Remove ${kind} row ${i + 1}`} onClick={() => onChange(rows.filter((_, k) => k !== i))} />
          )}
        </Inline>
      ))}
      {readOnly ? null : (
        <div>
          <Button variant="secondary" size="sm" icon="plus" onClick={() => onChange([...rows, { applicableFrom: referenceDate, text: null }])}>
            Add dated {kind}
          </Button>
        </div>
      )}
    </Stack>
  );
}
