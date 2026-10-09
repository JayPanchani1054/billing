/**
 * Stock groups: 'inventory.group.list' and 'inventory.group.form' (dialog;
 * params { id?, initialName?, forResult?, parentId? } — returns { id, name } when opened for a result).
 * A group can carry GST details (with dated history) that its items inherit.
 */
import { useMemo, useState } from 'react';
import type { GstHistoryRow, StockGroupDetail, StockGroupDto } from '../../../shared/types/inventory.ts';
import {
  api,
  DialogScreen,
  formatDate,
  invalidate,
  Screen,
  ScreenError,
  ScreenSkeleton,
  useApiMutation,
  useApiQuery,
  useCan,
  useCompany,
  useCompanyConfig,
  useConfirm,
  useDirty,
  useFeatures,
  useNav,
  useScreenResult,
  useWorkingDate,
  userMessage,
} from '../../app/index.ts';
import type { ScreenProps } from '../../app/index.ts';
import { Banner, Button, Field, FieldGroup, Inline, Stack, Switch, TextInput, useEnterAdvance, useHotkeys, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { AcceptKey, FeatureOff, focusFirstError, HistoryButton, HistoryKey, INVENTORY_INVALIDATES, splitApiError, useMasterHistory } from './common.tsx';
import { GstFields } from './GstFields.tsx';
import type { GstDraft } from './lib/gstDraft.ts';
import { emptyGstDraft, gstChanged, gstDraftFrom, gstSaveFields, validateGstDraft } from './lib/gstDraft.ts';
import { gstSummary, inheritedGroupGst, inheritedGstText } from './lib/itemForm.ts';
import type { Leveled } from './lib/tree.ts';
import { descendantIds } from './lib/tree.ts';
import { StockGroupPicker } from './pickers.tsx';
import { TreeMasterList } from './TreeMasterList.tsx';

export function GroupListScreen() {
  const features = useFeatures();
  const company = useCompany();
  const q = useApiQuery('inventory.group.list', { limit: 5000 }, { enabled: features.inventory });
  const del = useApiMutation('inventory.group.delete', { invalidates: INVENTORY_INVALIDATES });
  const nav = useNav();
  const columns = useMemo<Column<Leveled<StockGroupDto>>[]>(
    () => [
      {
        key: 'gst',
        header: 'GST',
        width: 170,
        hidden: !company.gstEnabled,
        render: (g) => (g.gstApplicable ? gstSummary({ taxability: g.taxability, rate: g.gstRate, cessRate: g.cessRate, cessPerUnit: g.cessPerUnit }) : <span className="bx-muted">Inherited</span>),
      },
      { key: 'hsnSac', header: 'HSN/SAC', width: 110, hidden: !company.gstEnabled, value: (g) => g.hsnSac ?? '' },
      { key: 'itemCount', header: 'Items', kind: 'number', width: 90, decimals: 0 },
    ],
    [company.gstEnabled],
  );
  if (!features.inventory)
    return (
      <Screen title="Stock Groups" icon="layers">
        <FeatureOff title="Inventory is turned off" body="Turn on Inventory in Features (F11) to keep stock groups." />
      </Screen>
    );
  return (
    <TreeMasterList<StockGroupDto>
      title="Stock Groups"
      noun="stock group"
      icon="layers"
      rows={q.data?.rows}
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      columns={columns}
      exportColumns={[{ header: 'Name' }, { header: 'Alias' }, { header: 'Under' }, { header: 'GST' }, { header: 'HSN/SAC' }, { header: 'Items', kind: 'number', decimals: 0 }]}
      exportRow={(g) => [
        g.name,
        g.alias ?? '',
        g.parentName ?? 'Primary',
        g.gstApplicable ? gstSummary({ taxability: g.taxability, rate: g.gstRate, cessRate: g.cessRate, cessPerUnit: g.cessPerUnit }) : 'Inherited',
        g.hsnSac ?? '',
        g.itemCount,
      ]}
      formScreen="inventory.group.form"
      onDelete={async (g) => {
        await del.mutate({ id: g.id });
      }}
      deleteBlocked={(g) =>
        g.childCount > 0 ? `It has ${g.childCount} group(s) under it. Move or delete them first.` : g.itemCount > 0 ? `${g.itemCount} stock item(s) are under it. Move them to another group first.` : null
      }
      extraActions={(g) => [
        {
          key: 'Alt+I',
          label: 'Items in group',
          icon: 'box',
          onClick: () => nav.push('inventory.item.list', g ? { groupId: g.id } : {}),
          disabled: !g,
          group: 'more',
        },
      ]}
      emptyTitle="No stock groups yet"
      emptyBody="Groups organise items (e.g. Electronics › Phones) and can hold one GST rate for all their items. Press Alt+C to create one."
    />
  );
}

export interface GroupFormParams {
  id?: number;
  initialName?: string;
  forResult?: boolean;
  parentId?: number;
}

export function GroupFormScreen({ params }: ScreenProps<GroupFormParams>) {
  const id = typeof params.id === 'number' ? params.id : undefined;
  const features = useFeatures();
  const existing = useApiQuery('inventory.group.get', { id: id ?? 0 }, { enabled: id !== undefined && features.inventory, staleTime: 0 });
  const all = useApiQuery('inventory.group.list', { limit: 5000 }, { enabled: features.inventory, staleTime: 60_000 });
  const config = useCompanyConfig();
  const nav = useNav();
  const title = id === undefined ? 'Stock Group Creation' : 'Stock Group Alteration';
  if (!features.inventory) {
    return (
      <DialogScreen title={title} size="md" footer={<Button onClick={() => void nav.back()}>Close</Button>}>
        <FeatureOff title="Inventory is turned off" body="Turn on Inventory in Features (F11) to keep stock groups." />
      </DialogScreen>
    );
  }
  const error = existing.error ?? all.error;
  if (error || (id !== undefined && !existing.data) || !all.data || !config) {
    return (
      <DialogScreen title={title} size="lg" footer={<Button onClick={() => void nav.back()}>Close</Button>}>
        {error ? <ScreenError error={error} onRetry={() => void (existing.error ? existing.refetch() : all.refetch())} /> : <ScreenSkeleton lines={6} />}
      </DialogScreen>
    );
  }
  return (
    <GroupForm
      key={existing.data ? `${existing.data.id}:${existing.data.updatedAt}` : 'new'}
      title={title}
      saved={existing.data ?? null}
      params={params}
      groups={all.data.rows}
      hsnDigits={config.gst.hsnDigits}
    />
  );
}

interface GroupDraft extends GstDraft {
  name: string;
  alias: string;
  parentId: number | null;
  addQuantities: boolean;
}

const GID = 'inv-group-';
const GROUP_FIELDS = ['name', 'alias', 'parentId', 'taxability', 'gstRate', 'cessRate', 'cessPerUnit', 'hsnSac', 'gstApplicableFrom'] as const;

function GroupForm({ title, saved, params, groups, hsnDigits }: { title: string; saved: StockGroupDetail | null; params: GroupFormParams; groups: readonly StockGroupDto[]; hsnDigits: number }) {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const company = useCompany();
  const { date: workingDate } = useWorkingDate();
  const canAlter = useCan('masters.alter');
  const canCreate = useCan('masters.create');
  const canDelete = useCan('masters.delete');
  const { forResult, returnResult } = useScreenResult<{ id: number; name: string }>();
  const save = useApiMutation('inventory.group.save', { invalidates: INVENTORY_INVALIDATES });
  const del = useApiMutation('inventory.group.delete', { invalidates: INVENTORY_INVALIDATES });
  const base = useMemo<GroupDraft>(
    () =>
      saved
        ? { name: saved.name, alias: saved.alias ?? '', parentId: saved.parentId, addQuantities: saved.addQuantities, ...gstDraftFrom(saved) }
        : { name: params.initialName ?? '', alias: '', parentId: typeof params.parentId === 'number' ? params.parentId : null, addQuantities: true, ...emptyGstDraft() },
    [saved, params.initialName, params.parentId],
  );
  const [d, setD] = useState<GroupDraft>(base);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const dirty = JSON.stringify(d) !== JSON.stringify(base);
  useDirty(dirty);
  const exclude = useMemo(() => (saved ? descendantIds(groups, saved.id) : undefined), [groups, saved]);
  const readOnly = saved !== null ? !canAlter : !canCreate;
  const hasHistory = (saved?.gstHistory.length ?? 0) > 0;
  // Without its own details the group takes the parent chain's (current) details.
  const parentGst = d.parentId === null ? null : inheritedGroupGst(groups, d.parentId);
  const inheritedText =
    d.parentId === null ? 'A main group without GST details: items under it use their own rate, or else the sales or purchase ledger.' : inheritedGstText(parentGst, 'group');

  const patch = (p: Partial<GroupDraft>): void => {
    setD((x) => ({ ...x, ...p }));
    const keys = Object.keys(p);
    if (keys.some((k) => errors[k])) setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !keys.includes(k))));
  };

  const submit = async (): Promise<void> => {
    if (save.pending || readOnly) return;
    if (saved && !dirty) {
      if (forResult) returnResult({ id: saved.id, name: saved.name });
      else nav.pop();
      return;
    }
    const e: Record<string, string> = {};
    if (!d.name.trim()) e.name = 'Enter the stock group name';
    if (d.alias.trim() && d.alias.trim().toLowerCase() === d.name.trim().toLowerCase()) e.alias = 'The alias must be different from the name';
    if (company.gstEnabled) Object.assign(e, validateGstDraft(d, saved, { kind: null, hasHistory }));
    setErrors(e);
    setBanner(null);
    if (Object.keys(e).length) {
      focusFirstError(e, GROUP_FIELDS, (k) => `${GID}${k}`);
      return;
    }
    try {
      const out = await save.mutate({
        ...(saved ? { id: saved.id } : {}),
        name: d.name.trim(),
        alias: d.alias.trim() || null,
        parentId: d.parentId,
        addQuantities: d.addQuantities,
        ...(company.gstEnabled ? gstSaveFields(d, saved) : {}),
      });
      toast.success(saved ? `Stock group “${out.name}” saved` : `Stock group “${out.name}” created`);
      if (forResult) returnResult({ id: out.id, name: out.name });
      else nav.pop();
    } catch (err) {
      const { fields, message } = splitApiError(err, (k) => ['name', 'alias', 'parentId', 'addQuantities', 'gstRate', 'cessRate', 'cessPerUnit', 'hsnSac', 'gstApplicableFrom', 'taxability'].includes(k));
      setErrors(fields);
      setBanner(message);
      focusFirstError(fields, GROUP_FIELDS, (k) => `${GID}${k}`);
    }
  };

  const remove = async (): Promise<void> => {
    if (!saved) return;
    if (saved.childCount > 0 || saved.itemCount > 0) {
      setBanner(saved.childCount > 0 ? `It has ${saved.childCount} group(s) under it. Move or delete them first.` : `${saved.itemCount} stock item(s) are under it. Move them to another group first.`);
      return;
    }
    if (!(await confirm({ title: `Delete stock group “${saved.name}”?`, message: 'This cannot be undone.', confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      await del.mutate({ id: saved.id });
      toast.success(`Stock group “${saved.name}” deleted`);
      nav.pop();
    } catch (err) {
      setBanner(userMessage(err));
    }
  };

  const removeHistory = async (h: GstHistoryRow): Promise<void> => {
    if (!(await confirm({ title: `Remove the GST rate from ${formatDate(h.applicableFrom)}?`, message: `Use this only to undo a wrongly dated change.${dirty ? ' Your other unsaved changes on this form are discarded — save them first if you need them.' : ''}`, confirmLabel: 'Remove', tone: 'danger' }))) return;
    try {
      await api('inventory.gstHistory.delete', { id: h.id });
      invalidate('inventory');
      for (const p of INVENTORY_INVALIDATES) invalidate(p);
      toast.success('Rate removed from the history');
    } catch (err) {
      setBanner(userMessage(err));
    }
  };

  const formRef = useEnterAdvance<HTMLDivElement>({ enabled: !readOnly, onComplete: () => void submit() });
  const history = useMasterHistory('stock_group', saved, saved?.name ?? '');

  return (
    <DialogScreen
      title={saved ? `${title} — ${saved.name}` : title}
      description={saved?.path.length ? `Under ${[...saved.path].reverse().map((p) => p.name).join(' › ')}` : undefined}
      size="lg"
      footerStart={
        history || (saved && canDelete) ? (
          <Inline gap={2}>
            <HistoryButton onOpen={history} />
            {saved && canDelete ? (
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
      <DeleteKey enabled={!!saved && canDelete} onDelete={() => void remove()} />
      <HistoryKey onOpen={history} />
      <div ref={formRef}>
        <Stack gap={4}>
          {banner ? (
            <Banner tone="danger" title="Not saved" onDismiss={() => setBanner(null)}>
              {banner}
            </Banner>
          ) : null}
          <FieldGroup columns={2}>
            <Field label="Name" required htmlFor={`${GID}name`} error={errors.name}>
              <TextInput id={`${GID}name`} value={d.name} onChange={(e) => patch({ name: e.target.value })} maxLength={200} data-autofocus="" autoComplete="off" readOnly={readOnly} />
            </Field>
            <Field label="Alias" optional htmlFor={`${GID}alias`} error={errors.alias}>
              <TextInput id={`${GID}alias`} value={d.alias} onChange={(e) => patch({ alias: e.target.value })} maxLength={200} autoComplete="off" readOnly={readOnly} />
            </Field>
            <Field label="Under" htmlFor={`${GID}parentId`} error={errors.parentId} hint="Leave empty for a main (Primary) group. Alt+C to create.">
              <StockGroupPicker id={`${GID}parentId`} value={d.parentId} onChange={(pid) => patch({ parentId: pid })} exclude={exclude} placeholder="Primary" readOnly={readOnly} />
            </Field>
            <Field label="Add up quantities" htmlFor={`${GID}addQuantities`} hint="Show a total quantity for the group in stock reports (items should share a unit).">
              <Switch id={`${GID}addQuantities`} checked={d.addQuantities} onChange={(v) => patch({ addQuantities: v })} disabled={readOnly} />
            </Field>
          </FieldGroup>
          {company.gstEnabled ? (
            <FieldGroup legend="GST details" description="Items under this group use these unless they set their own.">
              <GstFields
                value={d}
                onChange={patch}
                errors={errors}
                kind={null}
                hsnDigits={hsnDigits}
                noun="stock group"
                existing={!!saved}
                changed={gstChanged(d, saved)}
                history={saved?.gstHistory ?? []}
                onDeleteHistory={saved && canAlter ? (h) => void removeHistory(h) : undefined}
                effectiveText={d.gstApplicable ? undefined : inheritedText}
                referenceDate={workingDate}
                idPrefix={GID}
                savedOwn={saved?.gstApplicable ?? false}
                readOnly={readOnly}
              />
            </FieldGroup>
          ) : null}
        </Stack>
      </div>
    </DialogScreen>
  );
}

/** Alt+D inside a dialog screen (dialog hotkeys must live inside DialogScreen). */
export function DeleteKey({ enabled, onDelete }: { enabled: boolean; onDelete: () => void }) {
  useHotkeys({ 'Alt+D': enabled ? () => onDelete() : undefined }, [enabled]);
  return null;
}
