/**
 * Recurring vouchers (rent, retainers, AMC, EMIs …):
 *
 *  'documents.recurring'       Templates: schedule, next due, last posted, paused or active.
 *                              Keys: Enter Alter · Alt+C Create · Alt+S Pause / resume · Alt+R Due vouchers ·
 *                              Alt+D Delete · Alt+E Export.
 *  'documents.recurring.form'  {id?} alter · {sourceVoucherId?} create from a saved voucher (vouchers.view Alt+R) ·
 *                              {} create, picking the voucher to copy. Keys: Ctrl+A Save · Alt+U Undo skip
 *                              (selected occurrence) · Alt+D Delete · Alt+H Edit history.
 *  'documents.recurring.due'   Review-then-post: every occurrence due up to the working date, all ticked.
 *                              Keys: Space / Alt+T Tick or untick · Ctrl+A Post ticked · Enter Edit & post ·
 *                              Alt+O Change amount · Alt+S Skip · Alt+R Templates · Alt+E Export.
 *
 * Nothing posts by itself (the app has no background process): the Gateway shows the due count when the
 * company opens and the dashboard has a card. Posting is idempotent per occurrence (the core refuses a
 * second posting of the same period), and every posted voucher is an ordinary, audited vouchers.save.
 */
import { useEffect, useMemo, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import { RECURRING_FREQUENCIES } from '../../../shared/types/documents.ts';
import type { RecurringDueRow, RecurringFrequency, RecurringRunRow, RecurringTemplateRow } from '../../../shared/types/documents.ts';
import type { VoucherListRow } from '../../../shared/types/vouchers.ts';
import {
  api,
  ReportScreen,
  Screen,
  useApiMutation,
  useApiQuery,
  useBooks,
  useCan,
  useConfirm,
  useNav,
  userMessage,
  useWorkingDate,
} from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import {
  AmountInput,
  Badge,
  Banner,
  Button,
  Card,
  DataTable,
  DateInput,
  EmptyState,
  Field,
  FieldGroup,
  Icon,
  Modal,
  NumberInput,
  Picker,
  Select,
  Stack,
  Switch,
  TextArea,
  TextInput,
  useEnterAdvance,
  useHotkeys,
  useToast,
} from '../../ui/index.ts';
import type { Column, FooterRow } from '../../ui/index.ts';
import {
  amountToSend,
  DAY_OF_MONTH_OPTIONS,
  DOCUMENTS_INVALIDATES,
  dueExport,
  FREQUENCY_LABEL,
  postItems,
  scheduleInput,
  scheduleProblem,
  scheduleText,
  selectedKeys,
  toggleKey,
} from './lib/model.ts';

const EMPTY_TEMPLATES: readonly RecurringTemplateRow[] = [];
const EMPTY_DUE: readonly RecurringDueRow[] = [];

// ───────────────────────────── Templates ─────────────────────────────

export function RecurringListScreen() {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const canCreate = useCan('vouchers.create');
  const canDelete = useCan('vouchers.delete');
  const q = useApiQuery('documents.recurring.list', {}, { keepPrevious: true });
  const rows = q.data ?? EMPTY_TEMPLATES;
  const [selected, setSelected] = useState<string | null>(null);
  const current = rows.find((r) => String(r.id) === selected) ?? rows[0] ?? null;
  const setActive = useApiMutation('documents.recurring.setActive', { invalidates: DOCUMENTS_INVALIDATES });
  const del = useApiMutation('documents.recurring.delete', { invalidates: DOCUMENTS_INVALIDATES });

  const columns = useMemo<Column<RecurringTemplateRow>[]>(
    () => [
      { key: 'name', header: 'Name', minWidth: 180, sortable: true },
      { key: 'voucherTypeName', header: 'Voucher type', width: 130 },
      { key: 'partyName', header: 'Party', minWidth: 150, value: (r) => r.partyName ?? '' },
      { key: 'schedule', header: 'Schedule', minWidth: 200, value: (r) => scheduleText(r) },
      { key: 'nextDate', header: 'Next due', kind: 'date', width: 110, sortable: true },
      { key: 'lastPosted', header: 'Last posted', width: 150, value: (r) => (r.lastPosted ? `${formatDate(r.lastPosted.date)}${r.lastPosted.number ? ` · ${r.lastPosted.number}` : ''}` : '') },
      { key: 'postedCount', header: 'Posted', kind: 'number', width: 80, blankZero: true },
      { key: 'amount', header: 'Amount', kind: 'amount', width: 140, value: (r) => r.amount ?? 0 },
      {
        key: 'isActive',
        header: 'Status',
        width: 100,
        value: (r) => (r.isActive ? 'Active' : 'Paused'),
        render: (r) => (
          <Badge tone={r.isActive ? (r.nextDate ? 'success' : 'neutral') : 'warning'} size="sm">
            {r.isActive ? (r.nextDate ? 'Active' : 'Ended') : 'Paused'}
          </Badge>
        ),
      },
    ],
    [],
  );

  const toggleActive = async () => {
    if (!current) return;
    try {
      await setActive.mutate({ id: current.id, active: !current.isActive });
      toast.success(current.isActive ? `“${current.name}” paused` : `“${current.name}” resumed`, {
        message: current.isActive ? 'It will not be listed as due until you resume it.' : 'Occurrences missed while it was paused are due now — skip the ones you do not want.',
      });
    } catch (err) {
      toast.error('Could not change the template', { message: userMessage(err) });
    }
  };
  const remove = async () => {
    if (!current) return;
    const ok = await confirm({
      title: `Delete recurring voucher “${current.name}”?`,
      message: 'The template and its posting history are removed. Vouchers already posted from it stay in the books.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await del.mutate({ id: current.id });
      toast.success(`“${current.name}” deleted`);
      setSelected(null);
    } catch (err) {
      toast.error('Could not delete', { message: userMessage(err) });
    }
  };

  const actions: ScreenActionItem[] = [
    { key: 'Alt+C', label: 'Create recurring voucher', icon: 'plus', primary: true, onClick: () => nav.push('documents.recurring.form', {}), hidden: !canCreate, group: 'go' },
    { key: 'Alt+R', label: 'Due vouchers', icon: 'clock', onClick: () => nav.push('documents.recurring.due', {}), group: 'go' },
    { key: 'Alt+S', label: current?.isActive === false ? 'Resume' : 'Pause', icon: current?.isActive === false ? 'zap' : 'clock', onClick: () => void toggleActive(), disabled: !current, hidden: !canCreate, group: 'go' },
    { key: 'Alt+D', label: 'Delete', icon: 'trash', onClick: () => void remove(), disabled: !current, hidden: !canDelete, group: 'danger' },
  ];

  return (
    <ReportScreen
      title="Recurring Vouchers"
      subtitle="Rent, retainers, AMC, EMIs — vouchers you post on a schedule"
      periodMode="none"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      actions={actions}
      hint="Enter Alter · Alt+C Create · Alt+S Pause or resume · Alt+R Due vouchers · Alt+D Delete · Alt+E Export"
      exportDef={() => ({
        columns: [
          { header: 'Name', width: 28 },
          { header: 'Voucher type', width: 16 },
          { header: 'Party', width: 24 },
          { header: 'Schedule', width: 30 },
          { header: 'Next due', kind: 'date', width: 12 },
          { header: 'Posted', kind: 'number', width: 8 },
          { header: 'Status', width: 10 },
          { header: 'Amount', kind: 'amount', width: 16 },
        ],
        rows: rows.map((r) => [r.name, r.voucherTypeName, r.partyName ?? '', scheduleText(r), r.nextDate, r.postedCount, r.isActive ? 'Active' : 'Paused', r.amount]),
        landscape: true,
      })}
    >
      <DataTable<RecurringTemplateRow>
        aria-label="Recurring vouchers"
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => String(r.id)}
        selectedKey={current ? String(current.id) : null}
        onSelect={(k) => setSelected(k)}
        onRowActivate={(r) => nav.push('documents.recurring.form', { id: r.id })}
        loading={q.loading}
        empty={
          <EmptyState
            icon="refresh"
            title="No recurring vouchers yet"
            body="Open a saved voucher (rent, a retainer invoice, an EMI payment) and press Alt+R to make it recurring — or press Alt+C here and pick the voucher to copy."
          />
        }
      />
    </ReportScreen>
  );
}

// ───────────────────────────── Template form ─────────────────────────────

export interface RecurringFormParams {
  id?: number;
  sourceVoucherId?: number;
}

interface FormState {
  name: string;
  frequency: RecurringFrequency;
  intervalDays: number | null;
  dayOfMonth: number | null;
  startDate: string | null;
  endDate: string | null;
  amount: number | null;
  isActive: boolean;
  notes: string;
}

const FREQUENCY_OPTIONS = RECURRING_FREQUENCIES.map((f) => ({ value: f, label: FREQUENCY_LABEL[f] }));
const DAY_OPTIONS = DAY_OF_MONTH_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }));

