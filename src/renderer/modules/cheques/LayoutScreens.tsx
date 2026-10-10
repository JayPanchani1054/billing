/**
 * Cheque layouts (F11 › Cheque printing):
 *   'cheques.layouts'      —             saved layouts with the banks using them. Alt+C create (from a preset)
 *                                        · Enter / Alt+A alter · Alt+D delete (when no bank uses it)
 *   'cheques.layout.form'  {id?, preset?} name, preset, how the leaf is fed (own page / on A4), leaf size,
 *                                        font, and the position of every field in mm from the leaf's
 *                                        top-left corner (date boxes DDMMYYYY with their pitch, payee, amount
 *                                        in words on two lines, figures, 'A/c Payee' crossing, signatory),
 *                                        plus the calibration shift. Live preview: Ctrl+1 sample cheque /
 *                                        Ctrl+2 calibration grid. Alt+K prints the calibration sheet, Alt+T a
 *                                        sample cheque (plain paper), Ctrl+A saves.
 * Calibration: print the grid on plain paper, hold it against a real leaf in front of a light, read
 * where each box falls on the leaf's printed lines, and correct the positions — or, when everything is
 * off by the same amount, the shift. The presets are starting points (core: cheques/layouts.ts).
 */
import { useMemo, useState } from 'react';
import type { ChequeLayout, ChequeLayoutSpec, ChequePreset } from '../../../shared/types/cheques.ts';
import { fieldErrorsOf, native, ReadOnlyNotice, ReportScreen, Screen, useApiMutation, useApiQuery, useCan, useCompany, useConfirm, useNav, userMessage, type ScreenProps } from '../../app/index.ts';
import { Badge, Banner, Button, DataTable, EmptyState, Field, FieldGroup, Inline, NumberInput, SegmentedControl, Select, Stack, Switch, TextInput, useEnterAdvance, useToast, type Column } from '../../ui/index.ts';
import { ChequeSheets, ChequesOff, useChequesOn } from './components.tsx';
import { buildChequeHtml, calibrationMarks, chequeMarks, chequePage, chequePagesMarkup } from './lib/cheque.ts';
import { CHEQUE_INVALIDATES, LAYOUT_FIELDS, PLACEMENT_LABELS, pointError, SAMPLE_CHEQUE, suggestedLayoutName, withPoint, type LayoutPointKey } from './lib/model.ts';

// ───────────────────────────── List ─────────────────────────────

export function ChequeLayoutsScreen() {
  const on = useChequesOn();
  if (!on) return <ChequesOff title="Cheque Layouts" />;
  return <LayoutList />;
}

