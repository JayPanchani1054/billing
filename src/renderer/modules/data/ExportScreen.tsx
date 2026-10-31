/**
 * 'data.export' — export centre: masters (the same columns as the import templates, so a workbook can
 * be imported into another company) and vouchers of a period (headers, ledger entries, stock lines).
 * Ctrl+A exports the tab in view; Alt+M / Alt+V switch tabs.
 */
import { useState } from 'react';
import { ACCOUNTING_BASE_TYPES, PREDEFINED_VOUCHER_TYPES, type VoucherBaseType } from '../../../shared/constants.ts';
import { MASTER_EXPORT_KINDS, type ExportFormat, type MasterExportKind } from '../../../shared/types/data.ts';
import { api } from '../../app/api.ts';
import { userMessage } from '../../app/lib/apiErrors.ts';
import { Screen } from '../../app/Screen.tsx';
import { useFeatures } from '../../app/state.tsx';
import { usePeriod, useWorkingDate } from '../../app/working.tsx';
import { Banner, Button, Checkbox, DateInput, Field, FieldGroup, Inline, SegmentedControl, Stack, Tabs } from '../../ui/index.ts';
import { TipCheckbox, useSaveFile } from './components.tsx';

const MASTER_LABELS: Readonly<Record<MasterExportKind, { label: string; description: string; inventory?: boolean }>> = {
  groups: { label: 'Account groups', description: 'Your own groups and sub-groups' },
  ledgers: { label: 'Ledgers', description: 'Parties, banks, income and expenses with opening balances' },
  stock_groups: { label: 'Stock groups', description: 'Item groups', inventory: true },
  stock_items: { label: 'Stock items', description: 'Items with units, GST and opening stock', inventory: true },
  units: { label: 'Units', description: 'Units of measure', inventory: true },
  godowns: { label: 'Godowns', description: 'Stock locations', inventory: true },
  cost_centres: { label: 'Cost centres', description: 'Branches, projects, departments' },
  voucher_types: { label: 'Voucher types', description: 'Numbering and printing of each type' },
};

const FORMAT_OPTIONS = [
  { value: 'xlsx' as const, label: 'Excel (.xlsx)' },
  { value: 'csv' as const, label: 'CSV' },
];

const typeLabel = (b: VoucherBaseType): string => PREDEFINED_VOUCHER_TYPES.find((t) => t.baseType === b)?.name ?? b;

