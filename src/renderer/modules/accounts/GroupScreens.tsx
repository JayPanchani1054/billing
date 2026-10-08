/**
 * 'accounts.group.list' — the group tree (built-in and your own groups) with ledger counts.
 *   Enter alter · Alt+C create (under the highlighted group) · Ctrl+D delete · Alt+E export.
 * 'accounts.group.form' — Group Creation / Alteration.
 *   Params { id? | initialName?, parentId?, forResult? }. Opened for a result (Alt+C in a group
 *   picker) it saves and returns { id, name }; otherwise create keeps the form open for the next.
 */
import { useMemo, useRef, useState } from 'react';
import type { GroupNature } from '../../../shared/constants.ts';
import { formatIndianNumber } from '../../../shared/format.ts';
import type { GroupDetail, GroupRow } from '../../../shared/types/accounts.ts';
import { api } from '../../app/api.ts';
import { useConfirm } from '../../app/confirm.tsx';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { fieldErrorsOf, userMessage } from '../../app/lib/apiErrors.ts';
import { useNav, useScreenResult } from '../../app/nav.tsx';
import { invalidate } from '../../app/queryClient.ts';
import type { ScreenProps } from '../../app/registry.ts';
import { ReadOnlyNotice, ReportScreen, Screen } from '../../app/Screen.tsx';
import { useCan } from '../../app/state.tsx';
import { Badge, Banner, Button, DataTable, EmptyState, Field, FieldGroup, NumberInput, Select, Stack, Switch, TextInput, useDebouncedValue, useEnterAdvance, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { focusFirstInvalid, NameCell } from './components.tsx';
import { LEDGER_DEPENDENTS } from './hooks.ts';
import { NATURE_LABELS, natureHint } from './lib/groupClass.ts';
import { GroupPicker, groupTrail, useGroups } from './pickers.tsx';

// ───────────────────────────── List ─────────────────────────────

export function GroupListScreen() {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const canCreate = useCan('masters.create');
  const canDelete = useCan('masters.delete');
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search.trim(), 150);
  const q = useApiQuery('accounts.group.list', { includeCounts: true, search: debounced || undefined }, { keepPrevious: true });
  const rows = q.data?.rows ?? [];
  const [cursor, setCursor] = useState<string | null>(null);
  const current = rows.find((r) => String(r.id) === cursor) ?? null;

  const columns = useMemo<Column<GroupRow>[]>(
    () => [
      { key: 'name', header: 'Group', tree: true, render: (r) => <NameCell name={r.name} alias={r.alias} predefined={r.isPredefined} />, title: (r) => r.path.join(' › ') },
      { key: 'nature', header: 'Nature', width: 120, value: (r) => NATURE_LABELS[r.nature] },
      { key: 'gp', header: 'Gross profit', width: 120, value: (r) => (r.nature === 'income' || r.nature === 'expenses' ? (r.affectsGrossProfit ? 'Affects' : '—') : '') },
      { key: 'totalLedgerCount', header: 'Ledgers', kind: 'number', width: 100, blankZero: true },
    ],
    [],
  );

  const remove = async () => {
    if (!current) return;
    if (current.isPredefined) {
      toast.info(`“${current.name}” is a built-in group`, { message: 'Built-in groups cannot be deleted. You may give them an alias.' });
      return;
    }
    if (!(await confirm({ title: `Delete group “${current.name}”?`, message: 'Only an empty group (no sub-groups, no ledgers) can be deleted.', confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      await api('accounts.group.delete', { id: current.id });
      invalidate('accounts');
      invalidate('reports');
      toast.success(`Group “${current.name}” deleted`);
    } catch (err) {
      toast.error(`“${current.name}” cannot be deleted`, { message: userMessage(err), duration: 10_000 });
    }
  };

  return (
    <ReportScreen
      title="Groups"
      subtitle={q.data ? `${formatIndianNumber(q.data.total, 0)} groups` : undefined}
      periodMode="none"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Enter Alter · Alt+C Create · Ctrl+D Delete · Alt+E Export · Esc Back"
      actions={[
        {
          key: 'Alt+C',
          label: 'Create group',
          icon: 'plus',
          primary: true,
          disabled: !canCreate,
          onClick: () => nav.push('accounts.group.form', current ? { parentId: current.id } : {}),
        },
        { key: 'Ctrl+D', label: 'Delete', icon: 'trash', onClick: () => void remove(), disabled: !canDelete || !current, group: 'danger' },
        { key: 'Alt+H', label: 'Chart of accounts', icon: 'layers', onClick: () => nav.push('accounts.chart'), group: 'more' },
      ]}
      filters={<TextInput size="sm" wrapperClassName="bx-acc-toolbar__search" value={search} onChange={(e) => setSearch(e.target.value)} leadingIcon="search" placeholder="Find a group" aria-label="Find a group" />}
      exportDef={() => ({
        columns: [{ header: 'Group' }, { header: 'Under' }, { header: 'Nature' }, { header: 'Ledgers', kind: 'number' }],
        rows: rows.map((r) => [r.name, r.parentName ?? 'Primary', NATURE_LABELS[r.nature], r.totalLedgerCount ?? 0]),
        levels: rows.map((r) => r.depth),
      })}
    >
      <DataTable<GroupRow>
        aria-label="Groups"
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => String(r.id)}
        getRowLevel={(r) => (debounced ? 0 : r.depth)}
        isGroupRow={(r) => r.parentId === null}
        expandable={!debounced}
        defaultExpanded="all"
        selectedKey={cursor}
        onSelect={(k) => setCursor(k)}
        onRowActivate={(r) => nav.push('accounts.group.form', { id: r.id })}
        loading={q.loading}
        empty={<EmptyState icon="search" title="No group matches" body="Change the search, or press Alt+C to create the group." />}
      />
    </ReportScreen>
  );
}

// ───────────────────────────── Form ─────────────────────────────

export interface GroupFormParams {
  id?: number;
  initialName?: string;
  parentId?: number;
  forResult?: boolean;
}

export function GroupFormScreen({ params }: ScreenProps<GroupFormParams>) {
  const isAlter = typeof params.id === 'number';
  const q = useApiQuery('accounts.group.get', { id: params.id ?? 0 }, { enabled: isAlter });
  if (isAlter && !q.data) return <Screen title="Group Alteration" icon="layers" width="form" loading={q.loading} error={q.error} onRetry={() => void q.refetch()} />;
  return <GroupForm key={q.data ? `${q.data.id}:${q.data.updatedAt}` : 'new'} original={q.data ?? null} params={params} />;
}

interface GroupDraft {
  name: string;
  alias: string;
  parentId: number | null;
  nature: GroupNature | '';
  affectsGrossProfit: boolean;
  isSubledger: boolean;
  netBalances: boolean;
  usedForCalculation: boolean;
  sortOrder: number | null;
}

const NATURE_OPTIONS: ReadonlyArray<{ value: GroupNature; label: string }> = [
  { value: 'assets', label: 'Assets' },
  { value: 'liabilities', label: 'Liabilities' },
  { value: 'income', label: 'Income' },
  { value: 'expenses', label: 'Expenses' },
];

function draftOf(g: GroupDetail | null, params: GroupFormParams): GroupDraft {
  if (!g) {
    return {
      name: params.initialName ?? '',
      alias: '',
      parentId: typeof params.parentId === 'number' ? params.parentId : null,
      nature: '',
      affectsGrossProfit: false,
      isSubledger: false,
      netBalances: false,
      usedForCalculation: false,
      sortOrder: null,
    };
  }
  return {
    name: g.name,
    alias: g.alias ?? '',
    parentId: g.parentId,
    nature: g.nature,
    affectsGrossProfit: g.affectsGrossProfit,
    isSubledger: g.isSubledger,
    netBalances: g.netBalances,
    usedForCalculation: g.usedForCalculation,
    sortOrder: g.sortOrder,
  };
}

function GroupForm({ original, params }: { original: GroupDetail | null; params: GroupFormParams }) {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const { forResult, returnResult } = useScreenResult<{ id: number; name: string }>();
  const canSave = useCan(original ? 'masters.alter' : 'masters.create');
  const canDelete = useCan('masters.delete');
  const groups = useGroups();
  const save = useApiMutation('accounts.group.save', { invalidates: [...LEDGER_DEPENDENTS] });
  const baselineRef = useRef(draftOf(original, params));
  const [d, setD] = useState<GroupDraft>(baselineRef.current);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState(0);
  const nameRef = useRef<HTMLInputElement>(null);
  const formBox = useRef<HTMLDivElement>(null);
  const predefined = original?.isPredefined ?? false;
  const readOnly = !canSave;
  const parent = d.parentId !== null ? (groups.byId.get(d.parentId) ?? null) : null;
  const nature: GroupNature | '' = parent ? parent.nature : d.nature;
  const primary = d.parentId === null;
  const showGp = primary && (nature === 'income' || nature === 'expenses');
  const dirty = JSON.stringify(d) !== JSON.stringify(baselineRef.current);

  const set = <K extends keyof GroupDraft>(k: K, v: GroupDraft[K]) => {
    setD((x) => ({ ...x, [k]: v }));
    setErrors((e) => {
      if (!(k in e)) return e;
      const copy = { ...e };
      delete copy[k];
      return copy;
    });
  };

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (!d.name.trim()) e.name = 'Enter the group name';
    if (primary && !predefined && d.nature === '') e.nature = 'A primary group needs a nature: assets, liabilities, income or expenses';
    if (d.alias.trim() && d.alias.trim().toLowerCase() === d.name.trim().toLowerCase()) e.alias = 'The alias is the same as the name — leave it blank';
    return e;
  };

  const submit = async (mode: 'default' | 'close' = 'default') => {
    if (readOnly || save.pending) return;
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length > 0) {
      focusFirstInvalid(formBox.current);
      return;
    }
    const base = baselineRef.current;
    const input: Parameters<typeof save.mutate>[0] = original ? { id: original.id } : {};
    const put = <K extends keyof GroupDraft>(k: K, apply: () => void) => {
      if (!original || JSON.stringify(d[k]) !== JSON.stringify(base[k])) apply();
    };
    put('name', () => (input.name = d.name.trim()));
    put('alias', () => (input.alias = d.alias.trim() || null));
    if (!predefined) {
      put('parentId', () => (input.parentId = d.parentId));
      if (primary) put('nature', () => d.nature !== '' && (input.nature = d.nature));
      if (showGp) put('affectsGrossProfit', () => (input.affectsGrossProfit = d.affectsGrossProfit));
    }
    put('isSubledger', () => (input.isSubledger = d.isSubledger));
    put('netBalances', () => (input.netBalances = d.netBalances));
    put('usedForCalculation', () => (input.usedForCalculation = d.usedForCalculation));
    put('sortOrder', () => d.sortOrder !== null && (input.sortOrder = d.sortOrder));
    if (original && Object.keys(input).length === 1) {
      nav.pop();
      return;
    }
    try {
      const out = await save.mutate(input);
      toast.success(`Group “${out.name}” ${original ? 'saved' : 'created'}`);
      if (forResult) returnResult({ id: out.id, name: out.name });
      else if (original || mode === 'close') nav.pop();
      else {
        const fresh = draftOf(null, { parentId: d.parentId ?? undefined });
        baselineRef.current = fresh;
        setD(fresh);
        setCreated((n) => n + 1);
        nameRef.current?.focus();
      }
    } catch (err) {
      const f = fieldErrorsOf(err);
      if (Object.keys(f).length > 0) {
        setErrors(f);
        focusFirstInvalid(formBox.current);
      }
      toast.error('The group was not saved', { message: Object.values(f)[0] ?? userMessage(err) });
    }
  };

  const remove = async () => {
    if (!original) return;
    if (!(await confirm({ title: `Delete group “${original.name}”?`, message: 'Only an empty group (no sub-groups, no ledgers) can be deleted.', confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      await api('accounts.group.delete', { id: original.id });
      invalidate('accounts');
      toast.success(`Group “${original.name}” deleted`);
      nav.pop();
    } catch (err) {
      toast.error(`“${original.name}” cannot be deleted`, { message: userMessage(err), duration: 10_000 });
    }
  };

  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => void submit() });
  const saveLabel = forResult ? 'Save & return' : original ? 'Save' : 'Save & create next';

  return (
    <Screen
      title={original ? 'Group Alteration' : 'Group Creation'}
      subtitle={
        original
          ? `${original.path.join(' › ')} · ${formatIndianNumber(original.totalLedgerCount, 0)} ledger${original.totalLedgerCount === 1 ? '' : 's'}`
          : created > 0
            ? `${created} created in this session`
            : 'Groups arrange ledgers for the Balance Sheet and Profit & Loss.'
      }
      icon="layers"
      width="form"
      dirty={dirty}
      meta={predefined ? <Badge tone="neutral" variant="outline">Built-in</Badge> : undefined}
      hint={`Enter Next field · Ctrl+A ${saveLabel} · Esc Back`}
      actions={[
        { key: 'Ctrl+A', label: saveLabel, icon: 'save', primary: true, onClick: () => void submit(), disabled: readOnly },
        { key: 'Alt+S', label: 'Save & close', icon: 'check', onClick: () => void submit('close'), hidden: !!original || forResult || readOnly },
        { key: 'Alt+D', label: 'Delete', icon: 'trash', onClick: () => void remove(), hidden: !original || predefined || !canDelete, group: 'danger' },
      ]}
      footer={
        readOnly ? undefined : (
          <>
            <Button onClick={() => void nav.back()}>Cancel</Button>
            <Button variant="primary" icon="save" loading={save.pending} onClick={() => void submit()} shortcut="Ctrl+A">
              {saveLabel}
            </Button>
          </>
        )
      }
    >
      <div ref={formBox}>
      <div ref={formRef}>
        <Stack gap={6}>
          {readOnly ? <ReadOnlyNotice what="groups" /> : null}
          {predefined ? (
            <Banner tone="info" inline>
              This is a built-in group: its name, position and nature are fixed. You can give it an alias and change how it is shown.
            </Banner>
          ) : null}
          <FieldGroup legend="Group" columns={2}>
            <Field label="Name" required error={errors.name || undefined}>
              <TextInput ref={nameRef} data-autofocus value={d.name} onChange={(e) => set('name', e.target.value)} readOnly={readOnly || predefined} maxLength={100} placeholder="e.g. Mumbai Customers, Office Expenses" />
            </Field>
            <Field label="Alias" optional error={errors.alias || undefined}>
              <TextInput value={d.alias} onChange={(e) => set('alias', e.target.value)} readOnly={readOnly} maxLength={100} />
            </Field>
            <Field
              label="Under"
              error={errors.parentId || undefined}
              hint={parent ? `${groupTrail(parent) ? `${groupTrail(parent)} › ` : ''}${parent.name} · ${natureHint(parent.nature, parent.affectsGrossProfit)}` : 'Leave blank for a primary group (top level).'}
            >
              <GroupPicker value={d.parentId} onChange={(id) => set('parentId', id)} excludeSubtreeOf={original?.id ?? null} allowCreate={false} readOnly={readOnly || predefined} placeholder="Primary (top level)" />
            </Field>
            {primary ? (
              <Field label="Nature" required={!predefined} error={errors.nature || undefined} hint={nature ? natureHint(nature, d.affectsGrossProfit) : 'Where its ledgers appear in the final accounts.'}>
                <Select<GroupNature> value={d.nature} onChange={(v) => set('nature', v)} disabled={readOnly || predefined} placeholder="Choose…" options={NATURE_OPTIONS} />
              </Field>
            ) : (
              <Field label="Nature" hint="Taken from the parent group.">
                <TextInput value={nature ? NATURE_LABELS[nature] : ''} readOnly tabIndex={-1} />
              </Field>
            )}
            {showGp ? (
              <Field label="Affects gross profit" hint="Yes for trading items (direct income/expenses) shown above gross profit.">
                <Switch checked={d.affectsGrossProfit} onChange={(v) => set('affectsGrossProfit', v)} disabled={readOnly || predefined} aria-label="Affects gross profit" />
              </Field>
            ) : null}
          </FieldGroup>
          <FieldGroup legend="Display and behaviour" columns={2}>
            <Field label="Behaves like a sub-ledger" hint="Reports show the group total instead of its ledgers.">
              <Switch checked={d.isSubledger} onChange={(v) => set('isSubledger', v)} disabled={readOnly} aria-label="Behaves like a sub-ledger" />
            </Field>
            <Field label="Net debit/credit balances" hint="Show one net balance in reports instead of separate debit and credit totals.">
              <Switch checked={d.netBalances} onChange={(v) => set('netBalances', v)} disabled={readOnly} aria-label="Net debit/credit balances" />
            </Field>
            <Field label="Used for calculation" hint="For groups of ledgers that compute on invoices, e.g. taxes and discounts.">
              <Switch checked={d.usedForCalculation} onChange={(v) => set('usedForCalculation', v)} disabled={readOnly} aria-label="Used for calculation" />
            </Field>
            <Field label="Position in reports" optional hint="Lower numbers are listed first among groups at the same level.">
              <NumberInput value={d.sortOrder} onChange={(v) => set('sortOrder', v)} min={0} max={9999} readOnly={readOnly} />
            </Field>
          </FieldGroup>
        </Stack>
      </div>
      </div>
    </Screen>
  );
}