export function RecurringFormScreen({ params }: ScreenProps<RecurringFormParams>) {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const books = useBooks();
  const { date: workingDate } = useWorkingDate();
  const canDelete = useCan('vouchers.delete');
  const canAudit = useCan('audit.view');
  const isAlter = params.id !== undefined;
  const [source, setSource] = useState<VoucherListRow | null>(null);
  const sourceId = params.sourceVoucherId ?? source?.id;
  const existing = useApiQuery('documents.recurring.get', { id: params.id ?? 0 }, { enabled: isAlter, staleTime: 0 });
  const suggestion = useApiQuery('documents.recurring.fromVoucher', { voucherId: sourceId ?? 0 }, { enabled: !isAlter && sourceId !== undefined, staleTime: 0 });
  const save = useApiMutation('documents.recurring.save', { invalidates: DOCUMENTS_INVALIDATES });
  const del = useApiMutation('documents.recurring.delete', { invalidates: DOCUMENTS_INVALIDATES });
  const unskip = useApiMutation('documents.recurring.unskip', { invalidates: DOCUMENTS_INVALIDATES });
  const [form, setForm] = useState<FormState | null>(null);
  const [touched, setTouched] = useState(false);
  const [problem, setProblem] = useState<{ field: string; message: string } | null>(null);
  const [runKey, setRunKey] = useState<string | null>(null);

  // Fill the form once from the template (alter) or the suggestion for the chosen voucher (create).
  const loaded = isAlter ? existing.data : suggestion.data;
  useEffect(() => {
    if (!loaded) return;
    setForm({
      name: loaded.name,
      frequency: loaded.frequency,
      intervalDays: loaded.intervalDays ?? null,
      dayOfMonth: loaded.frequency === 'every_n_days' ? null : (loaded.dayOfMonth ?? Number(loaded.startDate.slice(8, 10))),
      startDate: loaded.startDate,
      endDate: loaded.endDate ?? null,
      amount: loaded.amount ?? null,
      isActive: 'isActive' in loaded ? loaded.isActive : true,
      notes: 'notes' in loaded && typeof loaded.notes === 'string' ? loaded.notes : '',
    });
    setTouched(false);
  }, [loaded]);

  const patch = (p: Partial<FormState>) => {
    setForm((f) => (f ? { ...f, ...p } : f));
    setTouched(true);
    setProblem(null);
  };

  const overridable = loaded?.overridable ?? false;
  const submit = async () => {
    if (!form || save.pending) return;
    const p = scheduleProblem(form);
    if (p) {
      setProblem(p);
      return;
    }
    if (!form.name.trim()) {
      setProblem({ field: 'name', message: 'Give the template a name (e.g. "Office rent – Sharma Estates").' });
      return;
    }
    const amount = amountToSend(loaded?.amount ?? null, form.amount, overridable);
    try {
      const out = await save.mutate({
        ...(isAlter ? { id: params.id } : { sourceVoucherId: sourceId }),
        name: form.name.trim(),
        ...scheduleInput({ ...form, startDate: form.startDate as string }),
        ...(amount !== undefined ? { amount } : {}),
        isActive: form.isActive,
        notes: form.notes.trim() || undefined,
      });
      toast.success(`Recurring voucher “${out.name}” saved`, { message: out.nextDate ? `Next due on ${formatDate(out.nextDate)}.` : 'The schedule has no further occurrences.' });
      setTouched(false);
      nav.pop({ id: out.id, name: out.name });
    } catch {
      // save.error / save.fieldErrors are shown on the form
    }
  };

  const remove = async () => {
    if (!isAlter || !existing.data) return;
    const ok = await confirm({
      title: `Delete recurring voucher “${existing.data.name}”?`,
      message: 'The template and its posting history are removed. Vouchers already posted from it stay in the books.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await del.mutate({ id: existing.data.id });
      toast.success(`“${existing.data.name}” deleted`);
      setTouched(false);
      nav.pop();
    } catch (err) {
      toast.error('Could not delete', { message: userMessage(err) });
    }
  };

  const runs = existing.data?.runs ?? [];
  const run = runs.find((r) => r.periodKey === runKey) ?? null;
  const undoSkip = async () => {
    if (!run || run.status !== 'skipped' || !existing.data) return;
    try {
      await unskip.mutate({ templateId: existing.data.id, periodKey: run.periodKey });
      toast.success(`${formatDate(run.scheduledDate)} is due again`);
      void existing.refetch();
    } catch (err) {
      toast.error('Could not undo the skip', { message: userMessage(err) });
    }
  };

  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => void submit() });
  const err = (field: string): string | undefined => (problem?.field === field ? problem.message : undefined) ?? save.fieldErrors[field];
  const title = isAlter ? 'Recurring Voucher Alteration' : 'Recurring Voucher Creation';
  const loading = (isAlter && existing.loading) || (!isAlter && sourceId !== undefined && suggestion.loading);
  const loadError = isAlter ? existing.error : sourceId !== undefined ? suggestion.error : null;

  const actions: ScreenActionItem[] = [
    { key: 'Ctrl+A', label: 'Save', icon: 'save', primary: true, onClick: () => void submit(), disabled: !form },
    { key: 'Alt+U', label: 'Undo skip', icon: 'undo', onClick: () => void undoSkip(), hidden: !isAlter, disabled: run?.status !== 'skipped', hint: 'Select a skipped occurrence below' },
    {
      key: 'Alt+H',
      label: 'Edit history',
      icon: 'clock',
      onClick: () => nav.push('security.audit', { entityType: 'recurring_template', entityId: params.id }),
      hidden: !isAlter || !canAudit || !nav.isRegistered('security.audit'),
      group: 'output',
    },
    { key: 'Alt+D', label: 'Delete', icon: 'trash', onClick: () => void remove(), hidden: !isAlter || !canDelete, group: 'danger' },
  ];

  const runColumns = useMemo<Column<RecurringRunRow>[]>(
    () => [
      { key: 'scheduledDate', header: 'Due on', kind: 'date', width: 110 },
      { key: 'periodKey', header: 'Period', width: 100 },
      {
        key: 'status',
        header: 'Status',
        width: 100,
        render: (r) => (
          <Badge tone={r.status === 'posted' ? 'success' : 'neutral'} size="sm">
            {r.status === 'posted' ? 'Posted' : 'Skipped'}
          </Badge>
        ),
      },
      { key: 'voucher', header: 'Voucher', minWidth: 160, value: (r) => (r.voucher ? `${r.voucher.voucherTypeName} ${r.voucher.number ?? ''} dt ${formatDate(r.voucher.date)}${r.voucher.isCancelled ? ' (cancelled)' : ''}` : '') },
    ],
    [],
  );

  const pickVoucher = async (query: string, signal: AbortSignal): Promise<readonly VoucherListRow[]> => {
    const out = await api('vouchers.list', { from: books.booksFrom, to: workingDate, search: query.trim() || undefined, sort: 'date_desc', limit: 25 });
    if (signal.aborted) return [];
    return out.rows.filter((r) => !r.isCancelled && r.baseType !== 'physical_stock');
  };

  return (
    <Screen
      title={title}
      subtitle={loaded ? `${loaded.voucherTypeName}${'partyName' in loaded && loaded.partyName ? ` · ${loaded.partyName}` : ''}` : undefined}
      icon="refresh"
      width="form"
      dirty={touched}
      loading={loading}
      error={loadError}
      onRetry={() => void (isAlter ? existing.refetch() : suggestion.refetch())}
      actions={actions}
      hint="Enter Next field · Ctrl+A Save · Esc Back"
    >
      <div ref={formRef}>
        <Stack gap={4}>
          {save.error && Object.keys(save.fieldErrors).length === 0 ? <Banner tone="danger">{userMessage(save.error)}</Banner> : null}
          {!isAlter && params.sourceVoucherId === undefined ? (
            <Field label="Voucher to copy" required error={save.fieldErrors.sourceVoucherId} hint="A saved voucher of any type (memorandum included): the template posts the same lines each time.">
              <Picker<VoucherListRow>
                loadItems={pickVoucher}
                getKey={(r) => String(r.id)}
                getLabel={(r) => `${r.voucherTypeName} ${r.number ?? ''} · ${formatDate(r.date)}${r.partyName ? ` · ${r.partyName}` : ''}`}
                rightMeta={(r) => `₹ ${formatMoney(r.amount)}`}
                value={source}
                onChange={(r) => {
                  setSource(r);
                  setTouched(true);
                }}
                placeholder="Type a voucher number, party or narration"
              />
            </Field>
          ) : null}
          {!isAlter && sourceId === undefined ? (
            <EmptyState size="sm" icon="refresh" title="Pick the voucher to repeat" body="Its lines, party and narration are copied. Write {period} in the narration to get “May 2026” in each posting." />
          ) : null}
          {suggestion.data && !isAlter && suggestion.data.notes.length > 0 ? (
            <Banner tone="info" title="What is copied">
              {suggestion.data.notes.join(' ')}
            </Banner>
          ) : null}
          {form ? (
            <>
              <FieldGroup legend="Template">
                <Field label="Name" required error={err('name')}>
                  <TextInput value={form.name} onValueChange={(v) => patch({ name: v })} maxLength={100} data-autofocus={params.sourceVoucherId !== undefined || isAlter ? true : undefined} />
                </Field>
                {overridable ? (
                  <Field label="Amount" error={err('amount')} hint="Replaces the voucher's one amount for every future posting (tax is worked out again).">
                    <AmountInput value={form.amount} onChange={(v) => patch({ amount: v })} symbol min={1} />
                  </Field>
                ) : (
                  <Field label="Amount" hint="This voucher has several amounts: change them per posting with Edit & post, or copy an altered voucher again.">
                    <TextInput value={loaded?.amount !== null && loaded?.amount !== undefined ? `₹ ${formatMoney(loaded.amount)}` : '—'} readOnly />
                  </Field>
                )}
              </FieldGroup>
              <FieldGroup legend="Schedule" columns={2}>
                <Field label="Frequency" required>
                  <Select<RecurringFrequency> options={FREQUENCY_OPTIONS} value={form.frequency} onChange={(v) => patch({ frequency: v, intervalDays: v === 'every_n_days' ? (form.intervalDays ?? 30) : form.intervalDays })} />
                </Field>
                {form.frequency === 'every_n_days' ? (
                  <Field label="Every (days)" required error={err('intervalDays')}>
                    <NumberInput value={form.intervalDays} onChange={(v) => patch({ intervalDays: v })} min={1} max={366} />
                  </Field>
                ) : (
                  <Field label="Day of the month" error={err('dayOfMonth')} hint="A day past the end of a short month posts on its last day.">
                    <Select options={DAY_OPTIONS} value={form.dayOfMonth === null ? '' : String(form.dayOfMonth)} onChange={(v) => patch({ dayOfMonth: Number(v) })} />
                  </Field>
                )}
                <Field label="First posting on" required error={err('startDate')}>
                  <DateInput value={form.startDate} onChange={(d) => patch({ startDate: d })} referenceDate={workingDate} />
                </Field>
                <Field label="Last posting on or before" optional error={err('endDate')} hint="Blank: no end">
                  <DateInput value={form.endDate} onChange={(d) => patch({ endDate: d })} referenceDate={workingDate} minDate={form.startDate ?? undefined} />
                </Field>
              </FieldGroup>
              <FieldGroup legend="Status">
                <Field label="Active" hint="A paused template is never listed as due.">
                  <Switch checked={form.isActive} onChange={(v) => patch({ isActive: v })} aria-label="Active" />
                </Field>
                <Field label="Notes" optional>
                  <TextArea value={form.notes} onValueChange={(v) => patch({ notes: v })} maxLength={500} autoGrow />
                </Field>
              </FieldGroup>
              <p className="bx-muted">
                {scheduleText({ ...form, startDate: form.startDate ?? workingDate })}
                {form.startDate ? ` · first posting ${formatDate(form.startDate)}` : ''}
              </p>
            </>
          ) : null}
          {isAlter && runs.length > 0 ? (
            <Card title="Occurrences dealt with" subtitle="Latest first. Deleting a posted voucher makes its occurrence due again." padding="sm">
              <DataTable<RecurringRunRow>
                aria-label="Occurrences dealt with"
                columns={runColumns}
                rows={runs}
                getRowKey={(r) => r.periodKey}
                selectedKey={runKey}
                onSelect={(k) => setRunKey(k)}
                onRowActivate={(r) => (r.voucher ? nav.push('vouchers.view', { id: r.voucher.id }) : undefined)}
                density="compact"
              />
            </Card>
          ) : null}
        </Stack>
      </div>
    </Screen>
  );
}

