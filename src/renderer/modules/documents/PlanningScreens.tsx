/**
 * Scenarios and budgets (Tally: Accounts Info › Scenarios / Budgets; Display › Budget Variance).
 *
 *  'documents.scenarios'        Scenario masters. Enter Alter · Alt+C Create · Alt+D Delete.
 *                               A scenario = include actuals (yes / no) + voucher types whose provisional
 *                               vouchers (memorandum, reversing journals within "applicable up to",
 *                               optional) are added + voucher types whose regular vouchers are left out.
 *                               Pick one on the Trial Balance, P&L or Balance Sheet with Alt+S.
 *  'documents.budgets'          Budget masters. Enter Alter · Alt+C Create · Alt+V Variance · Alt+D Delete.
 *  'documents.budget.form'      {id?} Name, period, lines (group / ledger / cost centre, on nett
 *                               transactions or closing balance, Dr / Cr amount). Ctrl+A Save ·
 *                               Ctrl+D Remove line · Alt+H Edit history.
 *  'documents.budget.variance'  {budgetId?} Budget vs actual per line, variance and variance %. Enter drills
 *                               to the ledger / group summary / cost centres. Ctrl+1 Budget period ·
 *                               Ctrl+2 Report period (Alt+F2) · Alt+S Scenario · Alt+B Budget · Alt+E Export.
 */