function LayoutList() {
  const nav = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const canAlter = useCan('masters.alter');
  const q = useApiQuery('cheques.layout.list', {});
  const del = useApiMutation('cheques.layout.delete', { invalidates: CHEQUE_INVALIDATES });
  const [cursor, setCursor] = useState<string | null>(null);
  const rows = useMemo(() => q.data ?? [], [q.data]);
  const current = rows.find((r) => String(r.id) === cursor) ?? rows[0] ?? null;
  const remove = async (l: ChequeLayout): Promise<void> => {
    if (!(await confirm({ title: `Delete the layout ${l.name}?`, message: 'Banks without a layout print with the CTS-2010 standard preset.', confirmLabel: 'Delete', tone: 'danger' }))) return;
    try {
      await del.mutate({ id: l.id });
      toast.success(`Layout ${l.name} deleted`);
      setCursor(null);
    } catch (err) {
      toast.error('Not deleted', { message: userMessage(err) });
    }
  };
  const columns = useMemo<Column<ChequeLayout>[]>(
    () => [
      { key: 'name', header: 'Layout', minWidth: 220, sortable: true },
      { key: 'size', header: 'Leaf', width: 130, value: (r) => `${r.spec.widthMm} × ${r.spec.heightMm} mm` },
      { key: 'placement', header: 'Fed as', minWidth: 200, value: (r) => PLACEMENT_LABELS[r.spec.placement] },
      { key: 'shift', header: 'Shift (mm)', width: 120, value: (r) => (r.spec.offsetX || r.spec.offsetY ? `${r.spec.offsetX} → / ${r.spec.offsetY} ↓` : '') },
      {
        key: 'usedBy',
        header: 'Used by',
        minWidth: 200,
        value: (r) => r.usedBy.join(', '),
        render: (r) => (r.usedBy.length === 0 ? <Badge size="sm">Not used</Badge> : r.usedBy.join(', ')),
      },
    ],
    [],
  );
  return (
    <ReportScreen
      title="Cheque Layouts"
      periodMode="none"
      loading={q.loading}
      refreshing={q.refreshing}
      error={q.error}
      onRetry={() => void q.refetch()}
      hint="Enter Alter · Alt+C Create layout · Alt+D Delete · Alt+S Bank print settings · Alt+E Export"
      actions={[
        { key: 'Alt+C', label: 'Create layout', icon: 'plus', primary: true, onClick: () => nav.push('cheques.layout.form', {}), hidden: !canAlter },
        { key: 'Alt+A', label: 'Alter', icon: 'edit', onClick: () => current && nav.push('cheques.layout.form', { id: current.id }), disabled: !current },
        { key: 'Alt+S', label: 'Bank print settings', icon: 'settings', onClick: () => nav.push('cheques.bank', {}), group: 'go' },
        { key: 'Alt+D', label: 'Delete', icon: 'trash', onClick: () => current && void remove(current), disabled: !current || current.usedBy.length > 0 || del.pending, hidden: !canAlter, group: 'danger' },
      ]}
      exportDef={() => ({
        title: 'Cheque Layouts',
        columns: [{ header: 'Layout' }, { header: 'Leaf' }, { header: 'Fed as' }, { header: 'Shift right (mm)', kind: 'number', decimals: 1 }, { header: 'Shift down (mm)', kind: 'number', decimals: 1 }, { header: 'Used by' }],
        rows: rows.map((r) => [r.name, `${r.spec.widthMm} × ${r.spec.heightMm} mm`, PLACEMENT_LABELS[r.spec.placement], r.spec.offsetX, r.spec.offsetY, r.usedBy.join(', ')]),
      })}
    >
      <DataTable<ChequeLayout>
        aria-label="Cheque layouts"
        autoFocus
        columns={columns}
        rows={rows}
        getRowKey={(r) => String(r.id)}
        selectedKey={current ? String(current.id) : null}
        onSelect={(k) => setCursor(k)}
        onRowActivate={(r) => nav.push('cheques.layout.form', { id: r.id })}
        loading={q.loading}
        empty={<EmptyState icon="layers" title="No cheque layouts yet" body="Until you create one, cheques print with the CTS-2010 standard preset. Press Alt+C, start from a preset and calibrate it against one of your leaves." />}
      />
    </ReportScreen>
  );
}

// ───────────────────────────── Form ─────────────────────────────

export function ChequeLayoutFormScreen({ params }: ScreenProps<{ id?: number; preset?: string }>) {
  const on = useChequesOn();
  const id = typeof params.id === 'number' ? params.id : undefined;
  const presets = useApiQuery('cheques.layout.presets', {}, { enabled: on, staleTime: Infinity });
  const layouts = useApiQuery('cheques.layout.list', {}, { enabled: on && id !== undefined, staleTime: 0 });
  if (!on) return <ChequesOff title="Cheque Layout" />;
  const saved = id !== undefined ? (layouts.data?.find((l) => l.id === id) ?? null) : null;
  const loading = presets.loading || (id !== undefined && layouts.loading);
  if (!presets.data || (id !== undefined && !saved)) {
    return (
      <Screen title="Cheque Layout" icon="layers" loading={loading} error={presets.error ?? layouts.error} onRetry={() => { void presets.refetch(); void layouts.refetch(); }}>
        {!loading && id !== undefined && !saved ? <EmptyState icon="layers" title="This layout no longer exists" body="It may have been deleted. Press Esc to go back." /> : null}
      </Screen>
    );
  }
  const preset = presets.data.find((p) => p.code === params.preset) ?? presets.data[0];
  return <LayoutForm key={saved ? `${saved.id}:${JSON.stringify(saved.spec)}` : 'new'} saved={saved} presets={presets.data} preset={preset} />;
}

