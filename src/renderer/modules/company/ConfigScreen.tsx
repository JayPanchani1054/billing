/**
 * 'company.config' (F12) — Configuration: invoices & printing, GST, warnings & checks, display,
 * backup, round-off, and the period lock summary.
 */
import { useMemo, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import type { CompanyConfig, GuardPolicy, InvoiceTemplate, RoundOffMethod } from '../../../shared/settings.ts';
import type { CompanyConfigInput } from '../../../shared/types/company.ts';
import { validateUpiId } from '../../../shared/validators.ts';
import { apiOptional } from '../../app/api.ts';
import { native } from '../../app/bridge.ts';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { fieldErrorsOf, userMessage } from '../../app/lib/apiErrors.ts';
import { useNav } from '../../app/nav.tsx';
import { ReadOnlyNotice, Screen } from '../../app/Screen.tsx';
import { useAppState } from '../../app/state.tsx';
import {
  AmountInput,
  Banner,
  Button,
  Checkbox,
  DateInput,
  Field,
  FieldGroup,
  NumberInput,
  Picker,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Tabs,
  TextArea,
  TextInput,
  useToast,
} from '../../ui/index.ts';

type TabId = 'invoice' | 'gst' | 'guards' | 'display' | 'backup';

const TAB_OF_PATH: Readonly<Record<string, TabId>> = { invoice: 'invoice', roundOff: 'invoice', gst: 'gst', guards: 'guards', display: 'display', backup: 'backup' };

export function ConfigScreen() {
  const q = useApiQuery('company.config.get', {});
  if (!q.data) return <Screen title="Configuration" loading={q.loading} error={q.error} onRetry={() => void q.refetch()} />;
  return <ConfigForm key={JSON.stringify(q.data)} saved={q.data} />;
}

interface BankOption {
  id: number;
  name: string;
}

function parseBanks(out: unknown): BankOption[] {
  const list = Array.isArray(out) ? out : typeof out === 'object' && out !== null && Array.isArray((out as { rows?: unknown }).rows) ? (out as { rows: unknown[] }).rows : [];
  const res: BankOption[] = [];
  for (const r of list) {
    if (typeof r !== 'object' || r === null) continue;
    const o = r as Record<string, unknown>;
    const group = typeof o.groupName === 'string' ? o.groupName : '';
    if (typeof o.id === 'number' && typeof o.name === 'string' && (!group || /bank/i.test(group))) res.push({ id: o.id, name: o.name });
  }
  return res;
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

function ConfigForm({ saved }: { saved: CompanyConfig }) {
  const app = useAppState();
  const nav = useNav();
  const toast = useToast();
  const canEdit = app.can('company.manage');
  const readOnly = !canEdit;
  const [c, setC] = useState<CompanyConfig>(saved);
  const [tab, setTab] = useState<TabId>('invoice');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const save = useApiMutation('company.config.save');
  const dirty = JSON.stringify(c) !== JSON.stringify(saved);

  const patch = <K extends keyof CompanyConfig>(section: K, value: Partial<CompanyConfig[K]>) => {
    setC((x) => ({ ...x, [section]: { ...(x[section] as object), ...(value as object) } as CompanyConfig[K] }));
    setError(null);
  };

  const submit = async () => {
    if (!dirty || readOnly || save.pending) return;
    const upi = c.invoice.upiId.trim() ? validateUpiId(c.invoice.upiId.trim()) : null;
    if (upi) {
      setErrors({ 'invoice.upiId': upi });
      setTab('invoice');
      return;
    }
    if (c.invoice.copies.length === 0) {
      setErrors({ 'invoice.copies': 'Choose at least one copy to print' });
      setTab('invoice');
      return;
    }
    setErrors({});
    const { lockedUpTo: _locked, ...rest } = c;
    const input: CompanyConfigInput = rest;
    try {
      await save.mutate(input);
      toast.success('Configuration saved');
    } catch (err) {
      const f = fieldErrorsOf(err);
      const paths = Object.keys(f);
      if (paths.length) {
        setErrors(f);
        setTab(TAB_OF_PATH[paths[0].split('.')[0]] ?? 'invoice');
      } else {
        setError(userMessage(err));
      }
    }
  };

  const chooseBackupFolder = async () => {
    try {
      const picked = await native('dialog.chooseFolder', { title: 'Choose a backup folder', defaultPath: c.backup.folder ?? undefined });
      if (picked) patch('backup', { folder: picked.path });
    } catch (err) {
      toast.error('Could not choose the folder', { message: userMessage(err) });
    }
  };

  const bankValue = useMemo<BankOption | null>(() => (c.invoice.bankLedgerId === null ? null : { id: c.invoice.bankLedgerId, name: `Ledger #${c.invoice.bankLedgerId}` }), [c.invoice.bankLedgerId]);

  const invoiceTab = (
    <Stack gap={5}>
      <FieldGroup legend="Invoice printing" columns={2}>
        <Field label="Layout">
          <SegmentedControl<InvoiceTemplate>
            aria-label="Invoice layout"
            value={c.invoice.template}
            disabled={readOnly}
            onChange={(v) => patch('invoice', { template: v })}
            options={[
              { value: 'modern', label: 'Modern' },
              { value: 'classic', label: 'Classic' },
              { value: 'compact', label: 'Compact' },
            ]}
          />
        </Field>
        <Field label="Copies" error={errors['invoice.copies']}>
          <div className="bx-inline-checks">
            {(['original', 'duplicate', 'triplicate'] as const).map((copy) => (
              <Checkbox
                key={copy}
                label={copy[0].toUpperCase() + copy.slice(1)}
                checked={c.invoice.copies.includes(copy)}
                disabled={readOnly}
                onChange={(on) =>
                  patch('invoice', { copies: (['original', 'duplicate', 'triplicate'] as const).filter((x) => (x === copy ? on : c.invoice.copies.includes(x))) })
                }
              />
            ))}
          </div>
        </Field>
        <Switch label="Print right after saving an invoice" checked={c.invoice.printAfterSave} disabled={readOnly} onChange={(v) => patch('invoice', { printAfterSave: v })} />
        <Switch label="HSN/SAC summary on invoices" checked={c.invoice.showHsnSummary} disabled={readOnly} onChange={(v) => patch('invoice', { showHsnSummary: v })} />
        <Switch label="Tax columns per item (CGST/SGST/IGST)" checked={c.invoice.itemwiseTax} disabled={readOnly} onChange={(v) => patch('invoice', { itemwiseTax: v })} />
        <Field label="Signature caption">
          <TextInput value={c.invoice.signatoryLabel} readOnly={readOnly} maxLength={100} onChange={(e) => patch('invoice', { signatoryLabel: e.target.value })} />
        </Field>
      </FieldGroup>
      <FieldGroup legend="Payment details on invoices" columns={2}>
        <Switch label="Show bank account details" checked={c.invoice.showBankDetails} disabled={readOnly} onChange={(v) => patch('invoice', { showBankDetails: v })} />
        <Field label="Bank account" error={errors['invoice.bankLedgerId']} hint="The bank ledger whose account number and IFSC are printed.">
          <Picker<BankOption>
            loadItems={async (query) => {
              try {
                return parseBanks(await apiOptional('accounts.ledger.picker', { search: query, limit: 20 }));
              } catch {
                return [];
              }
            }}
            getKey={(b) => String(b.id)}
            getLabel={(b) => b.name}
            value={bankValue}
            onChange={(b) => patch('invoice', { bankLedgerId: b?.id ?? null })}
            disabled={readOnly || !c.invoice.showBankDetails}
            placeholder="Type to find a bank ledger"
            emptyText="No bank ledger found — create one under Bank Accounts first."
          />
        </Field>
        <Switch label="UPI QR code for payment" checked={c.invoice.showUpiQr} disabled={readOnly} onChange={(v) => patch('invoice', { showUpiQr: v })} />
        <Field label="UPI ID" error={errors['invoice.upiId']} hint="e.g. business@okhdfcbank">
          <TextInput value={c.invoice.upiId} readOnly={readOnly} disabled={!c.invoice.showUpiQr} maxLength={100} onChange={(e) => patch('invoice', { upiId: e.target.value.trim() })} mono />
        </Field>
      </FieldGroup>
      <FieldGroup legend="Wording">
        <Field label="Declaration">
          <TextArea value={c.invoice.declaration} readOnly={readOnly} rows={2} autoGrow maxRows={5} maxLength={2000} onChange={(e) => patch('invoice', { declaration: e.target.value })} />
        </Field>
        <Field label="Terms and conditions" optional>
          <TextArea value={c.invoice.terms} readOnly={readOnly} rows={3} autoGrow maxRows={8} maxLength={4000} onChange={(e) => patch('invoice', { terms: e.target.value })} />
        </Field>
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
        <Field label="e-Way bill limit" hint="Consignments above this value need an e-way bill.">
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
      <FieldGroup legend="Automatic backups" columns={2}>
        <Switch label="Back up automatically when the company is closed" checked={c.backup.auto} disabled={readOnly} onChange={(v) => patch('backup', { auto: v })} />
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
      subtitle="How invoices print, GST settings, warnings and backups."
      icon="settings"
      width="form"
      dirty={dirty}
      hint="Ctrl+Tab Next tab · Ctrl+A Save · Esc Back"
      actions={[
        { key: 'Ctrl+A', label: 'Save', icon: 'save', primary: true, onClick: () => void submit(), disabled: !dirty || readOnly },
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
        <Tabs
          aria-label="Configuration sections"
          value={tab}
          onChange={(id) => setTab(id as TabId)}
          items={[
            { id: 'invoice', label: 'Invoices', icon: 'invoice', content: invoiceTab },
            { id: 'gst', label: 'GST', icon: 'gst', content: gstTab },
            { id: 'guards', label: 'Checks', icon: 'shield', content: guardsTab },
            { id: 'display', label: 'Display', icon: 'eye', content: displayTab },
            { id: 'backup', label: 'Backup', icon: 'database', content: backupTab },
          ]}
        />
      </Stack>
    </Screen>
  );
}