import { useEffect, useMemo, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import { formatDrCr, formatMoney } from '../../../shared/format.ts';
import { BUDGET_BASES, BUDGET_LINE_KINDS } from '../../../shared/types/documents.ts';
import type { BudgetBasis, BudgetLineKind, BudgetRow, BudgetVarianceRow, ScenarioRow } from '../../../shared/types/documents.ts';
import type { CostCentreRow, VoucherTypeRow } from '../../../shared/types/accounts.ts';
import { api, ReportScreen, Screen, useApiMutation, useApiQuery, useCan, useConfirm, useNav, usePeriod, userMessage, useWorkingDate } from '../../app/index.ts';
import type { ScreenActionItem, ScreenProps } from '../../app/index.ts';
import {
  AmountInput,
  Badge,
  Banner,
  Button,
  Checkbox,
  DataTable,
  DateInput,
  EmptyState,
  Field,
  FieldGroup,
  Grid,
  Modal,
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
import { GroupPicker, LedgerPicker } from '../accounts/pickers.tsx';
import {
  BASIS_LABEL,
  budgetLinesForSave,
  DOCUMENTS_INVALIDATES,
  LINE_KIND_LABEL,
  NO_LEDGER_BASES,
  PROVISIONAL_BASES,
  scenarioProblem,
  toggleId,
  varianceDrill,
  varianceExport,
  variancePctText,
  varianceStatus,
} from './lib/model.ts';
import type { BudgetLineDraft } from './lib/model.ts';

const EMPTY_SCENARIOS: readonly ScenarioRow[] = [];
const EMPTY_BUDGETS: readonly BudgetRow[] = [];

function DialogKeys({ onAccept }: { onAccept: () => void }) {
  useHotkeys({ 'Ctrl+A': () => onAccept() });
  return null;
}

// ───────────────────────────── Scenarios ─────────────────────────────

export function ScenarioListScreen() {
  const toast = useToast();
  const confirm = useConfirm();
  const canCreate = useCan('masters.create');
  const canAlter = useCan('masters.alter');
  const canDelete = useCan('masters.delete');
  const q = useApiQuery('documents.scenario.list', {}, { keepPrevious: true });
  const rows = q.data ?? EMPTY_SCENARIOS;
  const [selected, setSelected] = useState<string | null>(null);
  const current = rows.find((r) => String(r.id) === selected) ?? rows[0] ?? null;
  const [editing, setEditing] = useState<ScenarioRow | 'new' | null>(null);
  const del = useApiMutation('documents.scenario.delete', { invalidates: DOCUMENTS_INVALIDATES });

  const columns = useMemo<Column<ScenarioRow>[]>(
    () => [
      { key: 'name', header: 'Scenario', minWidth: 200, sortable: true },
      { key: 'includeActuals', header: 'Actuals', width: 100, value: (r) => (r.includeActuals ? 'Included' : 'Left out') },
      { key: 'includeTypes', header: 'Adds provisional vouchers of', minWidth: 220, value: (r) => r.includeTypes.join(', ') || '—' },
      { key: 'excludeTypes', header: 'Leaves out', minWidth: 180, value: (r) => r.excludeTypes.join(', ') || '—' },
    ],
    [],
  );
  const remove = async () => {
    if (!current) return;
    if (!(await confirm({ title: `Delete scenario “${current.name}”?`, message: 'Reports run under it go back to the books. Vouchers are not touched.', confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      await del.mutate({ id: current.id });
      toast.success(`Scenario “${current.name}” deleted`);
      setSelected(null);
    } catch (err) {
      toast.error('Could not delete', { message: userMessage(err) });
    }
  };
  return (
    <Screen
      title="Scenarios"
      subtitle="Provisional reports: add memorandum vouchers, reversing journals and optional vouchers, or leave voucher types out"
      icon="layers"
      loading={q.loading}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Enter Alter · Alt+C Create Scenario · Alt+D Delete · Esc Back"
      actions={[
        { key: 'Alt+C', label: 'Create scenario', icon: 'plus', primary: true, onClick: () => setEditing('new'), hidden: !canCreate },
        { key: 'Alt+D', label: 'Delete', icon: 'trash', onClick: () => void remove(), disabled: !current, hidden: !canDelete, group: 'danger' },
      ]}
    >
      <Stack gap={3}>
        <DataTable<ScenarioRow>
          aria-label="Scenarios"
          autoFocus
          columns={columns}
          rows={rows}
          getRowKey={(r) => String(r.id)}
          selectedKey={current ? String(current.id) : null}
          onSelect={(k) => setSelected(k)}
          onRowActivate={(r) => canAlter && setEditing(r)}
          empty={
            <EmptyState
              icon="layers"
              title="No scenarios yet"
              body="Press Alt+C to create one — e.g. “Provisional” that adds your Memorandum and Reversing Journal vouchers to the Balance Sheet and P&L."
            />
          }
        />
        <p className="bx-muted">
          A reversing journal counts while the report date is on or before its “applicable up to” date. Scenarios never change the books, GST returns or
          outstanding — only the Trial Balance, P&L, Balance Sheet, Group Summary and Budget Variance run under them (Alt+S there).
        </p>
      </Stack>
      {editing ? <ScenarioDialog row={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(id) => setSelected(String(id))} /> : null}
    </Screen>
  );
}

function ScenarioDialog({ row, onClose, onSaved }: { row: ScenarioRow | null; onClose: () => void; onSaved: (id: number) => void }) {
  const toast = useToast();
  const types = useApiQuery('accounts.voucherType.list', {}, { staleTime: 60_000 });
  const save = useApiMutation('documents.scenario.save', { invalidates: DOCUMENTS_INVALIDATES });
  const [name, setName] = useState(row?.name ?? '');
  const [includeActuals, setIncludeActuals] = useState(row?.includeActuals ?? true);
  const [include, setInclude] = useState<number[]>(row?.includeTypeIds ?? []);
  const [exclude, setExclude] = useState<number[]>(row?.excludeTypeIds ?? []);
  const [problem, setProblem] = useState<{ field: string; message: string } | null>(null);
  const eligible = useMemo(() => (types.data?.rows ?? []).filter((t) => t.isActive && !NO_LEDGER_BASES.has(t.baseType)), [types.data]);
  const provisional = eligible.filter((t) => PROVISIONAL_BASES.has(t.baseType));
  const regular = eligible.filter((t) => !PROVISIONAL_BASES.has(t.baseType));

  const submit = async () => {
    if (save.pending) return;
    const p = scenarioProblem({ name, includeActuals, include, exclude });
    if (p) {
      setProblem(p);
      return;
    }
    try {
      const out = await save.mutate({ id: row?.id, name: name.trim(), includeActuals, includeTypeIds: include, excludeTypeIds: includeActuals ? exclude : [] });
      toast.success(`Scenario “${out.name}” saved`);
      onSaved(out.id);
      onClose();
    } catch {
      // save.fieldErrors / save.error below
    }
  };
  const err = (f: string) => (problem?.field === f ? problem.message : undefined) ?? save.fieldErrors[f];
  const ref = useEnterAdvance<HTMLDivElement>({ onComplete: () => void submit() });
  const typeBox = (t: VoucherTypeRow, list: number[], set: (v: number[]) => void, label: string) => (
    <Checkbox
      key={`${label}:${t.id}`}
      checked={list.includes(t.id)}
      onChange={() => {
        set(toggleId(list, t.id));
        setProblem(null);
      }}
      label={t.name}
    />
  );
  return (
    <Modal
      open
      onClose={onClose}
      title={row ? 'Scenario Alteration' : 'Scenario Creation'}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" loading={save.pending} onClick={() => void submit()}>
            Save
          </Button>
        </>
      }
    >
      <DialogKeys onAccept={() => void submit()} />
      <div ref={ref}>
        <Stack gap={3}>
          {save.error && Object.keys(save.fieldErrors).length === 0 ? <Banner tone="danger">{userMessage(save.error)}</Banner> : null}
          <Field label="Name" required error={err('name')}>
            <TextInput data-autofocus value={name} onValueChange={(v) => { setName(v); setProblem(null); }} maxLength={100} />
          </Field>
          <Field label="Include actuals" hint="Yes: the books plus the vouchers below. No: only the included provisional vouchers (e.g. a budget-style what-if).">
            <Switch checked={includeActuals} onChange={(v) => { setIncludeActuals(v); setProblem(null); }} aria-label="Include actuals" />
          </Field>
          <FieldGroup legend="Add provisional vouchers of" description="Memorandum and reversing journal vouchers, and optional vouchers of any type, that never post to the books.">
            {err('includeTypeIds') ? <Banner tone="danger">{err('includeTypeIds')}</Banner> : null}
            <Grid columns={3} gap={2}>
              {[...provisional, ...regular].map((t) => typeBox(t, include, setInclude, 'inc'))}
            </Grid>
          </FieldGroup>
          {includeActuals ? (
            <FieldGroup legend="Leave out regular vouchers of" description="E.g. leave out Journal to see the figures before year-end adjustments.">
              {err('excludeTypeIds') ? <Banner tone="danger">{err('excludeTypeIds')}</Banner> : null}
              <Grid columns={3} gap={2}>
                {regular.map((t) => typeBox(t, exclude, setExclude, 'exc'))}
              </Grid>
            </FieldGroup>
          ) : null}
        </Stack>
      </div>
    </Modal>
  );
}

// ───────────────────────────── Budgets ─────────────────────────────

export function BudgetListScreen() {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const canCreate = useCan('masters.create');
  const canDelete = useCan('masters.delete');
  const canFinancial = useCan('reports.financial');
  const q = useApiQuery('documents.budget.list', {}, { keepPrevious: true });
  const rows = q.data ?? EMPTY_BUDGETS;
  const [selected, setSelected] = useState<string | null>(null);
  const current = rows.find((r) => String(r.id) === selected) ?? rows[0] ?? null;
  const del = useApiMutation('documents.budget.delete', { invalidates: DOCUMENTS_INVALIDATES });
  const columns = useMemo<Column<BudgetRow>[]>(
    () => [
      { key: 'name', header: 'Budget', minWidth: 200, sortable: true },
      { key: 'from', header: 'From', kind: 'date', width: 110 },
      { key: 'to', header: 'To', kind: 'date', width: 110 },
      { key: 'lineCount', header: 'Lines', kind: 'number', width: 80 },
      { key: 'notes', header: 'Notes', minWidth: 200, value: (r) => r.notes ?? '' },
    ],
    [],
  );
  const remove = async () => {
    if (!current) return;
    if (!(await confirm({ title: `Delete budget “${current.name}”?`, message: 'Its lines go with it. The books are not touched.', confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      await del.mutate({ id: current.id });
      toast.success(`Budget “${current.name}” deleted`);
      setSelected(null);
    } catch (err) {
      toast.error('Could not delete', { message: userMessage(err) });
    }
  };
  return (
    <Screen
      title="Budgets"
      subtitle="Budgets for groups, ledgers and cost centres — compare them with the actuals in Budget Variance (Alt+V)"
      icon="chart"
      loading={q.loading}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Enter Alter · Alt+C Create Budget · Alt+V Variance · Alt+D Delete · Esc Back"
      actions={[
        { key: 'Alt+C', label: 'Create budget', icon: 'plus', primary: true, onClick: () => nav.push('documents.budget.form', {}), hidden: !canCreate },
        { key: 'Alt+V', label: 'Budget variance', icon: 'chart', onClick: () => current && nav.push('documents.budget.variance', { budgetId: current.id }), disabled: !current, hidden: !canFinancial },
        { key: 'Alt+D', label: 'Delete', icon: 'trash', onClick: () => void remove(), disabled: !current, hidden: !canDelete, group: 'danger' },
      ]}
    >
      <DataTable<BudgetRow>
        aria-label="Budgets"
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => String(r.id)}
        selectedKey={current ? String(current.id) : null}
        onSelect={(k) => setSelected(k)}
        onRowActivate={(r) => nav.push('documents.budget.form', { id: r.id })}
        empty={<EmptyState icon="chart" title="No budgets yet" body="Press Alt+C to create one — e.g. “FY 2026-27” with an expense budget per ledger and a sales target." />}
      />
    </Screen>
  );
}

const KIND_OPTIONS = BUDGET_LINE_KINDS.map((k) => ({ value: k, label: LINE_KIND_LABEL[k] }));
const BASIS_OPTIONS = BUDGET_BASES.map((b) => ({ value: b, label: BASIS_LABEL[b] }));
let lineSeq = 0;
const blankLine = (kind: BudgetLineKind = 'ledger', basis: BudgetBasis = 'net_transactions'): BudgetLineDraft => ({ key: `n${++lineSeq}`, kind, refId: null, name: '', basis, amount: null });

export function BudgetFormScreen({ params }: ScreenProps<{ id?: number }>) {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const period = usePeriod();
  const { date: workingDate } = useWorkingDate();
  const canAudit = useCan('audit.view');
  const canDelete = useCan('masters.delete');
  const isAlter = params.id !== undefined;
  const del = useApiMutation('documents.budget.delete', { invalidates: DOCUMENTS_INVALIDATES });
  const existing = useApiQuery('documents.budget.get', { id: params.id ?? 0 }, { enabled: isAlter, staleTime: 0 });
  const save = useApiMutation('documents.budget.save', { invalidates: DOCUMENTS_INVALIDATES });
  const [name, setName] = useState('');
  const [from, setFrom] = useState<string | null>(isAlter ? null : period.from);
  const [to, setTo] = useState<string | null>(isAlter ? null : period.to);
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<BudgetLineDraft[]>(() => [blankLine()]);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [problem, setProblem] = useState<{ key: string; message: string } | null>(null);

  useEffect(() => {
    const b = existing.data;
    if (!b) return;
    setName(b.name);
    setFrom(b.from);
    setTo(b.to);
    setNotes(b.notes ?? '');
    setLines([...b.lines.map((l) => ({ key: `n${++lineSeq}`, kind: l.kind, refId: l.refId, name: l.name, basis: l.basis, amount: l.amount })), blankLine()]);
    setTouched(false);
  }, [existing.data]);

  const patchLine = (key: string, p: Partial<BudgetLineDraft>) => {
    setLines((ls) => {
      const next = ls.map((l) => (l.key === key ? { ...l, ...p } : l));
      const last = next[next.length - 1];
      // Like a voucher grid: a blank line is always waiting at the end.
      return last.refId !== null ? [...next, blankLine(last.kind, last.basis)] : next;
    });
    setTouched(true);
    setProblem(null);
  };
  const removeLine = () => {
    if (!focusKey) return;
    setLines((ls) => {
      const next = ls.filter((l) => l.key !== focusKey);
      return next.length === 0 || next[next.length - 1].refId !== null ? [...next, blankLine()] : next;
    });
    setTouched(true);
  };

  const submit = async () => {
    if (save.pending) return;
    if (!name.trim()) {
      setProblem({ key: 'name', message: 'Give the budget a name (e.g. "FY 2026-27").' });
      return;
    }
    if (!from || !to || to < from) {
      setProblem({ key: 'to', message: 'Enter the budget period: the end date on or after the start date.' });
      return;
    }
    const { lines: out, problem: p } = budgetLinesForSave(lines);
    if (p) {
      setProblem(p);
      return;
    }
    try {
      const saved = await save.mutate({ id: params.id, name: name.trim(), from, to, notes: notes.trim() || undefined, lines: out });
      toast.success(`Budget “${saved.name}” saved`, { message: `${saved.lines.length} line${saved.lines.length === 1 ? '' : 's'} · ${formatDate(saved.from)} to ${formatDate(saved.to)}` });
      setTouched(false);
      nav.pop({ id: saved.id, name: saved.name });
    } catch {
      // shown below
    }
  };
  const remove = async () => {
    if (!isAlter || !existing.data) return;
    if (!(await confirm({ title: `Delete budget “${existing.data.name}”?`, message: 'Its lines go with it. The books are not touched.', confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      await del.mutate({ id: existing.data.id });
      setTouched(false);
      toast.success('Budget deleted');
      nav.pop();
    } catch (err) {
      toast.error('Could not delete', { message: userMessage(err) });
    }
  };

  const loadCentres = async (q: string, signal: AbortSignal): Promise<readonly CostCentreRow[]> => {
    const out = await api('accounts.costCentre.list', { search: q.trim() || undefined });
    return signal.aborted ? [] : out.rows;
  };

  const ref = useEnterAdvance<HTMLDivElement>({ onComplete: () => void submit() });
  const lineError = (key: string) => (problem?.key === key ? problem.message : undefined);
  const totals = lines.reduce((a, l) => ({ dr: a.dr + Math.max(0, l.amount ?? 0), cr: a.cr + Math.max(0, -(l.amount ?? 0)) }), { dr: 0, cr: 0 });

  return (
    <Screen
      title={isAlter ? 'Budget Alteration' : 'Budget Creation'}
      icon="chart"
      width="form"
      dirty={touched}
      loading={isAlter && existing.loading}
      error={isAlter ? existing.error : null}
      onRetry={() => void existing.refetch()}
      hint="Enter Next field · Ctrl+D Remove line · Ctrl+A Save · Esc Back"
      actions={[
        { key: 'Ctrl+A', label: 'Save', icon: 'save', primary: true, onClick: () => void submit() },
        { key: 'Ctrl+D', label: 'Remove line', icon: 'minus', onClick: removeLine, disabled: !focusKey },
        {
          key: 'Alt+H',
          label: 'Edit history',
          icon: 'clock',
          onClick: () => nav.push('security.audit', { entityType: 'budget', entityId: params.id }),
          hidden: !isAlter || !canAudit || !nav.isRegistered('security.audit'),
          group: 'output',
        },
        { key: 'Alt+D', label: 'Delete', icon: 'trash', onClick: () => void remove(), hidden: !isAlter || !canDelete, group: 'danger' },
      ]}
    >
      <div ref={ref}>
        <Stack gap={4}>
          {save.error && Object.keys(save.fieldErrors).length === 0 ? <Banner tone="danger">{userMessage(save.error)}</Banner> : null}
          <FieldGroup legend="Budget" columns={2}>
            <Field label="Name" required error={lineError('name') ?? save.fieldErrors.name}>
              <TextInput data-autofocus value={name} onValueChange={(v) => { setName(v); setTouched(true); setProblem(null); }} maxLength={100} />
            </Field>
            <Field label="Notes" optional>
              <TextInput value={notes} onValueChange={(v) => { setNotes(v); setTouched(true); }} maxLength={500} />
            </Field>
            <Field label="From" required error={save.fieldErrors.from}>
              <DateInput value={from} onChange={(d) => { setFrom(d); setTouched(true); }} referenceDate={workingDate} />
            </Field>
            <Field label="To" required error={lineError('to') ?? save.fieldErrors.to}>
              <DateInput value={to} onChange={(d) => { setTo(d); setTouched(true); }} referenceDate={workingDate} minDate={from ?? undefined} />
            </Field>
          </FieldGroup>
          <FieldGroup legend="Lines" description="Amounts are Dr or Cr (type d / c): an expense or asset budget is Dr, an income or liability budget Cr. Nett-transaction budgets are pro-rated by days when you report a shorter period.">
            <Stack gap={2}>
              {lines.map((l, i) => (
                <div key={l.key} className="bx-doc-budget-line" onFocus={() => setFocusKey(l.key)}>
                  <Grid columns="140px minmax(200px, 1fr) 190px 190px" gap={2}>
                    <Field label="Type" hideLabel={i > 0}>
                      <Select<BudgetLineKind> options={KIND_OPTIONS} value={l.kind} onChange={(v) => patchLine(l.key, { kind: v, refId: null, name: '' })} aria-label={`Line ${i + 1} type`} />
                    </Field>
                    <Field label={LINE_KIND_LABEL[l.kind]} hideLabel={i > 0} error={lineError(l.key) ?? save.fieldErrors[`lines[${i}].refId`]}>
                      {l.kind === 'ledger' ? (
                        <LedgerPicker value={l.refId} onChange={(id, row) => patchLine(l.key, { refId: id, name: row?.name ?? '' })} showBalance={false} allowCreate={false} aria-label={`Line ${i + 1} ledger`} />
                      ) : l.kind === 'group' ? (
                        <GroupPicker value={l.refId} onChange={(id, row) => patchLine(l.key, { refId: id, name: row?.name ?? '' })} allowCreate={false} aria-label={`Line ${i + 1} group`} />
                      ) : (
                        <Picker<CostCentreRow>
                          loadItems={loadCentres}
                          getKey={(c) => String(c.id)}
                          getLabel={(c) => c.name}
                          rightMeta={(c) => c.categoryName}
                          value={l.refId !== null ? ({ id: l.refId, name: l.name, categoryName: '' } as CostCentreRow) : null}
                          onChange={(c) => patchLine(l.key, { refId: c?.id ?? null, name: c?.name ?? '' })}
                          placeholder="Cost centre"
                        />
                      )}
                    </Field>
                    <Field label="Basis" hideLabel={i > 0}>
                      <Select<BudgetBasis> options={BASIS_OPTIONS} value={l.basis} onChange={(v) => patchLine(l.key, { basis: v })} aria-label={`Line ${i + 1} basis`} />
                    </Field>
                    <Field label="Amount" hideLabel={i > 0} error={save.fieldErrors[`lines[${i}].amount`]}>
                      <AmountInput value={l.amount} onChange={(v) => patchLine(l.key, { amount: v })} drcr aria-label={`Line ${i + 1} amount`} />
                    </Field>
                  </Grid>
                </div>
              ))}
              <p className="bx-muted">
                {lines.filter((l) => l.refId !== null).length} line(s) · Dr ₹ {formatMoney(totals.dr)} · Cr ₹ {formatMoney(totals.cr)}
              </p>
            </Stack>
          </FieldGroup>
        </Stack>
      </div>
    </Screen>
  );
}

// ───────────────────────────── Budget variance ─────────────────────────────

export interface BudgetVarianceParams {
  budgetId?: number;
}

export function BudgetVarianceScreen({ params }: ScreenProps<BudgetVarianceParams>) {
  const nav = useNav();
  const period = usePeriod();
  const budgets = useApiQuery('documents.budget.list', {}, { staleTime: 30_000 });
  const scenarios = useApiQuery('documents.scenario.list', {}, { staleTime: 30_000 });
  const list = budgets.data ?? EMPTY_BUDGETS;
  const [budgetId, setBudgetId] = useState<number | null>(params?.budgetId ?? null);
  const budget = list.find((b) => b.id === budgetId) ?? list[0] ?? null;
  const [useReportPeriod, setUseReportPeriod] = useState(false);
  const [scenarioId, setScenarioId] = useState<number | null>(null);
  const [picking, setPicking] = useState<'budget' | 'scenario' | null>(null);
  const range = budget ? (useReportPeriod ? { from: period.from, to: period.to } : { from: budget.from, to: budget.to }) : null;
  const q = useApiQuery(
    'documents.budget.variance',
    { budgetId: budget?.id ?? 0, ...(range ?? {}), ...(scenarioId !== null ? { scenarioId } : {}) },
    { enabled: budget !== null, keepPrevious: true },
  );
  const rows = q.data?.rows ?? [];
  const scenario = (scenarios.data ?? []).find((s) => s.id === scenarioId) ?? null;

  const columns = useMemo<Column<BudgetVarianceRow>[]>(
    () => [
      {
        key: 'name',
        header: 'Particulars',
        minWidth: 200,
        title: (r) => (r.inTotal === false ? `${r.under ?? r.name} — inside another budget line, not added to the total again` : (r.under ?? r.name)),
        render: (r) =>
          r.inTotal === false ? (
            <span>
              {r.name} <span className="bx-muted">(in total above)</span>
            </span>
          ) : (
            r.name
          ),
      },
      { key: 'kind', header: 'Type', width: 100, value: (r) => LINE_KIND_LABEL[r.kind] },
      { key: 'basis', header: 'Basis', width: 170, value: (r) => BASIS_LABEL[r.basis] },
      { key: 'budget', header: 'Budget', kind: 'drcr', width: 160 },
      { key: 'actual', header: 'Actual', kind: 'drcr', width: 160 },
      { key: 'variance', header: 'Variance', kind: 'drcr', width: 160 },
      { key: 'variancePct', header: 'Variance %', width: 110, align: 'right', value: (r) => r.variancePct ?? 0, render: (r) => <span className="bx-num">{variancePctText(r)}</span> },
      {
        key: 'status',
        header: 'Status',
        width: 130,
        value: (r) => varianceStatus(r).label,
        render: (r) => (
          <Badge tone={varianceStatus(r).tone} size="sm">
            {varianceStatus(r).label}
          </Badge>
        ),
      },
    ],
    [],
  );
  const t = q.data?.totals;
  const footer = useMemo<FooterRow[]>(
    () => (t && rows.length > 0 ? [{ key: 'total', tone: 'total', cells: { name: 'Total (each amount once)', budget: formatDrCr(t.budget), actual: formatDrCr(t.actual), variance: formatDrCr(t.variance) } }] : []),
    [t, rows.length],
  );
  const actions: ScreenActionItem[] = [
    { key: 'Ctrl+1', label: 'Budget period', icon: 'calendar', onClick: () => setUseReportPeriod(false), disabled: !useReportPeriod, group: 'view' },
    { key: 'Ctrl+2', label: 'Report period (Alt+F2)', icon: 'calendar', onClick: () => setUseReportPeriod(true), disabled: useReportPeriod, group: 'view' },
    { key: 'Alt+B', label: 'Choose budget', icon: 'chart', onClick: () => setPicking('budget'), disabled: list.length === 0, group: 'view' },
    { key: 'Alt+S', label: scenario ? `Scenario: ${scenario.name}` : 'Scenario', icon: 'layers', onClick: () => setPicking('scenario'), group: 'view' },
    { key: 'Alt+M', label: 'Alter budget', icon: 'edit', onClick: () => budget && nav.push('documents.budget.form', { id: budget.id }), disabled: !budget, group: 'go' },
  ];

  return (
    <ReportScreen
      title="Budget Variance"
      subtitle={
        budget && q.data
          ? `${budget.name} · ${formatDate(q.data.from)} to ${formatDate(q.data.to)}${q.data.proRata !== 1 ? ` · nett budgets × ${(q.data.proRata * 100).toFixed(2)}% of the budget period` : ''}${scenario ? ` · scenario ${scenario.name}` : ''}`
          : undefined
      }
      periodMode={useReportPeriod ? 'range' : 'none'}
      loading={budgets.loading || (budget !== null && q.loading)}
      refreshing={q.refreshing}
      error={budgets.error ?? q.error}
      onRetry={() => void (budgets.refetch(), q.refetch())}
      actions={actions}
      hint="Enter Drill down · Ctrl+1 Budget period · Ctrl+2 Report period · Alt+B Budget · Alt+S Scenario · Alt+E Export"
      exportDef={() => ({ subtitle: budget ? `${budget.name}${scenario ? ` · scenario ${scenario.name}` : ''}` : undefined, ...(range ? { period: range } : {}), ...varianceExport(rows) })}
    >
      {budget === null && !budgets.loading ? (
        <EmptyState icon="chart" title="No budgets yet" body="Create a budget under Gateway › Masters › Budgets, then compare it with the actuals here." />
      ) : (
        <DataTable<BudgetVarianceRow>
          aria-label="Budget variance"
          autoFocus
          columns={columns}
          rows={rows}
          getRowKey={(r) => r.key}
          onRowActivate={(r) => {
            if (!range) return;
            const d = varianceDrill(r, range.from, range.to, scenarioId);
            nav.push(d.screen, d.params);
          }}
          footerRows={footer.length > 0 ? footer : undefined}
          loading={q.loading}
          empty={<EmptyState icon="chart" title="This budget has no lines" body="Alter it (Alt+M) to add groups, ledgers or cost centres." />}
        />
      )}
      {picking === 'budget' ? (
        <ChoiceDialog
          title="Choose budget"
          options={list.map((b) => ({ value: String(b.id), label: `${b.name} (${formatDate(b.from)} – ${formatDate(b.to)})` }))}
          value={budget ? String(budget.id) : ''}
          onClose={() => setPicking(null)}
          onChoose={(v) => {
            setBudgetId(v ? Number(v) : null);
            setPicking(null);
          }}
        />
      ) : null}
      {picking === 'scenario' ? (
        <ChoiceDialog
          title="Scenario"
          options={[{ value: '', label: 'None — the books' }, ...(scenarios.data ?? []).map((s) => ({ value: String(s.id), label: s.name }))]}
          value={scenarioId !== null ? String(scenarioId) : ''}
          onClose={() => setPicking(null)}
          onChoose={(v) => {
            setScenarioId(v ? Number(v) : null);
            setPicking(null);
          }}
        />
      ) : null}
    </ReportScreen>
  );
}

/** A short Select in a dialog (Enter / Ctrl+A choose, Esc cancel). */
export function ChoiceDialog({ title, options, value, onClose, onChoose }: { title: string; options: ReadonlyArray<{ value: string; label: string }>; value: string; onClose: () => void; onChoose: (v: string) => void }) {
  const [v, setV] = useState(value);
  const ref = useEnterAdvance<HTMLDivElement>({ onComplete: () => onChoose(v) });
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" onClick={() => onChoose(v)}>
            Choose
          </Button>
        </>
      }
    >
      <DialogKeys onAccept={() => onChoose(v)} />
      <div ref={ref}>
        <Field label={title}>
          <Select options={options} value={v} onChange={setV} data-autofocus />
        </Field>
      </div>
    </Modal>
  );
}