// ───────────────────────────── Due list (review, then post) ─────────────────────────────

export function RecurringDueScreen() {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const canCreate = useCan('vouchers.create');
  const { date } = useWorkingDate();
  const q = useApiQuery('documents.recurring.due', { asOf: date }, { keepPrevious: true, staleTime: 0 });
  const rows = q.data?.rows ?? EMPTY_DUE;
  const post = useApiMutation('documents.recurring.post', { invalidates: [...DOCUMENTS_INVALIDATES] });
  const skip = useApiMutation('documents.recurring.skip', { invalidates: DOCUMENTS_INVALIDATES });
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [overrides, setOverrides] = useState<Record<string, number | null>>({});
  const [cursor, setCursor] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'amount' | 'skip' | null>(null);
  const current = rows.find((r) => r.key === cursor) ?? rows[0] ?? null;
  const selected = useMemo(() => selectedKeys(rows, unticked), [rows, unticked]);
  const items = postItems(rows, selected, overrides);
  const total = rows.filter((r) => selected.has(r.key)).reduce((a, r) => a + (overrides[r.key] ?? r.amount ?? 0), 0);

  const toggle = (key: string) => setUnticked((u) => toggleKey(u, key));
  const doPost = async () => {
    if (items.length === 0 || post.pending) return;
    try {
      let res = await post.mutate({ items });
      const needs = res.results.filter((r) => !r.ok && r.needsConfirmation);
      if (needs.length > 0) {
        const ok = await confirm({
          title: `${needs.length} voucher${needs.length === 1 ? ' needs' : 's need'} your confirmation`,
          message: needs.map((r) => (r.ok ? '' : `${r.periodKey}: ${r.message}`)).join('\n'),
          confirmLabel: 'Post anyway',
        });
        if (ok) {
          const retry = await post.mutate({ items: items.filter((i) => needs.some((n) => n.templateId === i.templateId && n.periodKey === i.periodKey)), acknowledgeWarnings: true });
          res = { posted: res.posted + retry.posted, failed: res.failed - needs.length + retry.failed, results: [...res.results.filter((r) => !needs.includes(r)), ...retry.results] };
        }
      }
      const failed = res.results.filter((r) => !r.ok);
      if (res.posted > 0) toast.success(`${res.posted} voucher${res.posted === 1 ? '' : 's'} posted`, { message: 'Each one is in the Day Book and the edit log.' });
      if (failed.length > 0) {
        toast.error(`${failed.length} could not be posted`, {
          message: failed.map((r) => (r.ok ? '' : `${r.periodKey}: ${r.message}`)).join(' '),
          duration: 15_000,
        });
      }
      setOverrides({});
      setUnticked(new Set());
    } catch (err) {
      toast.error('Could not post', { message: userMessage(err) });
    }
  };

  const columns = useMemo<Column<RecurringDueRow>[]>(
    () => [
      {
        key: 'tick',
        header: 'Post',
        width: 64,
        align: 'center',
        value: (r) => (selected.has(r.key) ? 'Yes' : 'No'),
        render: (r) => <Icon name={selected.has(r.key) ? 'check-circle' : 'x-circle'} label={selected.has(r.key) ? 'Will be posted' : 'Not ticked'} />,
      },
      { key: 'date', header: 'Date', kind: 'date', width: 110, sortable: true },
      { key: 'templateName', header: 'Recurring voucher', minWidth: 180 },
      { key: 'voucherTypeName', header: 'Type', width: 120 },
      { key: 'partyName', header: 'Party', minWidth: 150, value: (r) => r.partyName ?? '' },
      { key: 'periodKey', header: 'Period', width: 100 },
      { key: 'overdueDays', header: 'Overdue', width: 100, value: (r) => r.overdueDays, render: (r) => (r.overdueDays > 0 ? <Badge tone="warning" size="sm">{`${r.overdueDays} day${r.overdueDays === 1 ? '' : 's'}`}</Badge> : <span className="bx-muted">Today</span>) },
      {
        key: 'amount',
        header: 'Amount (before tax)',
        kind: 'amount',
        width: 160,
        value: (r) => overrides[r.key] ?? r.amount ?? 0,
        render: (r) => (
          <span className="bx-num">
            {formatMoney(overrides[r.key] ?? r.amount ?? 0)}
            {overrides[r.key] !== undefined && overrides[r.key] !== r.amount ? ' *' : ''}
          </span>
        ),
      },
    ],
    [selected, overrides],
  );
  const footer = useMemo<FooterRow[]>(
    () => (rows.length > 0 ? [{ key: 'total', tone: 'total', cells: { templateName: `${selected.size} of ${rows.length} ticked`, amount: total } }] : []),
    [rows.length, selected.size, total],
  );

  const actions: ScreenActionItem[] = [
    { key: 'Ctrl+A', label: `Post ticked (${selected.size})`, icon: 'check', primary: true, onClick: () => void doPost(), disabled: selected.size === 0 || post.pending, hidden: !canCreate },
    { key: 'Alt+T', label: current && selected.has(current.key) ? 'Untick' : 'Tick', icon: 'check-circle', onClick: () => current && toggle(current.key), disabled: !current, group: 'select' },
    { key: 'Alt+O', label: 'Change amount', icon: 'rupee', onClick: () => setDialog('amount'), disabled: !current?.overridable, hint: current && !current.overridable ? 'Several amounts: use Enter (Edit & post)' : undefined, group: 'select' },
    { key: 'Alt+S', label: 'Skip occurrence', icon: 'x-circle', onClick: () => setDialog('skip'), disabled: !current, hidden: !canCreate, group: 'select' },
    { key: 'Alt+R', label: 'Templates', icon: 'refresh', onClick: () => nav.push('documents.recurring', {}), group: 'go' },
  ];

  const editAndPost = (r: RecurringDueRow) => {
    if (!canCreate) return;
    nav.push('vouchers.entry', { voucherTypeId: r.voucherTypeId, draft: { templateId: r.templateId, periodKey: r.periodKey } });
  };

  return (
    <ReportScreen
      title="Due Recurring Vouchers"
      subtitle={`Due up to ${formatDate(date)} (working date, F2) · ₹ ${formatMoney(total)} ticked`}
      periodMode="none"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={q.refetch}
      actions={actions}
      hint="Space Tick or untick · Ctrl+A Post ticked · Enter Edit and post · Alt+O Change amount · Alt+S Skip · Alt+E Export"
      exportDef={() => dueExport(rows)}
    >
      <Stack gap={3} grow>
        {q.data?.truncated ? (
          <Banner tone="warning" title="Long catch-up list">
            Some templates have more than 60 occurrences due; the oldest are listed first. Post or skip these, and the rest will follow.
          </Banner>
        ) : null}
        <DataTable<RecurringDueRow>
          aria-label="Due recurring vouchers"
          autoFocus
          columns={columns}
          rows={rows}
          getRowKey={(r) => r.key}
          selectedKey={current?.key ?? null}
          onSelect={(k) => setCursor(k)}
          onRowActivate={editAndPost}
          onRowKeyDown={(e, r) => {
            if (r && e.key === ' ' && !e.ctrlKey && !e.altKey) {
              e.preventDefault();
              toggle(r.key);
            }
          }}
          footerRows={footer.length > 0 ? footer : undefined}
          loading={q.loading}
          empty={<EmptyState icon="check-circle" title="Nothing is due" body={`No recurring voucher is due up to ${formatDate(date)}. Templates are under Alt+R.`} />}
        />
        {Object.keys(overrides).length > 0 ? <p className="bx-muted">* Amount changed for this posting only.</p> : null}
      </Stack>
      {dialog === 'amount' && current ? (
        <AmountDialog
          row={current}
          value={overrides[current.key] ?? current.amount}
          onClose={() => setDialog(null)}
          onSave={(v) => {
            setOverrides((o) => ({ ...o, [current.key]: v }));
            setDialog(null);
          }}
        />
      ) : null}
      {dialog === 'skip' && current ? (
        <SkipDialog
          row={current}
          pending={skip.pending}
          onClose={() => setDialog(null)}
          onSkip={async (reason) => {
            try {
              await skip.mutate({ templateId: current.templateId, periodKey: current.periodKey, reason: reason || undefined });
              toast.success(`${current.templateName}: ${formatDate(current.date)} skipped`, { message: 'Undo it from the template (Alt+U) if needed.' });
              setDialog(null);
            } catch (err) {
              toast.error('Could not skip', { message: userMessage(err) });
            }
          }}
        />
      ) : null}
    </ReportScreen>
  );
}

