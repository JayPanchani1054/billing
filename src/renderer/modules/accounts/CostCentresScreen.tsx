/**
 * 'accounts.costCentres' (F11 cost centres) — cost categories on the left, the centre tree of the
 * chosen category on the right. Enter alters, Alt+C creates a centre (under the highlighted one),
 * Alt+N a category, Alt+D (or Ctrl+D) deletes the highlighted centre (or category when that list has focus).
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { CostCategoryRow, CostCentreRow } from '../../../shared/types/accounts.ts';
import { api } from '../../app/api.ts';
import { useConfirm } from '../../app/confirm.tsx';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { fieldErrorsOf, userMessage } from '../../app/lib/apiErrors.ts';
import { invalidate } from '../../app/queryClient.ts';
import { Screen } from '../../app/Screen.tsx';
import { useCan } from '../../app/state.tsx';
import { Button, DataTable, EmptyState, Field, Modal, Select, Stack, Switch, TextInput, useDebouncedValue, useEnterAdvance, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { DialogAccept, NameCell } from './components.tsx';

type Pane = 'categories' | 'centres';

export function CostCentresScreen() {
  const toast = useToast();
  const confirm = useConfirm();
  const canCreate = useCan('masters.create');
  const canAlter = useCan('masters.alter');
  const canDelete = useCan('masters.delete');
  const cats = useApiQuery('accounts.costCategory.list', {}, { keepPrevious: true });
  const categories = cats.data?.rows ?? [];
  const [catKey, setCatKey] = useState<string | null>(null);
  const category = categories.find((c) => String(c.id) === catKey) ?? categories[0] ?? null;
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search.trim(), 150);
  const centres = useApiQuery('accounts.costCentre.list', { categoryId: category?.id, search: debounced || undefined }, { enabled: category !== null, keepPrevious: true });
  const rows = centres.data?.rows ?? [];
  const [centreKey, setCentreKey] = useState<string | null>(null);
  const centre = rows.find((r) => String(r.id) === centreKey) ?? null;
  const [pane, setPane] = useState<Pane>('centres');
  const [catDialog, setCatDialog] = useState<CostCategoryRow | 'new' | null>(null);
  const [centreDialog, setCentreDialog] = useState<{ row: CostCentreRow | null; parentId: number | null } | null>(null);

  const catColumns = useMemo<Column<CostCategoryRow>[]>(
    () => [
      { key: 'name', header: 'Category', render: (r) => <NameCell name={r.name} predefined={r.isPredefined} /> },
      { key: 'centreCount', header: 'Centres', kind: 'number', width: 90 },
    ],
    [],
  );
  const centreColumns = useMemo<Column<CostCentreRow>[]>(
    () => [
      { key: 'name', header: 'Cost centre', tree: true, render: (r) => <NameCell name={r.name} alias={r.alias} />, title: (r) => r.path.join(' › ') },
      { key: 'parentName', header: 'Under', width: 200, value: (r) => r.parentName ?? 'Primary' },
      { key: 'childCount', header: 'Sub-centres', kind: 'number', width: 110, blankZero: true },
    ],
    [],
  );

  const remove = async () => {
    if (pane === 'categories') {
      if (!category) return;
      if (!(await confirm({ title: `Delete category “${category.name}”?`, message: 'Only a category without cost centres can be deleted.', confirmLabel: 'Delete', tone: 'danger' }))) return;
      try {
        await api('accounts.costCategory.delete', { id: category.id });
        invalidate('accounts');
        toast.success(`Category “${category.name}” deleted`);
        setCatKey(null);
      } catch (err) {
        toast.error(`“${category.name}” cannot be deleted`, { message: userMessage(err), duration: 10_000 });
      }
      return;
    }
    if (!centre) return;
    if (!(await confirm({ title: `Delete cost centre “${centre.name}”?`, message: 'Only a centre without sub-centres and without amounts allocated in vouchers can be deleted.', confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      await api('accounts.costCentre.delete', { id: centre.id });
      invalidate('accounts');
      toast.success(`Cost centre “${centre.name}” deleted`);
    } catch (err) {
      toast.error(`“${centre.name}” cannot be deleted`, { message: userMessage(err), duration: 10_000 });
    }
  };

  return (
    <Screen
      title="Cost Centres"
      subtitle="Track income and expenses by branch, project, department or person."
      icon="layers"
      loading={cats.loading}
      error={cats.error}
      onRetry={() => void cats.refetch()}
      hint="Enter Alter · Alt+C Create Centre · Alt+N Create Category · Alt+D Delete · Esc Back"
      actions={[
        { key: 'Alt+C', label: 'Create centre', icon: 'plus', primary: true, disabled: !canCreate || !category, onClick: () => setCentreDialog({ row: null, parentId: centre?.id ?? null }) },
        { key: 'Alt+N', label: 'Create category', icon: 'layers', disabled: !canCreate, onClick: () => setCatDialog('new') },
        { key: 'Alt+D, Ctrl+D', label: 'Delete', icon: 'trash', group: 'danger', disabled: !canDelete || (pane === 'centres' ? !centre : !category), onClick: () => void remove() },
      ]}
    >
      <div className="bx-acc-split">
        <div className="bx-acc-pane" onFocus={() => setPane('categories')}>
          <strong>Categories</strong>
          <div className="bx-acc-pane__table">
            <DataTable<CostCategoryRow>
              aria-label="Cost categories"
              columns={catColumns}
              rows={categories}
              getRowKey={(r) => String(r.id)}
              selectedKey={category ? String(category.id) : null}
              onSelect={(k) => setCatKey(k)}
              onRowActivate={(r) => canAlter && setCatDialog(r)}
              empty={<EmptyState title="No categories" body="Press Alt+N to create one." size="sm" />}
            />
          </div>
        </div>
        <div className="bx-acc-pane" onFocus={() => setPane('centres')}>
          <div className="bx-acc-toolbar">
            <strong>{category ? `Centres in ${category.name}` : 'Centres'}</strong>
            <TextInput size="sm" wrapperClassName="bx-acc-toolbar__search" value={search} onChange={(e) => setSearch(e.target.value)} leadingIcon="search" placeholder="Find a cost centre" aria-label="Find a cost centre" />
          </div>
          <div className="bx-acc-pane__table">
            <DataTable<CostCentreRow>
              aria-label="Cost centres"
              autoFocus
              columns={centreColumns}
              rows={rows}
              getRowKey={(r) => String(r.id)}
              getRowLevel={(r) => (debounced ? 0 : r.depth)}
              expandable={!debounced}
              selectedKey={centreKey}
              onSelect={(k) => setCentreKey(k)}
              onRowActivate={(r) => canAlter && setCentreDialog({ row: r, parentId: r.parentId })}
              loading={centres.loading}
              empty={
                <EmptyState
                  icon="layers"
                  title={search.trim() ? 'No centre matches' : 'No cost centres yet'}
                  body={search.trim() ? 'Change the search.' : 'Press Alt+C to create one — e.g. a branch, project or department.'}
                  size="sm"
                  action={canCreate && category && !search.trim() ? <Button icon="plus" onClick={() => setCentreDialog({ row: null, parentId: null })}>Create centre</Button> : undefined}
                />
              }
            />
          </div>
        </div>
      </div>
      {catDialog ? <CategoryDialog row={catDialog === 'new' ? null : catDialog} onClose={() => setCatDialog(null)} onSaved={(id) => setCatKey(String(id))} /> : null}
      {centreDialog && category ? (
        <CentreDialog row={centreDialog.row} categoryId={category.id} categories={categories} parentId={centreDialog.parentId} onClose={() => setCentreDialog(null)} onSaved={(id) => setCentreKey(String(id))} />
      ) : null}
    </Screen>
  );
}

function CategoryDialog({ row, onClose, onSaved }: { row: CostCategoryRow | null; onClose: () => void; onSaved: (id: number) => void }) {
  const toast = useToast();
  const save = useApiMutation('accounts.costCategory.save');
  const [name, setName] = useState(row?.name ?? '');
  const [revenue, setRevenue] = useState(row?.allocateRevenue ?? true);
  const [nonRevenue, setNonRevenue] = useState(row?.allocateNonRevenue ?? false);
  const [error, setError] = useState<string | null>(null);
  const submit = useCallback(async () => {
    if (save.pending) return;
    if (!name.trim()) {
      setError('Enter the category name');
      return;
    }
    try {
      const out = await save.mutate({ id: row?.id, name: name.trim(), allocateRevenue: revenue, allocateNonRevenue: nonRevenue });
      toast.success(`Category “${out.name}” saved`);
      onSaved(out.id);
      onClose();
    } catch (err) {
      setError(fieldErrorsOf(err).name ?? userMessage(err));
    }
  }, [name, revenue, nonRevenue, row, save, toast, onSaved, onClose]);
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => void submit() });
  return (
    <Modal
      open
      onClose={onClose}
      title={row ? 'Alter Cost Category' : 'Create Cost Category'}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.pending} onClick={() => void submit()} shortcut="Ctrl+A">
            Save
          </Button>
        </>
      }
    >
      <DialogAccept onAccept={() => void submit()} />
      <div ref={formRef}>
        <Stack gap={3}>
          <Field label="Name" required error={error ?? undefined}>
            <TextInput data-autofocus value={name} onChange={(e) => setName(e.target.value)} maxLength={100} readOnly={row?.isPredefined} />
          </Field>
          <Field label="Allocate revenue items" hint="Income and expenses in Profit & Loss.">
            <Switch checked={revenue} onChange={setRevenue} aria-label="Allocate revenue items" />
          </Field>
          <Field label="Allocate non-revenue items" hint="Assets and liabilities (e.g. capital spending per project).">
            <Switch checked={nonRevenue} onChange={setNonRevenue} aria-label="Allocate non-revenue items" />
          </Field>
        </Stack>
      </div>
    </Modal>
  );
}

function CentreDialog({
  row,
  categoryId,
  categories,
  parentId,
  onClose,
  onSaved,
}: {
  row: CostCentreRow | null;
  categoryId: number;
  categories: readonly CostCategoryRow[];
  parentId: number | null;
  onClose: () => void;
  onSaved: (id: number) => void;
}) {
  const toast = useToast();
  const save = useApiMutation('accounts.costCentre.save');
  const [name, setName] = useState(row?.name ?? '');
  const [alias, setAlias] = useState(row?.alias ?? '');
  const [category, setCategory] = useState(row?.categoryId ?? categoryId);
  const [parent, setParent] = useState<number | null>(row ? row.parentId : parentId);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const peers = useApiQuery('accounts.costCentre.list', { categoryId: category });
  const self = row?.id ?? null;
  const peerRows = peers.data?.rows ?? [];
  // A centre cannot be moved under itself or one of its own sub-centres.
  const blocked = new Set<number>();
  if (self !== null) {
    blocked.add(self);
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of peerRows) if (c.parentId !== null && blocked.has(c.parentId) && !blocked.has(c.id)) {
        blocked.add(c.id);
        grew = true;
      }
    }
  }
  const parentOptions = peerRows.filter((c) => !blocked.has(c.id)).map((c) => ({ value: String(c.id), label: `${'· '.repeat(c.depth)}${c.name}` }));
  const submitRef = useRef<() => Promise<void>>(async () => undefined);
  const submit = async () => {
    if (save.pending) return;
    if (!name.trim()) {
      setErrors({ name: 'Enter the cost centre name' });
      return;
    }
    try {
      const out = await save.mutate({ id: row?.id, name: name.trim(), alias: alias.trim() || null, categoryId: category, parentId: parent });
      toast.success(`Cost centre “${out.name}” saved`);
      onSaved(out.id);
      onClose();
    } catch (err) {
      const f = fieldErrorsOf(err);
      setErrors(Object.keys(f).length > 0 ? f : { name: userMessage(err) });
    }
  };
  submitRef.current = submit;
  const accept = useCallback(() => void submitRef.current(), []);
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: accept });
  return (
    <Modal
      open
      onClose={onClose}
      title={row ? 'Alter Cost Centre' : 'Create Cost Centre'}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.pending} onClick={accept} shortcut="Ctrl+A">
            Save
          </Button>
        </>
      }
    >
      <DialogAccept onAccept={accept} />
      <div ref={formRef}>
        <Stack gap={3}>
          <Field label="Name" required error={errors.name}>
            <TextInput data-autofocus value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          </Field>
          <Field label="Alias" optional error={errors.alias}>
            <TextInput value={alias} onChange={(e) => setAlias(e.target.value)} maxLength={100} />
          </Field>
          <Field label="Category" error={errors.categoryId} hint={row && row.childCount > 0 ? 'Changing the category moves the sub-centres too.' : undefined}>
            <Select
              value={String(category)}
              onChange={(v) => {
                setCategory(Number(v));
                setParent(null);
              }}
              options={categories.map((c) => ({ value: String(c.id), label: c.name }))}
            />
          </Field>
          <Field label="Under" error={errors.parentId}>
            <Select value={parent === null ? '' : String(parent)} onChange={(v) => setParent(v === '' ? null : Number(v))} options={[{ value: '', label: 'Primary (top level)' }, ...parentOptions]} />
          </Field>
        </Stack>
      </div>
    </Modal>
  );
}