type PreviewMode = 'sample' | 'calibration';

function LayoutForm({ saved, presets, preset }: { saved: ChequeLayout | null; presets: readonly ChequePreset[]; preset: ChequePreset }) {
  const nav = useNav();
  const toast = useToast();
  const company = useCompany();
  const canAlter = useCan('masters.alter');
  const readOnly = !canAlter;
  const initial = useMemo(() => ({ name: saved?.name ?? suggestedLayoutName(preset.name), preset: saved?.preset ?? preset.code, spec: saved?.spec ?? preset.spec }), [saved, preset]);
  const [name, setName] = useState(initial.name);
  const [presetCode, setPresetCode] = useState<string>(initial.preset ?? '');
  const [spec, setSpec] = useState<ChequeLayoutSpec>(initial.spec);
  const [mode, setMode] = useState<PreviewMode>('sample');
  const [printing, setPrinting] = useState(false);
  const save = useApiMutation('cheques.layout.save', { invalidates: CHEQUE_INVALIDATES });
  const errors = save.fieldErrors;
  const dirty = name !== initial.name || presetCode !== (initial.preset ?? '') || JSON.stringify(spec) !== JSON.stringify(initial.spec);
  const sample = useMemo(() => chequeMarks({ ...SAMPLE_CHEQUE, companyName: company?.name ?? SAMPLE_CHEQUE.companyName }, spec), [spec, company?.name]);
  const calibration = useMemo(() => calibrationMarks(spec), [spec]);
  const pages = mode === 'sample' ? [{ key: 'sample', marks: sample.marks }] : [{ key: 'grid', marks: calibration }];
  const set = (p: Partial<ChequeLayoutSpec>): void => setSpec((s) => ({ ...s, ...p }));
  const applyPreset = (code: string): void => {
    const p = presets.find((x) => x.code === code);
    setPresetCode(code);
    if (!p) return;
    // Keep the calibration shift: it belongs to this printer, not to the leaf.
    setSpec((s) => ({ ...p.spec, offsetX: s.offsetX, offsetY: s.offsetY }));
    if (!saved && name === initial.name) setName(suggestedLayoutName(p.name));
  };

  const submit = async (): Promise<void> => {
    if (readOnly || save.pending) return;
    try {
      const out = await save.mutate({ ...(saved ? { id: saved.id } : {}), name, preset: presetCode || null, spec });
      toast.success(`Layout ${out.name} saved`, { message: saved ? undefined : 'Choose it for a bank in Cheque Printing Settings (Alt+S on the list).' });
      nav.pop();
    } catch (err) {
      if (Object.keys(fieldErrorsOf(err)).length === 0) toast.error('Not saved', { message: userMessage(err) });
      else toast.error('Check the layout', { message: 'Some positions are outside the leaf or in the MICR band: see the highlighted cells.' });
    }
  };

  /** Print one page (calibration grid / sample cheque) — no books data, so not an export. */
  const printPage = async (what: PreviewMode): Promise<void> => {
    if (printing) return;
    setPrinting(true);
    try {
      const marks = what === 'sample' ? sample.marks : calibration;
      const html = buildChequeHtml({ title: what === 'sample' ? 'Sample cheque' : 'Cheque calibration sheet', body: chequePagesMarkup([{ marks }], spec), spec });
      const res = await native('print.print', { html, ...chequePage(spec).native });
      if (res.printed) toast.success(what === 'sample' ? 'Sample cheque sent to the printer' : 'Calibration sheet sent to the printer', { message: 'Hold it against a leaf in front of a light and correct the positions.' });
    } catch (err) {
      toast.error('Could not print', { message: userMessage(err) });
    } finally {
      setPrinting(false);
    }
  };

  const formRef = useEnterAdvance<HTMLFormElement>({ onComplete: () => void submit() });
  const num = (v: number | null, fallback: number): number => (v === null || !Number.isFinite(v) ? fallback : v);

  return (
    <Screen
      title={saved ? 'Cheque Layout Alteration' : 'Cheque Layout Creation'}
      subtitle={saved?.usedBy.length ? `Used by ${saved.usedBy.join(', ')}` : undefined}
      icon="layers"
      dirty={dirty}
      hint="Enter Next field · Ctrl+A Save · Alt+K Print calibration sheet · Alt+T Test print · Ctrl+1 Sample / Ctrl+2 Grid · Esc Back"
      actions={[
        { key: 'Ctrl+A', label: 'Save', icon: 'save', primary: true, onClick: () => void submit(), disabled: readOnly || !dirty || save.pending, hidden: readOnly },
        { key: 'Alt+K', label: 'Print calibration sheet', icon: 'grid', onClick: () => void printPage('calibration'), disabled: printing, group: 'output' },
        { key: 'Alt+T', label: 'Test print (sample cheque)', icon: 'print', onClick: () => void printPage('sample'), disabled: printing, group: 'output' },
        { key: 'Ctrl+1', label: 'Sample cheque', onClick: () => setMode('sample'), disabled: mode === 'sample', group: 'view' },
        { key: 'Ctrl+2', label: 'Calibration grid', onClick: () => setMode('calibration'), disabled: mode === 'calibration', group: 'view' },
      ]}
    >
      <Stack gap={5}>
        <form ref={formRef} onSubmit={(e) => e.preventDefault()} aria-label="Cheque layout">
          <Stack gap={5}>
            {readOnly ? <ReadOnlyNotice what="these layout settings" /> : null}
            <FieldGroup legend="Layout" columns={3}>
              <Field label="Name" required error={errors.name}>
                <TextInput data-autofocus="" value={name} maxLength={80} readOnly={readOnly} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Start from preset" hint={presets.find((p) => p.code === presetCode)?.description}>
                <Select aria-label="Preset" value={presetCode} disabled={readOnly} options={[{ value: '', label: 'Own positions' }, ...presets.map((p) => ({ value: p.code, label: p.name }))]} onChange={(v: string) => (v ? applyPreset(v) : setPresetCode(''))} />
              </Field>
              <Field label="How the leaf is fed" error={errors['spec.placement']}>
                <Select<ChequeLayoutSpec['placement']> aria-label="Placement" value={spec.placement} disabled={readOnly} options={(Object.keys(PLACEMENT_LABELS) as Array<ChequeLayoutSpec['placement']>).map((k) => ({ value: k, label: PLACEMENT_LABELS[k] }))} onChange={(v) => set({ placement: v })} />
              </Field>
              <Field label="Leaf width (mm)" error={errors['spec.widthMm']} hint="CTS-2010: 202">
                <NumberInput value={spec.widthMm} decimals={1} min={150} max={230} readOnly={readOnly} onChange={(v) => set({ widthMm: num(v, spec.widthMm) })} />
              </Field>
              <Field label="Leaf height (mm)" error={errors['spec.heightMm']} hint="CTS-2010: 92 (bottom 16 mm is the MICR band)">
                <NumberInput value={spec.heightMm} decimals={1} min={70} max={110} readOnly={readOnly} onChange={(v) => set({ heightMm: num(v, spec.heightMm) })} />
              </Field>
              <Field label="Font size (pt)" error={errors['spec.fontPt']}>
                <NumberInput value={spec.fontPt} decimals={1} min={7} max={16} step={0.5} readOnly={readOnly} onChange={(v) => set({ fontPt: num(v, spec.fontPt) })} />
              </Field>
              <Field label="Shift right (mm)" error={errors['spec.offsetX']} hint="Calibration: negative moves left">
                <NumberInput value={spec.offsetX} decimals={1} min={-30} max={30} step={0.5} readOnly={readOnly} onChange={(v) => set({ offsetX: num(v, 0) })} />
              </Field>
              <Field label="Shift down (mm)" error={errors['spec.offsetY']} hint="Calibration: negative moves up">
                <NumberInput value={spec.offsetY} decimals={1} min={-30} max={30} step={0.5} readOnly={readOnly} onChange={(v) => set({ offsetY: num(v, 0) })} />
              </Field>
              <Field label="Paise in figures" hint={spec.figuresPaise ? '**1,180.00/-' : '**1,180/- (paise printed only when there are some)'}>
                <Switch checked={spec.figuresPaise} disabled={readOnly} onChange={(v) => set({ figuresPaise: v })} />
              </Field>
            </FieldGroup>
            <FieldGroup legend="Positions on the leaf (mm from its top-left corner)">
              <PositionTable spec={spec} errors={errors} readOnly={readOnly} onChange={(key, part, value) => setSpec((s) => withPoint(s, key, part, value))} onPitch={(v) => setSpec((s) => ({ ...s, date: { ...s.date, pitch: v } }))} />
            </FieldGroup>
          </Stack>
        </form>
        {sample.warnings.length > 0 && mode === 'sample' ? (
          <Banner tone="warning" title="With the sample cheque">
            <ul>
              {sample.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Banner>
        ) : null}
        <Inline gap={3} align="center">
          <SegmentedControl<PreviewMode> aria-label="Preview" size="sm" value={mode} onChange={setMode} options={[{ value: 'sample', label: 'Sample cheque' }, { value: 'calibration', label: 'Calibration grid' }]} />
          <Button icon="grid" onClick={() => void printPage('calibration')} disabled={printing} shortcut="Alt+K">
            Print calibration sheet
          </Button>
        </Inline>
        <ChequeSheets pages={pages} spec={spec} rootRef={null} label={mode === 'sample' ? 'Preview of a sample cheque' : 'Calibration grid'} />
      </Stack>
    </Screen>
  );
}

function PositionTable({
  spec,
  errors,
  readOnly,
  onChange,
  onPitch,
}: {
  spec: ChequeLayoutSpec;
  errors: Readonly<Record<string, string>>;
  readOnly: boolean;
  onChange: (key: LayoutPointKey, part: 'x' | 'y' | 'w', value: number) => void;
  onPitch: (value: number) => void;
}) {
  return (
    <table className="cq-pos" aria-label="Field positions">
      <thead>
        <tr>
          <th scope="col">Field</th>
          <th scope="col">From left</th>
          <th scope="col">From top</th>
          <th scope="col">Width / box pitch</th>
        </tr>
      </thead>
      <tbody>
        {LAYOUT_FIELDS.map((f) => {
          const p = spec[f.key];
          const ex = pointError(errors, f.key, 'x');
          const ey = pointError(errors, f.key, 'y');
          const ew = f.key === 'date' ? errors['spec.date.pitch'] : pointError(errors, f.key, 'w');
          return (
            <tr key={f.key}>
              <th scope="row">{f.label}</th>
              <td>
                <NumberInput aria-label={`${f.label}: mm from the left`} size="sm" value={p.x} decimals={1} min={0} readOnly={readOnly} invalid={!!ex} title={ex} onChange={(v) => v !== null && onChange(f.key, 'x', v)} />
              </td>
              <td>
                <NumberInput aria-label={`${f.label}: mm from the top`} size="sm" value={p.y} decimals={1} min={0} readOnly={readOnly} invalid={!!ey} title={ey} onChange={(v) => v !== null && onChange(f.key, 'y', v)} />
              </td>
              <td>
                {f.key === 'date' ? (
                  <NumberInput aria-label="Date boxes: mm apart" size="sm" value={spec.date.pitch} decimals={1} min={3} max={8} step={0.1} readOnly={readOnly} invalid={!!ew} title={ew ?? 'Distance between the eight date boxes'} onChange={(v) => v !== null && onPitch(v)} />
                ) : f.width ? (
                  <NumberInput aria-label={`${f.label}: width in mm`} size="sm" value={p.w ?? null} decimals={1} min={1} readOnly={readOnly} invalid={!!ew} title={ew} onChange={(v) => v !== null && onChange(f.key, 'w', v)} />
                ) : null}
              </td>
              {ex || ey || ew ? (
                <td className="cq-pos-err" role="alert">
                  {ex ?? ey ?? ew}
                </td>
              ) : null}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