export function ExportScreen() {
  const features = useFeatures();
  const period = usePeriod();
  const { date: workingDate } = useWorkingDate();
  const save = useSaveFile();
  const [tab, setTab] = useState<'masters' | 'vouchers'>('masters');
  const inventory = features?.inventory !== false;
  const availableKinds = MASTER_EXPORT_KINDS.filter((k) => inventory || !MASTER_LABELS[k].inventory);
  const [kinds, setKinds] = useState<MasterExportKind[]>(['groups', 'ledgers', ...(inventory ? (['stock_items'] as MasterExportKind[]) : [])]);
  const [mFormat, setMFormat] = useState<ExportFormat>('xlsx');
  const [from, setFrom] = useState<string | null>(period.from);
  const [to, setTo] = useState<string | null>(period.to);
  const [allTypes, setAllTypes] = useState(true);
  const [types, setTypes] = useState<VoucherBaseType[]>([...ACCOUNTING_BASE_TYPES]);
  const [includeOptional, setIncludeOptional] = useState(true);
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [vFormat, setVFormat] = useState<ExportFormat>('xlsx');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = <T,>(list: T[], v: T, on: boolean): T[] => (on ? [...list.filter((x) => x !== v), v] : list.filter((x) => x !== v));

  const mastersProblem = kinds.length === 0 ? 'Tick at least one kind of master.' : null;
  const vouchersProblem = !from || !to ? 'Enter both dates.' : from > to ? 'The “from” date is after the “to” date.' : !allTypes && types.length === 0 ? 'Tick at least one voucher type.' : null;

  const exportMasters = async () => {
    if (busy || mastersProblem) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api('data.export.masters', { kinds: MASTER_EXPORT_KINDS.filter((k) => kinds.includes(k)), format: mFormat });
      await save(out.bytes, out.fileName, 'Export masters');
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const exportVouchers = async () => {
    if (busy || vouchersProblem || !from || !to) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api('data.export.vouchers', { from, to, baseTypes: allTypes ? undefined : types, includeOptional, includeCancelled, format: vFormat });
      if (out.rowCount === 0) {
        setError('There are no vouchers in this period with these choices. Change the dates or the voucher types.');
        return;
      }
      await save(out.bytes, out.fileName, 'Export vouchers');
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const run = () => void (tab === 'masters' ? exportMasters() : exportVouchers());

  const mastersTab = (
    <Stack gap={4}>
      <FieldGroup legend="What to export" columns={2}>
        {availableKinds.map((k) => (
          <TipCheckbox key={k} label={MASTER_LABELS[k].label} tip={MASTER_LABELS[k].description} checked={kinds.includes(k)} onChange={(on) => setKinds((l) => toggle(l, k, on))} />
        ))}
      </FieldGroup>
      <Inline gap={2}>
        <Button size="sm" variant="ghost" onClick={() => setKinds([...availableKinds])}>
          Tick all
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setKinds([])}>
          Clear
        </Button>
      </Inline>
      <Field label="Format" hint={mFormat === 'csv' && kinds.length > 1 ? 'Several CSV files come as one .zip file.' : 'Sheets use the same columns as the import templates.'}>
        <SegmentedControl aria-label="Masters file format" options={FORMAT_OPTIONS} value={mFormat} onChange={setMFormat} />
      </Field>
      {mastersProblem ? <p className="bx-muted" role="status">{mastersProblem}</p> : null}
    </Stack>
  );

  const vouchersTab = (
    <Stack gap={4}>
      <FieldGroup legend="Period" columns={2}>
        <Field label="From" required error={from && to && from > to ? 'After the “to” date' : undefined}>
          <DateInput value={from} onChange={setFrom} referenceDate={workingDate} />
        </Field>
        <Field label="To" required>
          <DateInput value={to} onChange={setTo} referenceDate={workingDate} />
        </Field>
      </FieldGroup>
      <FieldGroup legend="Voucher types" columns={3}>
        <Checkbox label="All voucher types" checked={allTypes} onChange={setAllTypes} />
        {!allTypes
          ? ACCOUNTING_BASE_TYPES.map((b) => <Checkbox key={b} label={typeLabel(b)} checked={types.includes(b)} onChange={(on) => setTypes((l) => toggle(l, b, on))} />)
          : null}
      </FieldGroup>
      <FieldGroup legend="Include" columns={2}>
        <TipCheckbox label="Optional vouchers" tip="Entries marked optional (not in the books)" checked={includeOptional} onChange={setIncludeOptional} />
        <TipCheckbox label="Cancelled vouchers" tip="Kept for the number series, with no amounts" checked={includeCancelled} onChange={setIncludeCancelled} />
      </FieldGroup>
      <Field
        label="Format"
        hint={`${vFormat === 'csv' ? 'Three CSV files (vouchers, ledger entries, stock lines) in one .zip file.' : 'One workbook with three sheets: Vouchers, Ledger Entries, Inventory Entries.'} A line’s own text is under Line Narration (ledger entries) or Description (stock lines).`}
      >
        <SegmentedControl aria-label="Vouchers file format" options={FORMAT_OPTIONS} value={vFormat} onChange={setVFormat} />
      </Field>
      {vouchersProblem ? <p className="bx-muted" role="status">{vouchersProblem}</p> : null}
    </Stack>
  );

  return (
    <Screen
      title="Export Data"
      subtitle="Masters and vouchers to Excel or CSV"
      width="form"
      hint="Ctrl+A Export · Alt+M Masters · Alt+V Vouchers · Esc Back"
      actions={[
        { key: 'Ctrl+A', label: busy ? 'Exporting…' : tab === 'masters' ? 'Export masters' : 'Export vouchers', icon: 'export', primary: true, onClick: run, disabled: busy || !!(tab === 'masters' ? mastersProblem : vouchersProblem) },
        { key: 'Alt+M', label: 'Masters', icon: 'book', onClick: () => setTab('masters'), group: 'view' },
        { key: 'Alt+V', label: 'Vouchers', icon: 'journal', onClick: () => setTab('vouchers'), group: 'view' },
      ]}
    >
      <Stack gap={4}>
        {error ? (
          <Banner tone="danger" title="Nothing was exported" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        ) : null}
        <Tabs
          aria-label="Export"
          value={tab}
          onChange={(id) => setTab(id === 'vouchers' ? 'vouchers' : 'masters')}
          items={[
            { id: 'masters', label: 'Masters', content: mastersTab },
            { id: 'vouchers', label: 'Vouchers', content: vouchersTab },
          ]}
        />
      </Stack>
    </Screen>
  );
}
