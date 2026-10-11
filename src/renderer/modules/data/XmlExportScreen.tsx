/**
 * 'data.xmlExport' — XML data export: masters and / or the vouchers of a period as an "Import Data"
 * XML for another accounting program (masters only → one .xml; with vouchers → a .zip of
 * 1-Masters.xml + 2-Vouchers.xml), saved through the native Save dialog. Shows what went into the
 * file and how to load it in the other program.
 * Keys: Enter next field · Ctrl+A Export · Alt+B Trial Balance (to compare after loading) · Esc Back.
 */
import { useState } from 'react';
import type { XmlExportResult } from '../../../shared/types/data.ts';
import { api } from '../../app/api.ts';
import { userMessage } from '../../app/lib/apiErrors.ts';
import { useNav } from '../../app/nav.tsx';
import { Screen } from '../../app/Screen.tsx';
import { useBooks, usePeriod, useWorkingDate } from '../../app/working.tsx';
import { Banner, DateInput, Field, FieldGroup, KeyValueList, Panel, Stack, useEnterAdvance } from '../../ui/index.ts';
import { TipCheckbox, useSaveFile } from './components.tsx';
import { openingsNote, xmlExportProblem, xmlExportSummary, xmlImportSteps } from './lib/xmlExportView.ts';

/** What the XML interchange cannot carry (2.1: the "Vouchers" tooltip and the result, not a banner before it). */
const XML_NOT_EXPORTED =
  'Quotations, proforma invoices and physical stock vouchers are not exported (they are not part of the XML interchange). Amounts in foreign currency are exported in rupees.';

export function XmlExportScreen() {
  const nav = useNav();
  const period = usePeriod();
  const { date: workingDate } = useWorkingDate();
  const { booksFrom } = useBooks();
  const save = useSaveFile();
  const [masters, setMasters] = useState(true);
  const [vouchers, setVouchers] = useState(true);
  const [from, setFrom] = useState<string | null>(period.from);
  const [to, setTo] = useState<string | null>(period.to);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ result: XmlExportResult; vouchersAsked: boolean; savedTo: string } | null>(null);

  const problem = xmlExportProblem({ masters, vouchers, from, to });
  const openings = openingsNote({ masters, vouchers, from, to }, booksFrom);

  const run = async (): Promise<void> => {
    if (busy || problem) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const input = { masters, vouchers, from: from ?? period.from, to: to ?? period.to };
      const out = await api('data.xmlExport.create', input);
      if (vouchers && !masters && out.vouchers === 0) {
        setError('There are no vouchers in this period that can go into the XML file. Change the dates.');
        return;
      }
      const savedTo = await save(out.bytes, out.fileName, 'XML Data Export');
      if (savedTo) setDone({ result: out, vouchersAsked: vouchers, savedTo });
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const formRef = useEnterAdvance<HTMLFormElement>({ onComplete: () => void run() });
  const summary = done ? xmlExportSummary(done.result, done.vouchersAsked) : [];
  const steps = done ? xmlImportSteps(done.result.fileName.toLowerCase().endsWith('.zip'), done.result.openingsAsOf) : [];

  return (
    <Screen
      title="XML Data Export"
      subtitle="For another accounting program, your CA or auditor"
      width="form"
      hint="Enter Next field · Ctrl+A Export · Alt+B Trial Balance · Esc Back"
      actions={[
        { key: 'Ctrl+A', label: busy ? 'Exporting…' : 'Export', icon: 'export', primary: true, onClick: () => void run(), disabled: busy || !!problem },
        { key: 'Alt+B', label: 'Trial Balance', icon: 'scale', onClick: () => nav.push('reports.trialBalance', { from: from ?? period.from, to: to ?? period.to }), group: 'view' },
      ]}
    >
      <Stack gap={4}>
        {error ? (
          <Banner tone="danger" title="Nothing was exported" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        ) : null}
        <form ref={formRef} onSubmit={(e) => e.preventDefault()}>
          <Stack gap={4}>
            <FieldGroup legend="What to export" columns={2}>
              <TipCheckbox
                label="Masters"
                tip="Groups, ledgers (GST, party, bank and bill-wise openings), units, godowns, stock groups and items, cost centres, voucher types, aliases"
                checked={masters}
                onChange={setMasters}
                data-autofocus
              />
              <TipCheckbox
                label="Vouchers of the period"
                tip={`Accounting and inventory vouchers with bill-wise, cost-centre, bank and GST details, exactly as recorded. ${XML_NOT_EXPORTED}`}
                checked={vouchers}
                onChange={setVouchers}
              />
            </FieldGroup>
            {vouchers ? (
              <FieldGroup legend="Period" columns={2}>
                <Field label="From" required error={from && to && from > to ? 'After the “to” date' : undefined}>
                  <DateInput value={from} onChange={setFrom} referenceDate={workingDate} />
                </Field>
                <Field label="To" required>
                  <DateInput value={to} onChange={setTo} referenceDate={workingDate} />
                </Field>
              </FieldGroup>
            ) : null}
          </Stack>
        </form>
        {problem ? <p className="bx-muted" role="status">{problem}</p> : openings ? <p className="bx-muted">{openings}</p> : null}
        {done ? (
          <Panel title="Exported">
            <Stack gap={3}>
              <p>
                Saved as <strong>{done.savedTo.split(/[\\/]/).pop()}</strong>.
              </p>
              <KeyValueList items={summary.map((r) => ({ key: r.key, label: r.label, value: r.value }))} alignValues="right" />
              {done.vouchersAsked ? <p className="bx-muted">{XML_NOT_EXPORTED}</p> : null}
              <div>
                <strong>Loading it in the other program</strong>
                <ol className="bx-data-howto">
                  {steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
              </div>
            </Stack>
          </Panel>
        ) : null}
      </Stack>
    </Screen>
  );
}
