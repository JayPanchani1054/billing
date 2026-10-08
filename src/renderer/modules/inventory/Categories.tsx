/**
 * Stock categories (a second, independent classification of items — e.g. brand or size):
 * 'inventory.category.list' and 'inventory.category.form' (dialog;
 * params { id?, initialName?, forResult?, parentId? } — returns { id, name } for a result).
 */
import { useMemo, useState } from 'react';
import type { StockCategoryDto } from '../../../shared/types/inventory.ts';
import {
  DialogScreen,
  Screen,
  ScreenError,
  ScreenSkeleton,
  useApiMutation,
  useApiQuery,
  useCan,
  useConfirm,
  useDirty,
  useFeatures,
  useNav,
  useScreenResult,
  userMessage,
} from '../../app/index.ts';
import type { ScreenProps } from '../../app/index.ts';
import { Banner, Button, Field, FieldGroup, Stack, TextInput, useEnterAdvance, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { AcceptKey, FeatureOff, focusFirstError, INVENTORY_INVALIDATES, splitApiError } from './common.tsx';
import { DeleteKey } from './Groups.tsx';
import type { Leveled } from './lib/tree.ts';
import { descendantIds } from './lib/tree.ts';
import { StockCategoryPicker } from './pickers.tsx';
import { TreeMasterList } from './TreeMasterList.tsx';

export function CategoryListScreen() {
  const features = useFeatures();
  const nav = useNav();
  const q = useApiQuery('inventory.category.list', { limit: 5000 }, { enabled: features.inventory });
  const del = useApiMutation('inventory.category.delete', { invalidates: INVENTORY_INVALIDATES });
  const columns = useMemo<Column<Leveled<StockCategoryDto>>[]>(() => [{ key: 'itemCount', header: 'Items', kind: 'number', width: 90, decimals: 0 }], []);
  if (!features.inventory)
    return (
      <Screen title="Stock Categories" icon="tag">
        <FeatureOff title="Inventory is turned off" body="Turn on Inventory in Features (F11) to keep stock categories." />
      </Screen>
    );
  return (
    <TreeMasterList<StockCategoryDto>
      title="Stock Categories"
      noun="stock category"
      icon="tag"
      rows={q.data?.rows}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      columns={columns}
      exportColumns={[{ header: 'Name' }, { header: 'Alias' }, { header: 'Under' }, { header: 'Items', kind: 'number', decimals: 0 }]}
      exportRow={(c) => [c.name, c.alias ?? '', c.parentName ?? 'Primary', c.itemCount]}
      formScreen="inventory.category.form"
      onDelete={async (c) => {
        await del.mutate({ id: c.id });
      }}
      deleteBlocked={(c) =>
        c.childCount > 0 ? `It has ${c.childCount} categor${c.childCount === 1 ? 'y' : 'ies'} under it. Move or delete them first.` : c.itemCount > 0 ? `${c.itemCount} stock item(s) use it. Change their category first.` : null
      }
      extraActions={(c) => [
        { key: 'Alt+I', label: 'Items in category', icon: 'box', onClick: () => nav.push('inventory.item.list', c ? { categoryId: c.id } : {}), disabled: !c, group: 'more' },
      ]}
      emptyTitle="No stock categories yet"
      emptyBody="Categories classify items across groups — for example by brand (Tata, Amul) or size. They are optional. Press Alt+C to create one."
    />
  );
}

export interface CategoryFormParams {
  id?: number;
  initialName?: string;
  forResult?: boolean;
  parentId?: number;
}

export function CategoryFormScreen({ params }: ScreenProps<CategoryFormParams>) {
  const id = typeof params.id === 'number' ? params.id : undefined;
  const features = useFeatures();
  const nav = useNav();
  const existing = useApiQuery('inventory.category.get', { id: id ?? 0 }, { enabled: id !== undefined && features.inventory, staleTime: 0 });
  const all = useApiQuery('inventory.category.list', { limit: 5000 }, { enabled: features.inventory, staleTime: 60_000 });
  const title = id === undefined ? 'Stock Category Creation' : 'Stock Category Alteration';
  if (!features.inventory || existing.error || all.error || (id !== undefined && !existing.data) || !all.data) {
    return (
      <DialogScreen title={title} size="md" footer={<Button onClick={() => void nav.back()}>Close</Button>}>
        {!features.inventory ? (
          <FeatureOff title="Inventory is turned off" body="Turn on Inventory in Features (F11) to keep stock categories." />
        ) : existing.error || all.error ? (
          <ScreenError error={existing.error ?? all.error} onRetry={() => void (existing.error ? existing.refetch() : all.refetch())} />
        ) : (
          <ScreenSkeleton lines={3} />
        )}
      </DialogScreen>
    );
  }
  return <CategoryForm key={existing.data ? `${existing.data.id}:${existing.data.updatedAt}` : 'new'} title={title} saved={existing.data ?? null} params={params} all={all.data.rows} />;
}

const CID = 'inv-cat-';

function CategoryForm({ title, saved, params, all }: { title: string; saved: StockCategoryDto | null; params: CategoryFormParams; all: readonly StockCategoryDto[] }) {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const canAlter = useCan('masters.alter');
  const canCreate = useCan('masters.create');
  const canDelete = useCan('masters.delete');
  const { forResult, returnResult } = useScreenResult<{ id: number; name: string }>();
  const save = useApiMutation('inventory.category.save', { invalidates: INVENTORY_INVALIDATES });
  const del = useApiMutation('inventory.category.delete', { invalidates: INVENTORY_INVALIDATES });
  const base = useMemo(
    () => ({ name: saved?.name ?? params.initialName ?? '', alias: saved?.alias ?? '', parentId: saved ? saved.parentId : typeof params.parentId === 'number' ? params.parentId : null }),
    [saved, params.initialName, params.parentId],
  );
  const [d, setD] = useState(base);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const dirty = JSON.stringify(d) !== JSON.stringify(base);
  useDirty(dirty);
  const exclude = useMemo(() => (saved ? descendantIds(all, saved.id) : undefined), [all, saved]);
  const readOnly = saved !== null ? !canAlter : !canCreate;

  const submit = async (): Promise<void> => {
    if (save.pending || readOnly) return;
    if (saved && !dirty) {
      if (forResult) returnResult({ id: saved.id, name: saved.name });
      else nav.pop();
      return;
    }
    const e: Record<string, string> = {};
    if (!d.name.trim()) e.name = 'Enter the category name';
    if (d.alias.trim() && d.alias.trim().toLowerCase() === d.name.trim().toLowerCase()) e.alias = 'The alias must be different from the name';
    setErrors(e);
    setBanner(null);
    if (Object.keys(e).length) {
      focusFirstError(e, ['name', 'alias'], (k) => `${CID}${k}`);
      return;
    }
    try {
      const out = await save.mutate({ ...(saved ? { id: saved.id } : {}), name: d.name.trim(), alias: d.alias.trim() || null, parentId: d.parentId });
      toast.success(saved ? `Category “${out.name}” saved` : `Category “${out.name}” created`);
      if (forResult) returnResult({ id: out.id, name: out.name });
      else nav.pop();
    } catch (err) {
      const { fields, message } = splitApiError(err, (k) => ['name', 'alias', 'parentId'].includes(k));
      setErrors(fields);
      setBanner(message);
    }
  };

  const remove = async (): Promise<void> => {
    if (!saved) return;
    if (!(await confirm({ title: `Delete stock category “${saved.name}”?`, message: 'This cannot be undone.', confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      await del.mutate({ id: saved.id });
      toast.success(`Category “${saved.name}” deleted`);
      nav.pop();
    } catch (err) {
      setBanner(userMessage(err));
    }
  };

  const formRef = useEnterAdvance<HTMLDivElement>({ enabled: !readOnly, onComplete: () => void submit() });
  return (
    <DialogScreen
      title={saved ? `${title} — ${saved.name}` : title}
      size="md"
      footerStart={
        saved && canDelete ? (
          <Button variant="danger" icon="trash" shortcut="Alt+D" onClick={() => void remove()} loading={del.pending}>
            Delete
          </Button>
        ) : undefined
      }
      footer={
        <>
          <Button onClick={() => void nav.back()}>Cancel</Button>
          <Button variant="primary" icon="save" shortcut="Ctrl+A" loading={save.pending} onClick={() => void submit()} disabled={readOnly}>
            {forResult ? 'Save & return' : 'Save'}
          </Button>
        </>
      }
    >
      <AcceptKey onAccept={() => void submit()} />
      <DeleteKey enabled={!!saved && canDelete} onDelete={() => void remove()} />
      <div ref={formRef}>
        <Stack gap={4}>
          {banner ? (
            <Banner tone="danger" title="Not saved" onDismiss={() => setBanner(null)}>
              {banner}
            </Banner>
          ) : null}
          <FieldGroup columns={2}>
            <Field label="Name" required htmlFor={`${CID}name`} error={errors.name}>
              <TextInput id={`${CID}name`} value={d.name} onChange={(e) => setD((x) => ({ ...x, name: e.target.value }))} maxLength={200} data-autofocus="" autoComplete="off" readOnly={readOnly} />
            </Field>
            <Field label="Alias" optional htmlFor={`${CID}alias`} error={errors.alias}>
              <TextInput id={`${CID}alias`} value={d.alias} onChange={(e) => setD((x) => ({ ...x, alias: e.target.value }))} maxLength={200} autoComplete="off" readOnly={readOnly} />
            </Field>
          </FieldGroup>
          <Field label="Under" htmlFor={`${CID}parentId`} error={errors.parentId} hint="Leave empty for a main category.">
            <StockCategoryPicker id={`${CID}parentId`} value={d.parentId} onChange={(pid) => setD((x) => ({ ...x, parentId: pid }))} exclude={exclude} placeholder="Primary" readOnly={readOnly} />
          </Field>
        </Stack>
      </div>
    </DialogScreen>
  );
}