function DialogKeys({ onAccept }: { onAccept: () => void }) {
  useHotkeys({ 'Ctrl+A': () => onAccept() });
  return null;
}

function AmountDialog({ row, value, onClose, onSave }: { row: RecurringDueRow; value: number | null; onClose: () => void; onSave: (v: number | null) => void }) {
  const [amount, setAmount] = useState<number | null>(value);
  const accept = () => onSave(amount !== null && amount > 0 ? amount : row.amount);
  const ref = useEnterAdvance<HTMLDivElement>({ onComplete: accept });
  return (
    <Modal
      open
      onClose={onClose}
      title="Amount for this posting"
      description={`${row.templateName} · ${formatDate(row.date)}`}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" onClick={accept}>
            Use amount
          </Button>
        </>
      }
    >
      <DialogKeys onAccept={accept} />
      <div ref={ref}>
        <Field label="Amount before tax" hint={`Template: ₹ ${formatMoney(row.amount ?? 0)}. GST and totals are worked out again when posted.`}>
          <AmountInput value={amount} onChange={setAmount} symbol min={1} data-autofocus />
        </Field>
      </div>
    </Modal>
  );
}

function SkipDialog({ row, pending, onClose, onSkip }: { row: RecurringDueRow; pending: boolean; onClose: () => void; onSkip: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  const accept = () => onSkip(reason.trim());
  return (
    <Modal
      open
      onClose={onClose}
      title="Skip this occurrence?"
      description={`${row.templateName} due on ${formatDate(row.date)} (${row.periodKey}) will not be posted.`}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" loading={pending} onClick={accept}>
            Skip
          </Button>
        </>
      }
    >
      <DialogKeys onAccept={accept} />
      <Field label="Reason" optional hint="Kept in the edit log (e.g. rent waived for the month).">
        <TextArea value={reason} onValueChange={setReason} maxLength={500} autoGrow data-autofocus />
      </Field>
    </Modal>
  );
}
