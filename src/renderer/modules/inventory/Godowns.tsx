/**
 * Godowns / locations (feature: Multiple godowns): 'inventory.godown.list' and
 * 'inventory.godown.form' (dialog; params { id?, initialName?, forResult?, parentId? }).
 * 'Main Location' is predefined: it can be renamed but not deleted or marked third-party.
 */
import { useMemo, useState } from 'react';
import type { GodownDto } from '../../../shared/types/inventory.ts';
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
import { Badge, Banner, Button, Field, FieldGroup, Inline, Stack, Switch, TextArea, TextInput, useEnterAdvance, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { AcceptKey, FeatureOff, focusFirstError, HistoryButton, HistoryKey, INVENTORY_INVALIDATES, splitApiError, useMasterHistory } from './common.tsx';
import { DeleteKey } from './Groups.tsx';
import type { Leveled } from './lib/tree.ts';
import { descendantIds } from './lib/tree.ts';
import { GodownPicker } from './pickers.tsx';
import { TreeMasterList } from './TreeMasterList.tsx';

const OFF_BODY = 'Turn on Multiple godowns in Features (F11) to keep stock in more than one location. Until then all stock is in Main Location.';

export function GodownListScreen() {
  const features = useFeatures();
  const on = features.inventory && features.multipleGodowns;
  const q = useApiQuery('inventory.godown.list', { limit: 5000 }, { enabled: on });
  const del = useApiMutation('inventory.godown.delete', { invalidates: INVENTORY_INVALIDATES });
  const columns = useMemo<Column<Leveled<GodownDto>>[]>(
    () => [
      {
        key: 'kind',
        header: 'Type',
        width: 140,
        render: (g) =>
          g.isPredefined ? (
            <Badge size="sm" tone="brand">
              Main location
            </Badge>
          ) : g.isThirdParty ? (
            <Badge size="sm" tone="warning">
              Third party
            </Badge>
          ) : (
            <span className="bx-muted">Own</span>
          ),
      },
      { key: 'address', header: 'Address', value: (g) => (g.address ?? '').replace(/\s*\n\s*/g, ', ') },
    ],
    [],
  );
  if (!on)
    return (
      <Screen title="Godowns" icon="warehouse">
        <FeatureOff title={features.inventory ? 'Multiple godowns is turned off' : 'Inventory is turned off'} body={OFF_BODY} />
      </Screen>
    );
  return (
    <TreeMasterList<GodownDto>
      title="Godowns"
      noun="godown"
      icon="warehouse"
      rows={q.data?.rows}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      columns={columns}
      exportColumns={[{ header: 'Name' }, { header: 'Alias' }, { header: 'Under' }, { header: 'Type' }, { header: 'Address' }]}
      exportRow={(g) => [g.name, g.alias ?? '', g.parentName ?? 'Primary', g.isPredefined ? 'Main location' : g.isThirdParty ? 'Third party' : 'Own', g.address ?? '']}
      formScreen="inventory.godown.form"
      onDelete={async (g) => {
        await del.mutate({ id: g.id });
      }}
      deleteBlocked={(g) => (g.isPredefined ? 'Main Location is built in and cannot be deleted. You can rename it.' : g.childCount > 0 ? `It has ${g.childCount} godown(s) under it. Move or delete them first.` : null)}
      emptyTitle="No godowns yet"
      emptyBody="Add your warehouses, shops or other locations. Press Alt+C to create one."
    />
  );
}

export interface GodownFormParams {
  id?: number;
  initialName?: string;
  forResult?: boolean;
  parentId?: number;
}

export function GodownFormScreen({ params }: ScreenProps<GodownFormParams>) {
  const id = typeof params.id === 'number' ? params.id : undefined;
  const features = useFeatures();
  const nav = useNav();
  const on = features.inventory && features.multipleGodowns;
  const existing = useApiQuery('inventory.godown.get', { id: id ?? 0 }, { enabled: id !== undefined && on, staleTime: 0 });
  const all = useApiQuery('inventory.godown.list', { limit: 5000 }, { enabled: on, staleTime: 60_000 });
  const title = id === undefined ? 'Godown Creation' : 'Godown Alteration';
  if (!on || existing.error || all.error || (id !== undefined && !existing.data) || !all.data) {
    return (
      <DialogScreen title={title} size="md" footer={<Button onClick={() => void nav.back()}>Close</Button>}>
        {!on ? (
          <FeatureOff title="Multiple godowns is turned off" body={OFF_BODY} />
        ) : existing.error || all.error ? (
          <ScreenError error={existing.error ?? all.error} onRetry={() => void (existing.error ? existing.refetch() : all.refetch())} />
        ) : (
          <ScreenSkeleton lines={4} />
        )}
      </DialogScreen>
    );
  }
  return <GodownForm key={existing.data ? `${existing.data.id}:${existing.data.updatedAt}` : 'new'} title={title} saved={existing.data ?? null} params={params} all={all.data.rows} />;
}

const DID = 'inv-godown-';

function GodownForm({ title, saved, params, all }: { title: string; saved: GodownDto | null; params: GodownFormParams; all: readonly GodownDto[] }) {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const canAlter = useCan('masters.alter');
  const canCreate = useCan('masters.create');
  const canDelete = useCan('masters.delete');
  const { forResult, returnResult } = useScreenResult<{ id: number; name: string }>();
  const save = useApiMutation('inventory.godown.save', { invalidates: INVENTORY_INVALIDATES });
  const del = useApiMutation('inventory.godown.delete', { invalidates: INVENTORY_INVALIDATES });
  const base = useMemo(
    () => ({
      name: saved?.name ?? params.initialName ?? '',
      alias: saved?.alias ?? '',
      parentId: saved ? saved.parentId : typeof params.parentId === 'number' ? params.parentId : null,
      address: saved?.address ?? '',
      isThirdParty: saved?.isThirdParty ?? false,
    }),
    [saved, params.initialName, params.parentId],
  );
  const [d, setD] = useState(base);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const dirty = JSON.stringify(d) !== JSON.stringify(base);
  useDirty(dirty);
  const exclude = useMemo(() => (saved ? descendantIds(all, saved.id) : undefined), [all, saved]);
  const readOnly = saved !== null ? !canAlter : !canCreate;
  const deletable = !!saved && canDelete && !saved.isPredefined;

  const submit = async (): Promise<void> => {
    if (save.pending || readOnly) return;
    if (saved && !dirty) {
      if (forResult) returnResult({ id: saved.id, name: saved.name });
      else nav.pop();
      return;
    }
    const e: Record<string, string> = {};
    if (!d.name.trim()) e.name = 'Enter the godown name';
    if (d.alias.trim() && d.alias.trim().toLowerCase() === d.name.trim().toLowerCase()) e.alias = 'The alias must be different from the name';
    setErrors(e);
    setBanner(null);
    if (Object.keys(e).length) {
      focusFirstError(e, ['name', 'alias'], (k) => `${DID}${k}`);
      return;
    }
    try {
      const out = await save.mutate({
        ...(saved ? { id: saved.id } : {}),
        name: d.name.trim(),
        alias: d.alias.trim() || null,
        parentId: d.parentId,
        address: d.address.trim() || null,
        isThirdParty: saved?.isPredefined ? false : d.isThirdParty,
      });
      toast.success(saved ? `Godown “${out.name}” saved` : `Godown “${out.name}” created`);
      if (forResult) returnResult({ id: out.id, name: out.name });
      else nav.pop();
    } catch (err) {
      const { fields, message } = splitApiError(err, (k) => ['name', 'alias', 'parentId', 'address', 'isThirdParty'].includes(k));
      setErrors(fields);
      setBanner(message);
    }
  };

  const remove = async (): Promise<void> => {
    if (!saved || saved.isPredefined) return;
    if (!(await confirm({ title: `Delete godown “${saved.name}”?`, message: 'Godowns with stock, opening stock or vouchers cannot be deleted.', confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      await del.mutate({ id: saved.id });
      toast.success(`Godown “${saved.name}” deleted`);
      nav.pop();
    } catch (err) {
      setBanner(userMessage(err));
    }
  };

  const formRef = useEnterAdvance<HTMLDivElement>({ enabled: !readOnly, onComplete: () => void submit() });
  const history = useMasterHistory('godown', saved, saved?.name ?? '');
  return (
    <DialogScreen
      title={saved ? `${title} — ${saved.name}` : title}
      description={saved?.isPredefined ? 'The built-in main location. Stock without a godown is kept here.' : undefined}
      size="md"
      footerStart={
        history || (deletable) ? (
          <Inline gap={2}>
            <HistoryButton onOpen={history} />
            {deletable ? (
              <Button variant="danger" icon="trash" shortcut="Alt+D" onClick={() => void remove()} loading={del.pending}>
                Delete
              </Button>
            ) : null}
          </Inline>
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
      <DeleteKey enabled={deletable} onDelete={() => void remove()} />
      <HistoryKey onOpen={history} />
      <div ref={formRef}>
        <Stack gap={4}>
          {banner ? (
            <Banner tone="danger" title="Not saved" onDismiss={() => setBanner(null)}>
              {banner}
            </Banner>
          ) : null}
          <FieldGroup columns={2}>
            <Field label="Name" required htmlFor={`${DID}name`} error={errors.name}>
              <TextInput id={`${DID}name`} value={d.name} onChange={(e) => setD((x) => ({ ...x, name: e.target.value }))} maxLength={200} data-autofocus="" autoComplete="off" readOnly={readOnly} />
            </Field>
            <Field label="Alias" optional htmlFor={`${DID}alias`} error={errors.alias}>
              <TextInput id={`${DID}alias`} value={d.alias} onChange={(e) => setD((x) => ({ ...x, alias: e.target.value }))} maxLength={200} autoComplete="off" readOnly={readOnly} />
            </Field>
          </FieldGroup>
          <Field label="Under" htmlFor={`${DID}parentId`} error={errors.parentId} hint="e.g. a rack under a warehouse. Leave empty for a main location.">
            <GodownPicker id={`${DID}parentId`} value={d.parentId} onChange={(pid) => setD((x) => ({ ...x, parentId: pid }))} exclude={exclude} placeholder="Primary" readOnly={readOnly} />
          </Field>
          <Field label="Address" optional htmlFor={`${DID}address`} error={errors.address} hint="Ctrl+Enter to move on.">
            <TextArea id={`${DID}address`} value={d.address} onChange={(e) => setD((x) => ({ ...x, address: e.target.value }))} maxLength={1000} rows={2} autoGrow maxRows={5} readOnly={readOnly} />
          </Field>
          {!saved?.isPredefined ? (
            <Field label="Third-party location" htmlFor={`${DID}isThirdParty`} error={errors.isThirdParty} hint="A job worker's or agent's premises holding your stock.">
              <Switch id={`${DID}isThirdParty`} checked={d.isThirdParty} onChange={(v) => setD((x) => ({ ...x, isThirdParty: v }))} disabled={readOnly} />
            </Field>
          ) : null}
        </Stack>
      </div>
    </DialogScreen>
  );
}
