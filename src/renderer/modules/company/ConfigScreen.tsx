/**
 * 'company.config' (F12) {tab?: 'invoice' | 'gst' | 'guards' | 'display' | 'backup'} — Configuration:
 * round-off and a summary of invoice printing, GST, warnings & checks, display, backup, and the period
 * lock summary. `tab` opens that tab first (Backup › Backup settings passes 'backup').
 *
 * Invoice printing (config.invoice) is edited ONLY on Invoice Printing ('print.settings', live
 * preview); the Invoices tab summarises it and opens that screen (Alt+I). F12 saves only its own
 * sections (lib/configForm.ts), so it never overwrites a print-settings change.
 *
 * Enter / Shift+Enter move through the fields of the open tab (Tally); Enter on the last field saves.
 */
import { useMemo, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import type { CompanyConfig, GuardPolicy, RoundOffMethod } from '../../../shared/settings.ts';
import { native } from '../../app/bridge.ts';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { fieldErrorsOf, userMessage } from '../../app/lib/apiErrors.ts';
import { sameFolder, unapprovedFolderText } from '../../app/lib/autoBackup.ts';
import { useNav } from '../../app/nav.tsx';
import type { ScreenProps } from '../../app/registry.ts';
import { ReadOnlyNotice, Screen } from '../../app/Screen.tsx';
import { useAppState } from '../../app/state.tsx';
import { configDirty, configEdited, configFormKey, configSaveInput, configTabOf, invoiceSummary, tabOfErrorPath } from './lib/configForm.ts';
import type { ConfigEdited, ConfigScreenParams, ConfigTabId } from './lib/configForm.ts';
import {
  AmountInput,
  Banner,
  Button,
  DateInput,
  Field,
  FieldGroup,
  KeyValueList,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Tabs,
  TextInput,
  useEnterAdvance,
  useToast,
} from '../../ui/index.ts';

export function ConfigScreen({ params }: ScreenProps<ConfigScreenParams>) {
  const q = useApiQuery('company.config.get', {});
  // Held here so the open tab survives the form remounting after a save.
  const [tab, setTab] = useState<ConfigTabId>(() => configTabOf(params?.tab));
  if (!q.data) return <Screen title="Configuration" loading={q.loading} error={q.error} onRetry={() => void q.refetch()} />;
  return <ConfigForm key={configFormKey(q.data)} saved={q.data} tab={tab} setTab={setTab} />;
}

const GUARDS: ReadonlyArray<{ key: keyof CompanyConfig['guards']; label: string; description: string }> = [
  { key: 'negativeStock', label: 'Selling more stock than you have', description: 'When a sale or issue would take an item below zero.' },
  { key: 'negativeCash', label: 'Cash going below zero', description: 'When a payment would make the cash balance negative.' },
  { key: 'creditLimit', label: 'Party crossing its credit limit', description: 'When a sale takes a customer above the credit limit set on its ledger.' },
  { key: 'duplicateSupplierInvoice', label: 'Same supplier bill entered twice', description: 'When a purchase uses a supplier invoice number already entered for that supplier.' },
];

const GUARD_OPTIONS: ReadonlyArray<{ value: GuardPolicy; label: string }> = [
  { value: 'allow', label: 'Allow' },
  { value: 'warn', label: 'Warn' },
  { value: 'block', label: 'Block' },
];

function ConfigForm({ saved, tab, setTab }: { saved: CompanyConfig; tab: ConfigTabId; setTab: (t: ConfigTabId) => void }) {
  const app = useAppState();
  const nav = useNav();
  const toast = useToast();
  const canEdit = app.can('company.manage');
  const readOnly = !canEdit;
  const [c, setC] = useState<ConfigEdited>(() => configEdited(saved));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const save = useApiMutation('company.config.save');
  const dirty = configDirty(c, saved);
  const canOpenPrinting = nav.canOpen('print.settings');
  const banks = useApiQuery('print.bankLedgers', {}, { enabled: canOpenPrinting });
  const summary = useMemo(() => invoiceSummary(saved.invoice, banks.error ? undefined : banks.data), [saved.invoice, banks.data, banks.error]);
  const openPrinting = () => nav.push('print.settings');

  const patch = <K extends keyof ConfigEdited>(section: K, value: Partial<ConfigEdited[K]>) => {
    setC((x) => ({ ...x, [section]: { ...(x[section] as object), ...(value as object) } as ConfigEdited[K] }));
    setError(null);
  };

  const submit = async () => {
    if (!dirty || readOnly || save.pending) return;
    setErrors({});
    try {
      await save.mutate(configSaveInput(c));
      toast.success('Configuration saved');
    } catch (err) {
      const f = fieldErrorsOf(err);
      const paths = Object.keys(f);
      if (paths.length) {
        setErrors(f);
        setTab(tabOfErrorPath(paths[0]));
      } else {
        setError(userMessage(err));
      }
    }
  };

  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => void submit() });

  // A stored folder not approved on this computer (restored backup, copied company): picking the SAME
  // folder again confirms it at once ('data.backup.approveFolder'); another folder is saved as usual.
  const folderStatus = useApiQuery('data.backup.folderStatus', {});
  const approveFolder = useApiMutation('data.backup.approveFolder', { invalidates: ['data.backup'] });
  const unapprovedFolder = folderStatus.data && !folderStatus.data.approved && folderStatus.data.folder && saved.backup.folder && sameFolder(folderStatus.data.folder, saved.backup.folder) ? folderStatus.data.folder : null;

  const chooseBackupFolder = async () => {
    try {
      const picked = await native('dialog.chooseFolder', { title: 'Choose a backup folder', defaultPath: c.backup.folder ?? undefined });
      if (!picked) return;
      if (unapprovedFolder && sameFolder(picked.path, unapprovedFolder) && sameFolder(c.backup.folder ?? '', unapprovedFolder)) {
        await approveFolder.mutate({ folder: picked.path });
        toast.success('Backup folder confirmed', { message: `Backups go to ${picked.path}.` });
        return;
      }
      patch('backup', { folder: picked.path });
    } catch (err) {
      toast.error('Could not choose the folder', { message: userMessage(err) });
    }
  };

  const invoiceTab = (
    <Stack gap={5}>
      <FieldGroup
        legend="Invoice printing"
        description="Template, copies, bank details, UPI QR code and wording are set on Invoice Printing, with a live preview."
      >
        <KeyValueList items={summary} labelWidth={200} aria-label="Invoice printing settings" />
        {canOpenPrinting ? (
          <div>
            <Button icon="print" onClick={openPrinting} shortcut="Alt+I">
              {canEdit ? 'Change invoice printing…' : 'View invoice printing…'}
            </Button>
          </div>
        ) : null}
      </FieldGroup>
      <FieldGroup legend="Rounding off invoice totals" columns={3}>
        <Switch label="Round off totals" checked={c.roundOff.enabled} disabled={readOnly} onChange={(v) => patch('roundOff', { enabled: v })} />
        <Field label="Direction">
          <Select<RoundOffMethod>
            value={c.roundOff.method}
            disabled={readOnly || !c.roundOff.enabled}
            onChange={(v) => patch('roundOff', { method: v })}
            options={[
              { value: 'nearest', label: 'Nearest' },
              { value: 'up', label: 'Always up' },
              { value: 'down', label: 'Always down' },
            ]}
          />
        </Field>
        <Field label="To the nearest">
          <Select
            value={String(c.roundOff.unit)}
            disabled={readOnly || !c.roundOff.enabled}
            onChange={(v) => patch('roundOff', { unit: Number(v) })}
            options={[
              { value: '10', label: '₹0.10' },
              { value: '50', label: '₹0.50' },
              { value: '100', label: '₹1' },
              { value: '500', label: '₹5' },
              { value: '1000', label: '₹10' },
            ]}
          />
        </Field>
      </FieldGroup>
    </Stack>
  );

  const gstTab = (
    <Stack gap={5}>
      {!app.company?.gstEnabled ? (
        <Banner tone="info" inline>
          GST is turned off for this company. These settings apply once you turn it on in Features (F11).
        </Banner>
      ) : null}
      <FieldGroup legend="Returns" columns={2}>
        <Field label="GSTR-1 filing">
          <SegmentedControl<'monthly' | 'quarterly'>
            aria-label="GSTR-1 filing frequency"
            value={c.gst.filingFrequency}
            disabled={readOnly}
            onChange={(v) => patch('gst', { filingFrequency: v })}
            options={[
              { value: 'monthly', label: 'Monthly' },
              { value: 'quarterly', label: 'Quarterly (QRMP)' },
            ]}
          />
        </Field>
        <Field label="HSN digits in returns" hint="4 digits up to ₹5 crore annual turnover, 6 digits above.">
          <Select
            value={String(c.gst.hsnDigits)}
            disabled={readOnly}
            onChange={(v) => patch('gst', { hsnDigits: Number(v) as 4 | 6 | 8 })}
            options={[
              { value: '4', label: '4 digits' },
              { value: '6', label: '6 digits' },
              { value: '8', label: '8 digits' },
            ]}
          />
        </Field>
      </FieldGroup>
      <FieldGroup legend="Exports under LUT" description="Letter of Undertaking for exports without paying IGST." columns={3}>
        <Field label="LUT / ARN number" optional>
          <TextInput value={c.gst.lutNumber} readOnly={readOnly} maxLength={50} onChange={(e) => patch('gst', { lutNumber: e.target.value })} mono />
        </Field>
        <Field label="Valid from" optional>
          <DateInput value={c.gst.lutValidFrom} readOnly={readOnly} onChange={(v) => patch('gst', { lutValidFrom: v })} />
        </Field>
        <Field label="Valid to" optional error={errors['gst.lutValidTo']}>
          <DateInput value={c.gst.lutValidTo} readOnly={readOnly} onChange={(v) => patch('gst', { lutValidTo: v })} minDate={c.gst.lutValidFrom ?? undefined} />
        </Field>
      </FieldGroup>
      <FieldGroup legend="Limits" columns={2}>
        <Field label="Large B2C invoice limit (B2CL)" hint="Inter-state sales to unregistered buyers above this are reported invoice-wise.">
          <AmountInput value={c.gst.b2clThresholdPaise} readOnly={readOnly} onChange={(v) => patch('gst', { b2clThresholdPaise: v ?? 0 })} min={0} />
        </Field>
        <Field label="e-Way Bill limit" hint="Consignments above this value need an e-Way Bill.">
          <AmountInput value={c.gst.ewayThresholdPaise} readOnly={readOnly} onChange={(v) => patch('gst', { ewayThresholdPaise: v ?? 0 })} min={0} />
        </Field>
      </FieldGroup>
    </Stack>
  );

  const guardsTab = (
    <Stack gap={4}>
      <p className="bx-muted">What should happen when an entry breaks one of these checks? “Warn” asks before saving; “Block” refuses to save.</p>
      {GUARDS.map((g) => (
        <div key={g.key} className="bx-guard-row">
          <div className="bx-guard-row__text">
            <span className="bx-guard-row__label">{g.label}</span>
            <span className="bx-guard-row__desc">{g.description}</span>
          </div>
          <SegmentedControl<GuardPolicy> aria-label={g.label} value={c.guards[g.key]} disabled={readOnly} onChange={(v) => patch('guards', { [g.key]: v })} options={GUARD_OPTIONS} />
        </div>
      ))}
      <FieldGroup legend="Locked period">
        <div className="bx-guard-row">
          <div className="bx-guard-row__text">
            <span className="bx-guard-row__label">{saved.lockedUpTo ? `Books are locked up to ${formatDate(saved.lockedUpTo)}` : 'Books are not locked'}</span>
            <span className="bx-guard-row__desc">Locking stops anyone from adding, changing or deleting entries on or before a date — for example after filing returns.</span>
          </div>
          {app.can('period.lock') ? (
            <Button icon="lock" onClick={() => nav.push('company.periodLock')}>
              Lock or unlock…
            </Button>
          ) : null}
        </div>
      </FieldGroup>
    </Stack>
  );

  const displayTab = (
    <FieldGroup legend="Reports and lists" columns={2}>
      <Switch label="Show ledgers with zero balance" checked={c.display.showZeroBalances} disabled={readOnly} onChange={(v) => patch('display', { showZeroBalances: v })} />
      <Field label="Date style on printouts">
        <SegmentedControl<'DD-MMM-YYYY' | 'DD-MM-YYYY'>
          aria-label="Date style"
          value={c.display.dateFormat}
          disabled={readOnly}
          onChange={(v) => patch('display', { dateFormat: v })}
          options={[
            { value: 'DD-MMM-YYYY', label: '05-Oct-2026' },
            { value: 'DD-MM-YYYY', label: '05-10-2026' },
          ]}
        />
      </Field>
    </FieldGroup>
  );

  const backupTab = (
    <Stack gap={4}>
      {unapprovedFolder ? (
        <Banner tone="warning" title="Confirm the backup folder">
          {unapprovedFolderText(unapprovedFolder)} {canEdit ? 'Choose… and pick it again to confirm it, choose another folder, or use the default.' : 'Ask a user who can change the configuration to confirm it.'}
        </Banner>
      ) : null}
      <FieldGroup legend="Automatic backups" columns={2}>
        <Switch
          label="Back up automatically once a day (when the company is opened or closed)"
          checked={c.backup.auto}
          disabled={readOnly}
          onChange={(v) => patch('backup', { auto: v })}
        />
        <Field label="Keep the latest" hint="Older automatic backups are removed.">
          <NumberInput value={c.backup.keepLast} readOnly={readOnly} min={1} max={365} onChange={(v) => patch('backup', { keepLast: Math.max(1, Math.min(365, Math.round(v ?? 1))) })} suffix="backups" />
        </Field>
      </FieldGroup>
      <Field label="Backup folder" error={errors['backup.folder']} hint="Best on another drive or a USB disk, so a disk failure can't take both.">
        <TextInput
          value={c.backup.folder ?? ''}
          readOnly
          mono
          placeholder="Inside the data folder (default)"
          trailing={
            canEdit ? (
              <>
                <Button size="sm" icon="folder" onClick={() => void chooseBackupFolder()}>
                  Choose…
                </Button>
                {c.backup.folder ? (
                  <Button size="sm" variant="ghost" onClick={() => patch('backup', { folder: null })}>
                    Use default
                  </Button>
                ) : null}
              </>
            ) : undefined
          }
        />
      </Field>
    </Stack>
  );

  return (
    <Screen
      title="Configuration"
      subtitle="Round-off, GST settings, warnings, display and backups. Invoice printing has its own screen."
      icon="settings"
      width="form"
      dirty={dirty}
      hint="Enter Next field · Ctrl+Tab Next tab · Alt+I Invoice printing · Ctrl+A Save · Esc Back"
      actions={[
        { key: 'Ctrl+A', label: 'Save', icon: 'save', primary: true, onClick: () => void submit(), disabled: !dirty || readOnly },
        { key: 'Alt+I', label: 'Invoice printing', icon: 'print', onClick: openPrinting, hidden: !canOpenPrinting, group: 'more' },
        { key: 'F11', label: 'Features', icon: 'sliders', onClick: () => nav.push('company.features'), group: 'more' },
      ]}
      footer={
        canEdit ? (
          <>
            <Button onClick={() => void nav.back()}>Cancel</Button>
            <Button variant="primary" icon="save" disabled={!dirty} loading={save.pending} onClick={() => void submit()} shortcut="Ctrl+A">
              Save
            </Button>
          </>
        ) : undefined
      }
    >
      <Stack gap={4}>
        {readOnly ? <ReadOnlyNotice what="the configuration" /> : null}
        {error ? (
          <Banner tone="danger" title="Configuration was not saved" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        ) : null}
        <div ref={formRef}>
          <Tabs
            aria-label="Configuration sections"
            value={tab}
            onChange={(id) => setTab(configTabOf(id))}
            items={[
              { id: 'invoice', label: 'Invoices', icon: 'invoice', content: invoiceTab },
              { id: 'gst', label: 'GST', icon: 'gst', content: gstTab },
              { id: 'guards', label: 'Checks', icon: 'shield', content: guardsTab },
              { id: 'display', label: 'Display', icon: 'eye', content: displayTab },
              { id: 'backup', label: 'Backup', icon: 'database', content: backupTab },
            ]}
          />
        </div>
      </Stack>
    </Screen>
  );
}
