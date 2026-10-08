/**
 * 'accounts.currencies' (F11 multi-currency) — currencies on the left (with their latest rate),
 * exchange rates by date for the chosen currency on the right. Rates are rupees per one unit.
 * Alt+C new currency · Alt+R new rate (saving an existing date updates it) · Enter alters ·
 * Ctrl+D deletes the highlighted rate (or currency when that list has focus).
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import { formatRate } from '../../../shared/format.ts';
import type { CurrencyRow, ExchangeRateRow } from '../../../shared/types/accounts.ts';
import { api } from '../../app/api.ts';
import { useConfirm } from '../../app/confirm.tsx';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { fieldErrorsOf, userMessage } from '../../app/lib/apiErrors.ts';
import { invalidate } from '../../app/queryClient.ts';
import { Screen } from '../../app/Screen.tsx';
import { useCan } from '../../app/state.tsx';
import { useWorkingDate } from '../../app/working.tsx';
import { Banner, Button, DataTable, DateInput, EmptyState, Field, Modal, NumberInput, Stack, TextInput, useEnterAdvance, useToast } from '../../ui/index.ts';
import type { Column } from '../../ui/index.ts';
import { DialogAccept, NameCell } from './components.tsx';

type Pane = 'currencies' | 'rates';
const RATE_PAGE = 500;

const rateText = (v: number | null): string => (v === null ? '' : formatRate(v));

export function CurrenciesScreen() {
  const toast = useToast();
  const confirm = useConfirm();
  const canCreate = useCan('masters.create');
  const canAlter = useCan('masters.alter');
  const canDelete = useCan('masters.delete');
  const cq = useApiQuery('accounts.currency.list', {}, { keepPrevious: true });
  const currencies = cq.data?.rows ?? [];
  const [curKey, setCurKey] = useState<string | null>(null);
  const currency = currencies.find((c) => String(c.id) === curKey) ?? currencies.find((c) => !c.isBase) ?? currencies[0] ?? null;
  const rq = useApiQuery('accounts.exchangeRate.list', { currencyId: currency?.id ?? 0, limit: RATE_PAGE }, { enabled: currency !== null && !currency.isBase, keepPrevious: true });
  const rates = currency?.isBase ? [] : (rq.data?.rows ?? []);
  const [rateKey, setRateKey] = useState<string | null>(null);
  const rate = rates.find((r) => String(r.id) === rateKey) ?? null;
  const [pane, setPane] = useState<Pane>('rates');
  const [curDialog, setCurDialog] = useState<CurrencyRow | 'new' | null>(null);
  const [rateDialog, setRateDialog] = useState<ExchangeRateRow | 'new' | null>(null);

  const curColumns = useMemo<Column<CurrencyRow>[]>(
    () => [
      { key: 'symbol', header: 'Symbol', width: 80 },
      { key: 'formalName', header: 'Name', render: (r) => <NameCell name={r.formalName} alias={r.isoCode} predefined={r.isBase} /> },
      { key: 'latest', header: 'Latest rate (₹)', width: 140, align: 'right', value: (r) => (r.latestRate ? rateText(r.latestRate.standard ?? r.latestRate.selling ?? r.latestRate.buying) : '') },
    ],
    [],
  );
  const rateColumns = useMemo<Column<ExchangeRateRow>[]>(
    () => [
      { key: 'date', header: 'Date', kind: 'date', width: 130 },
      { key: 'standard', header: 'Standard', align: 'right', value: (r) => rateText(r.standard) },
      { key: 'selling', header: 'Selling', align: 'right', value: (r) => rateText(r.selling) },
      { key: 'buying', header: 'Buying', align: 'right', value: (r) => rateText(r.buying) },
    ],
    [],
  );

  const remove = async () => {
    if (pane === 'currencies') {
      if (!currency) return;
      if (currency.isBase) {
        toast.info('The base currency cannot be deleted');
        return;
      }
      if (!(await confirm({ title: `Delete currency ${currency.symbol}?`, message: 'Its exchange rates are deleted too. A currency used by ledgers cannot be deleted.', confirmLabel: 'Delete', tone: 'danger' }))) return;
      try {
        await api('accounts.currency.delete', { id: currency.id });
        invalidate('accounts');
        setCurKey(null);
        toast.success(`Currency ${currency.symbol} deleted`);
      } catch (err) {
        toast.error(`${currency.symbol} cannot be deleted`, { message: userMessage(err), duration: 10_000 });
      }
      return;
    }
    if (!rate || !currency) return;
    if (!(await confirm({ title: `Delete the rate of ${formatDate(rate.date)}?`, confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      await api('accounts.exchangeRate.delete', { id: rate.id });
      invalidate('accounts');
      toast.success('Exchange rate deleted');
    } catch (err) {
      toast.error('Could not delete the rate', { message: userMessage(err) });
    }
  };

  return (
    <Screen
      title="Currencies"
      subtitle="Foreign currencies and their exchange rates (rupees per unit) by date."
      icon="rupee"
      loading={cq.loading}
      error={cq.error}
      onRetry={() => void cq.refetch()}
      hint="Enter Alter · Alt+C New currency · Alt+R New rate · Ctrl+D Delete · Esc Back"
      actions={[
        { key: 'Alt+C', label: 'Create currency', icon: 'plus', primary: true, disabled: !canCreate, onClick: () => setCurDialog('new') },
        { key: 'Alt+R', label: 'Enter rate', icon: 'calendar', disabled: !canCreate || !currency || currency.isBase, onClick: () => setRateDialog('new') },
        { key: 'Ctrl+D', label: 'Delete', icon: 'trash', group: 'danger', disabled: !canDelete || (pane === 'rates' ? !rate : !currency || currency.isBase), onClick: () => void remove() },
      ]}
    >
      <div className="bx-acc-split">
        <div className="bx-acc-pane" onFocus={() => setPane('currencies')}>
          <strong>Currencies</strong>
          <div className="bx-acc-pane__table">
            <DataTable<CurrencyRow>
              aria-label="Currencies"
              columns={curColumns}
              rows={currencies}
              getRowKey={(r) => String(r.id)}
              selectedKey={currency ? String(currency.id) : null}
              onSelect={(k) => setCurKey(k)}
              onRowActivate={(r) => canAlter && setCurDialog(r)}
              empty={<EmptyState title="No currencies" body="Press Alt+C to add one (e.g. $ US Dollar)." size="sm" />}
            />
          </div>
        </div>
        <div className="bx-acc-pane" onFocus={() => setPane('rates')}>
          <strong>{currency ? `Rates of ${currency.formalName}` : 'Rates'}</strong>
          {currency?.isBase ? (
            <Banner tone="info" inline>
              {currency.formalName} is the base currency: every other currency is converted into it, so it has no exchange rate.
            </Banner>
          ) : (
            <div className="bx-acc-pane__table">
              <DataTable<ExchangeRateRow>
                aria-label="Exchange rates"
                autoFocus
                columns={rateColumns}
                rows={rates}
                getRowKey={(r) => String(r.id)}
                selectedKey={rateKey}
                onSelect={(k) => setRateKey(k)}
                onRowActivate={(r) => canAlter && setRateDialog(r)}
                loading={rq.loading}
                empty={
                  <EmptyState
                    icon="calendar"
                    title="No rates yet"
                    body="Enter the rate for a date; vouchers use the latest rate on or before their date."
                    size="sm"
                    action={canCreate && currency ? <Button icon="plus" onClick={() => setRateDialog('new')}>Enter rate</Button> : undefined}
                  />
                }
              />
            </div>
          )}
          {rq.data && rq.data.total > rates.length ? <span className="bx-muted">Showing the latest {rates.length} of {rq.data.total} rates.</span> : null}
        </div>
      </div>
      {curDialog ? <CurrencyDialog row={curDialog === 'new' ? null : curDialog} onClose={() => setCurDialog(null)} onSaved={(id) => setCurKey(String(id))} /> : null}
      {rateDialog && currency ? <RateDialog row={rateDialog === 'new' ? null : rateDialog} currency={currency} onClose={() => setRateDialog(null)} /> : null}
    </Screen>
  );
}

function CurrencyDialog({ row, onClose, onSaved }: { row: CurrencyRow | null; onClose: () => void; onSaved: (id: number) => void }) {
  const toast = useToast();
  const save = useApiMutation('accounts.currency.save');
  const [symbol, setSymbol] = useState(row?.symbol ?? '');
  const [formalName, setFormalName] = useState(row?.formalName ?? '');
  const [isoCode, setIsoCode] = useState(row?.isoCode ?? '');
  const [decimals, setDecimals] = useState<number | null>(row?.decimalPlaces ?? 2);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submitRef = useRef<() => Promise<void>>(async () => undefined);
  submitRef.current = async () => {
    if (save.pending) return;
    const e: Record<string, string> = {};
    if (!symbol.trim()) e.symbol = 'Enter the symbol, e.g. $';
    if (!formalName.trim()) e.formalName = 'Enter the name, e.g. US Dollar';
    if (isoCode.trim() && !/^[A-Za-z]{3}$/.test(isoCode.trim())) e.isoCode = 'ISO code is 3 letters, e.g. USD';
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    try {
      const out = await save.mutate({ id: row?.id, symbol: symbol.trim(), formalName: formalName.trim(), isoCode: isoCode.trim().toUpperCase() || null, decimalPlaces: decimals ?? 2 });
      toast.success(`Currency ${out.symbol} saved`);
      onSaved(out.id);
      onClose();
    } catch (err) {
      const f = fieldErrorsOf(err);
      setErrors(Object.keys(f).length > 0 ? f : { symbol: userMessage(err) });
    }
  };
  const accept = useCallback(() => void submitRef.current(), []);
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: accept });
  return (
    <Modal
      open
      onClose={onClose}
      title={row ? 'Alter Currency' : 'Create Currency'}
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
          <Field label="Symbol" required error={errors.symbol}>
            <TextInput data-autofocus value={symbol} onChange={(e) => setSymbol(e.target.value)} maxLength={10} />
          </Field>
          <Field label="Formal name" required error={errors.formalName}>
            <TextInput value={formalName} onChange={(e) => setFormalName(e.target.value)} maxLength={60} />
          </Field>
          <Field label="ISO code" optional error={errors.isoCode} hint={row?.isBase ? 'Fixed for the base currency.' : 'Three letters, e.g. USD, EUR, AED.'}>
            <TextInput value={isoCode} onChange={(e) => setIsoCode(e.target.value.toUpperCase().slice(0, 3))} readOnly={row?.isBase} uppercase mono />
          </Field>
          <Field label="Decimal places" error={errors.decimalPlaces}>
            <NumberInput value={decimals} onChange={setDecimals} min={0} max={4} />
          </Field>
        </Stack>
      </div>
    </Modal>
  );
}

function RateDialog({ row, currency, onClose }: { row: ExchangeRateRow | null; currency: CurrencyRow; onClose: () => void }) {
  const toast = useToast();
  const { date: workingDate } = useWorkingDate();
  const save = useApiMutation('accounts.exchangeRate.save');
  const [date, setDate] = useState<string | null>(row?.date ?? workingDate);
  const [standard, setStandard] = useState<number | null>(row?.standard ?? null);
  const [selling, setSelling] = useState<number | null>(row?.selling ?? null);
  const [buying, setBuying] = useState<number | null>(row?.buying ?? null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submitRef = useRef<() => Promise<void>>(async () => undefined);
  submitRef.current = async () => {
    if (save.pending) return;
    const e: Record<string, string> = {};
    if (!date) e.date = 'Enter the date';
    if (standard === null && selling === null && buying === null) e.standard = 'Enter at least one rate';
    for (const [k, v] of [['standard', standard], ['selling', selling], ['buying', buying]] as const) if (v !== null && v <= 0) e[k] = 'A rate must be more than 0';
    setErrors(e);
    if (Object.keys(e).length > 0 || !date) return;
    try {
      await save.mutate({ currencyId: currency.id, date, standard, selling, buying });
      toast.success(`Rate of ${formatDate(date)} saved`);
      onClose();
    } catch (err) {
      const f = fieldErrorsOf(err);
      setErrors(Object.keys(f).length > 0 ? f : { standard: userMessage(err) });
    }
  };
  const accept = useCallback(() => void submitRef.current(), []);
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: accept });
  const unit = `₹ per 1 ${currency.symbol}`;
  return (
    <Modal
      open
      onClose={onClose}
      title={`Exchange rate — ${currency.formalName}`}
      description="Saving a date that already has a rate updates it."
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
          <Field label="Date" required error={errors.date}>
            <DateInput data-autofocus value={date} onChange={setDate} referenceDate={workingDate} readOnly={row !== null} />
          </Field>
          <Field label="Standard rate" error={errors.standard} hint={unit}>
            <NumberInput value={standard} onChange={setStandard} decimals={4} min={0} />
          </Field>
          <Field label="Selling rate" optional error={errors.selling} hint="Used for sales and receipts.">
            <NumberInput value={selling} onChange={setSelling} decimals={4} min={0} />
          </Field>
          <Field label="Buying rate" optional error={errors.buying} hint="Used for purchases and payments.">
            <NumberInput value={buying} onChange={setBuying} decimals={4} min={0} />
          </Field>
        </Stack>
      </div>
    </Modal>
  );
}
