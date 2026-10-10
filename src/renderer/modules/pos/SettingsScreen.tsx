/**
 * 'pos.settings' — POS settings: the voucher types of the counter (POS Sales) and of returns, the
 * walk-in cash ledger, price level, godown, printing after each bill, asking for the customer first;
 * and the tender modes (how customers pay) with the ledger each posts to.
 * Keys: Enter next field · Ctrl+A save · Alt+C create tender mode · Enter on a mode alter ·
 * Alt+D delete the mode (deactivate a used one) · Esc back.
 */
import { useEffect, useMemo, useState } from 'react';
import type { LedgerListRow } from '../../../shared/types/accounts.ts';
import type { PosSettings, PosTenderKind, PosTenderMode } from '../../../shared/types/pos.ts';
import { POS_TENDER_KIND_LABELS, POS_USER_TENDER_KINDS } from '../../../shared/types/pos.ts';
import { api, Screen, useApiMutation, useApiQuery, useCan, useConfirm, useFeatures, useNav, userMessage } from '../../app/index.ts';
import { Badge, Banner, Button, Combobox, DataTable, EmptyState, Field, Modal, NumberInput, Panel, Select, Stack, Switch, TextInput, useEnterAdvance, useHotkeys, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { PosOff } from './components.tsx';

type Ref = { id: number; name: string } | null;

export function SettingsScreen() {
  const features = useFeatures();
  if (!features.pos) return <PosOff title="POS Settings" />;
  return <Settings />;
}

function Settings() {
  const nav = useNav();
  const toast = useToast();
  const features = useFeatures();
  const canManage = useCan('company.manage');
  const ctxQ = useApiQuery('pos.context', {}, { staleTime: 0 });
  const modesQ = useApiQuery('pos.tenderMode.list', {}, { staleTime: 0 });
  const levelsQ = useApiQuery('inventory.priceLevel.list', {}, { enabled: features.priceLevels });
  const godownsQ = useApiQuery('inventory.godown.list', {}, { enabled: features.multipleGodowns });
  const save = useApiMutation('pos.settings.save', { invalidates: ['pos'] });
  const [s, setS] = useState<PosSettings | null>(null);
  const [walkIn, setWalkIn] = useState<Ref>(null);
  const [editing, setEditing] = useState<PosTenderMode | 'new' | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const confirm = useConfirm();
  const ctx = ctxQ.data;
  useEffect(() => {
    if (!ctx || s) return;
    setS(ctx.settings);
    setWalkIn(ctx.walkIn);
  }, [ctx, s]);
  const dirty = !!ctx && !!s && (JSON.stringify(s) !== JSON.stringify(ctx.settings) || (walkIn?.id ?? null) !== (ctx.settings.walkInLedgerId ?? ctx.walkIn?.id ?? null));
  const set = <K extends keyof PosSettings>(k: K, v: PosSettings[K]): void => setS((cur) => (cur ? { ...cur, [k]: v } : cur));
  const submit = async (): Promise<void> => {
    if (!s || !canManage || save.pending) return;
    try {
      await save.mutate({ ...s, walkInLedgerId: walkIn?.id ?? null });
      toast.success('POS settings saved');
      void ctxQ.refetch();
    } catch {
      /* field errors shown next to the fields */
    }
  };
  const formRef = useEnterAdvance<HTMLFormElement>({ onComplete: () => void submit() });
  const modes = modesQ.data ?? [];
  const current = modes.find((m) => String(m.id) === cursor) ?? null;
  const remove = async (): Promise<void> => {
    if (!current || !canManage) return;
    if (current.usedCount > 0 || current.isSystem) {
      toast.info(`${current.name} cannot be deleted`, { message: 'A used or system mode is deactivated instead: open it (Enter) and switch Active off.' });
      return;
    }
    if (!(await confirm({ title: `Delete tender mode “${current.name}”?`, confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      await api('pos.tenderMode.delete', { id: current.id });
      toast.success(`${current.name} deleted`);
      void modesQ.refetch();
    } catch (err) {
      toast.error('Could not delete the mode', { message: userMessage(err) });
    }
  };
  const columns = useMemo<Column<PosTenderMode>[]>(
    () => [
      { key: 'name', header: 'Tender mode', render: (m) => <span>{m.name} {m.isSystem ? <Badge size="sm">system</Badge> : null} {!m.isActive ? <Badge size="sm" tone="warning">inactive</Badge> : null}</span> },
      { key: 'kind', header: 'Kind', width: 140, value: (m) => POS_TENDER_KIND_LABELS[m.kind] },
      { key: 'ledgerName', header: 'Posts to ledger', width: 240 },
      { key: 'usedCount', header: 'Bills', kind: 'number', width: 80 },
      { key: 'sortOrder', header: 'Order', kind: 'number', width: 80 },
    ],
    [],
  );
  return (
    <Screen
      title="POS Settings"
      subtitle="Counter voucher types, walk-in party, prices, printing and tender modes"
      icon="settings"
      width="form"
      dirty={dirty}
      loading={ctxQ.loading || !s}
      error={ctxQ.error}
      onRetry={() => void ctxQ.refetch()}
      hint="Enter Next field · Ctrl+A Save · Alt+C Create tender mode · Alt+D Delete mode · Alt+B POS counter · Esc Back"
      actions={[
        { key: 'Ctrl+A', label: 'Save', icon: 'save', primary: true, disabled: !canManage || !dirty || save.pending, onClick: () => void submit() },
        { key: 'Alt+C', label: 'Create tender mode', icon: 'plus', disabled: !canManage, onClick: () => setEditing('new'), group: 'modes' },
        { key: 'Alt+D', label: 'Delete mode', icon: 'trash', disabled: !canManage || !current, onClick: () => void remove(), group: 'modes' },
        { key: 'Alt+B', label: 'POS counter', icon: 'cart', onClick: () => nav.push('pos.counter'), group: 'go' },
      ]}
    >
      {s && ctx ? (
        <Stack gap={4}>
          {!canManage ? <Banner tone="info">You can view these settings; changing them needs the “Manage company” permission.</Banner> : null}
          <form ref={formRef} onSubmit={(e) => e.preventDefault()}>
            <Stack gap={3}>
              <Field label="POS voucher type" error={save.fieldErrors.saleVoucherTypeId} hint="Bills of the counter use this Sales type (its own number series, e.g. POS/1). More types: Masters › Voucher Types › Use as POS invoice.">
                <Select
                  data-autofocus
                  value={String(s.saleVoucherTypeId ?? ctx.saleVoucherTypeId ?? '')}
                  onChange={(v) => set('saleVoucherTypeId', v ? Number(v) : null)}
                  options={ctx.saleTypes.map((t) => ({ value: String(t.id), label: t.name }))}
                  placeholder="First POS type"
                />
              </Field>
              <Field label="Returns voucher type" error={save.fieldErrors.returnVoucherTypeId} hint="Goods returned from a POS bill are recorded as a Credit Note of this type.">
                <Select value={String(s.returnVoucherTypeId ?? ctx.returnVoucherTypeId ?? '')} onChange={(v) => set('returnVoucherTypeId', v ? Number(v) : null)} options={ctx.returnTypes.map((t) => ({ value: String(t.id), label: t.name }))} />
              </Field>
              <Field label="Walk-in party" htmlFor="pos-walkin" error={save.fieldErrors.walkInLedgerId} hint="The cash ledger a bill without a customer is made out to. Empty: the Cash ledger.">
                <Combobox<LedgerListRow>
                  id="pos-walkin"
                  loadItems={async (q) => (await api('accounts.ledger.list', { search: q, classes: ['cash'], activeOnly: true, limit: 50 })).rows}
                  getKey={(r) => String(r.id)}
                  getLabel={(r) => r.name}
                  value={walkIn ? ({ id: walkIn.id, name: walkIn.name } as LedgerListRow) : null}
                  onChange={(r) => setWalkIn(r ? { id: r.id, name: r.name } : null)}
                  placeholder="Cash"
                />
              </Field>
              {features.priceLevels ? (
                <Field label="Price level" error={save.fieldErrors.priceLevelId} hint="The counter prices items from this price list (quantity slabs apply); empty: the item's selling price.">
                  <Select value={String(s.priceLevelId ?? '')} onChange={(v) => set('priceLevelId', v ? Number(v) : null)} options={(levelsQ.data?.rows ?? []).map((l) => ({ value: String(l.id), label: l.name }))} placeholder="Selling price of the item" />
                </Field>
              ) : null}
              {features.multipleGodowns ? (
                <Field label="Sell from godown" error={save.fieldErrors.godownId}>
                  <Select value={String(s.godownId ?? '')} onChange={(v) => set('godownId', v ? Number(v) : null)} options={(godownsQ.data?.rows ?? []).map((g) => ({ value: String(g.id), label: g.name }))} placeholder="Main Location" />
                </Field>
              ) : null}
              <Switch checked={s.printAfterSave} onChange={(v) => set('printAfterSave', v)} label="Print the receipt after each bill (straight to the receipt printer chosen in Print Preview › Printer for rolls; otherwise the print dialog)" />
              <Switch checked={s.askCustomerFirst} onChange={(v) => set('askCustomerFirst', v)} label="Ask for the customer's mobile number before the first item" />
            </Stack>
          </form>
          <Panel title="Tender modes" description="How customers pay. UPI usually reaches the bank account directly; card payments are often kept in a clearing ledger until the acquirer settles them.">
            <DataTable<PosTenderMode>
              aria-label="Tender modes"
              columns={columns}
              rows={modes}
              loading={modesQ.loading}
              getRowKey={(m) => String(m.id)}
              selectedKey={cursor}
              onSelect={(k) => setCursor(k)}
              onRowActivate={(m) => canManage && setEditing(m)}
              empty={<EmptyState title="No tender modes" body="Alt+C creates one, e.g. UPI on your bank account." />}
            />
          </Panel>
        </Stack>
      ) : null}
      {editing ? (
        <TenderModeDialog
          mode={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void modesQ.refetch();
            void ctxQ.refetch();
          }}
        />
      ) : null}
    </Screen>
  );
}

function TenderModeDialog({ mode, onClose, onSaved }: { mode: PosTenderMode | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const save = useApiMutation('pos.tenderMode.save', { invalidates: ['pos'] });
  const [name, setName] = useState(mode?.name ?? '');
  const [kind, setKind] = useState<PosTenderKind>(mode?.kind ?? 'upi');
  const [ledger, setLedger] = useState<Ref>(mode ? { id: mode.ledgerId, name: mode.ledgerName } : null);
  const [order, setOrder] = useState<number | null>(mode?.sortOrder ?? null);
  const [active, setActive] = useState(mode?.isActive ?? true);
  const locked = mode !== null && (mode.isSystem || mode.usedCount > 0);
  const submit = async (): Promise<void> => {
    if (!ledger || save.pending) return;
    try {
      const out = await save.mutate({ ...(mode ? { id: mode.id } : {}), name, kind, ledgerId: ledger.id, ...(order !== null ? { sortOrder: order } : {}), isActive: active });
      toast.success(`${out.name} saved`);
      onSaved();
    } catch {
      /* field errors below */
    }
  };
  const formRef = useEnterAdvance<HTMLFormElement>({ onComplete: () => void submit() });
  return (
    <Modal
      open
      onClose={onClose}
      title={mode ? `Tender mode: ${mode.name}` : 'Create tender mode'}
      size="md"
      footerStart={<span className="bx-muted">Enter Next field · Ctrl+A Save</span>}
      footer={
        <Button variant="primary" shortcut="Ctrl+A" loading={save.pending} disabled={!ledger || !name.trim()} onClick={() => void submit()}>
          Save
        </Button>
      }
    >
      <ModeKeys onSave={() => void submit()} />
      <form ref={formRef} onSubmit={(e) => e.preventDefault()}>
        <Stack gap={3}>
          {save.error && Object.keys(save.fieldErrors).length === 0 ? <Banner tone="danger">{userMessage(save.error)}</Banner> : null}
          <Field label="Name" htmlFor="pos-mode-name" required error={save.fieldErrors.name}>
            <TextInput id="pos-mode-name" data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. UPI, Card (Pine Labs), Paytm" />
          </Field>
          <Field label="Kind" error={save.fieldErrors.kind} hint={locked ? 'Fixed: the mode is used on bills (or is the system mode).' : undefined}>
            <Select<PosTenderKind>
              value={kind}
              onChange={setKind}
              disabled={locked}
              options={(mode?.isSystem ? (['exchange'] as PosTenderKind[]) : POS_USER_TENDER_KINDS).map((k) => ({ value: k, label: POS_TENDER_KIND_LABELS[k] }))}
            />
          </Field>
          <Field label="Posts to ledger" htmlFor="pos-mode-ledger" required error={save.fieldErrors.ledgerId} hint="Cash → a Cash-in-Hand ledger. UPI / card → your bank account, or a current-asset clearing ledger.">
            <Combobox<LedgerListRow>
              id="pos-mode-ledger"
              disabled={locked}
              loadItems={async (q) => (await api('accounts.ledger.list', { search: q, classes: kind === 'cash' ? ['cash'] : ['cash_bank', 'asset'], activeOnly: true, limit: 50 })).rows.filter((r) => !r.billWise)}
              getKey={(r) => String(r.id)}
              getLabel={(r) => r.name}
              rightMeta={(r) => <span className="bx-muted">{r.groupName}</span>}
              value={ledger ? ({ id: ledger.id, name: ledger.name } as LedgerListRow) : null}
              onChange={(r) => setLedger(r ? { id: r.id, name: r.name } : null)}
              placeholder="Choose the ledger"
            />
          </Field>
          <Field label="Order on the payment screen" htmlFor="pos-mode-order" optional>
            <NumberInput id="pos-mode-order" value={order} onChange={setOrder} min={0} />
          </Field>
          <Switch checked={active} onChange={setActive} label="Active (offered on the counter)" />
        </Stack>
      </form>
    </Modal>
  );
}

function ModeKeys({ onSave }: { onSave: () => void }) {
  useHotkeys({ 'Ctrl+A': onSave }, [onSave]);
  return null;
}
