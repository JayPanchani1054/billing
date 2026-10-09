/**
 * 'accounts.ledger.bulk' — Multiple Ledger Creation: a grid of name / under / opening balance /
 * GSTIN / state. Enter moves across the cells, a new blank row appears as you type, Ctrl+A creates
 * them all at once (all-or-nothing). Problems are shown against the row they belong to — both the
 * live checks (duplicates, GSTIN checksum) and the server's answer.
 */
import { useMemo, useRef, useState } from 'react';
import { formatMoney } from '../../../shared/format.ts';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { fieldErrorsOf, userMessage } from '../../app/lib/apiErrors.ts';
import { useNav } from '../../app/nav.tsx';
import { ReadOnlyNotice, Screen } from '../../app/Screen.tsx';
import { useCan } from '../../app/state.tsx';
import { AmountInput, Banner, Button, Field, IconButton, Stack, TextInput, useEnterAdvance, useToast } from '../../ui/index.ts';
import { StatePicker } from './components.tsx';
import { LEDGER_DEPENDENTS } from './hooks.ts';
import { applyRowGstin, bulkInput, bulkTotals, cellDescribedBy, cellErrorId, isBlankRow, mapBulkServerErrors, newBulkRow, validateBulkRows } from './lib/bulkRows.ts';
import { classOfGroup, indexGroups } from './lib/groupClass.ts';
import { defaultOpeningSide } from './lib/ledgerSections.ts';
import type { BulkErrors, BulkRow } from './lib/bulkRows.ts';
import { GroupPicker, useGroups, useLedgerPicker } from './pickers.tsx';

const START_ROWS = 8;

export function BulkLedgerScreen() {
  const nav = useNav();
  const toast = useToast();
  const canCreate = useCan('masters.create');
  const groups = useGroups();
  const ledgers = useLedgerPicker({ includeInactive: true });
  const create = useApiMutation('accounts.ledger.bulkCreate', { invalidates: [...LEDGER_DEPENDENTS] });
  const [defaultGroup, setDefaultGroup] = useState<number | null>(null);
  const [rows, setRows] = useState<BulkRow[]>(() => Array.from({ length: START_ROWS }, () => newBulkRow(null)));
  const [serverErrors, setServerErrors] = useState<BulkErrors>({});
  const [submitted, setSubmitted] = useState(false);
  const rowKeysRef = useRef<string[]>([]);

  const existing = useMemo(() => {
    const s = new Set<string>();
    for (const l of ledgers.rows) {
      s.add(l.name.toLowerCase());
      if (l.alias) s.add(l.alias.toLowerCase());
    }
    for (const g of groups.rows) {
      s.add(g.name.toLowerCase());
      if (g.alias) s.add(g.alias.toLowerCase());
    }
    return s;
  }, [ledgers.rows, groups.rows]);
  const index = useMemo(() => indexGroups(groups.rows), [groups.rows]);

  const clientErrors = validateBulkRows(rows, existing);
  // Before the first save only "live" problems (duplicates, GSTIN) show; afterwards all of them.
  const live = submitted
    ? clientErrors
    : Object.fromEntries(Object.entries(clientErrors).filter(([k, msg]) => !k.endsWith('.groupId') && msg !== 'Enter the ledger name'));
  const errors: BulkErrors = { ...live, ...serverErrors };
  const totals = bulkTotals(rows);
  const dirty = totals.count > 0;

  const update = (i: number, next: BulkRow) => {
    setRows((rs) => {
      const out = rs.map((r, k) => (k === i ? next : r));
      if (i === out.length - 1 && !isBlankRow(next)) out.push(newBulkRow(defaultGroup));
      return out;
    });
    setServerErrors((e) => {
      const keys = Object.keys(e).filter((k) => k.startsWith(`${next.key}.`));
      if (keys.length === 0) return e;
      const copy = { ...e };
      for (const k of keys) delete copy[k];
      return copy;
    });
  };
  const removeRow = (i: number) => setRows((rs) => (rs.length <= 1 ? [newBulkRow(defaultGroup)] : rs.filter((_, k) => k !== i)));

  const onDefaultGroup = (id: number | null) => {
    setDefaultGroup(id);
    // Fill rows that have no group yet.
    setRows((rs) => rs.map((r) => (r.groupId === null ? { ...r, groupId: id } : r)));
  };

  const submit = async () => {
    if (!canCreate || create.pending) return;
    setSubmitted(true);
    const problems = validateBulkRows(rows, existing);
    if (totals.count === 0) {
      toast.info('Nothing to create', { message: 'Type at least one ledger name.' });
      return;
    }
    if (Object.keys(problems).length > 0) {
      toast.error('Please correct the highlighted rows', { message: Object.values(problems)[0] });
      return;
    }
    const { rows: input, rowKeys } = bulkInput(rows);
    rowKeysRef.current = rowKeys;
    try {
      const out = await create.mutate({ rows: input });
      toast.success(`${out.created} ledger${out.created === 1 ? '' : 's'} created`);
      setRows(Array.from({ length: START_ROWS }, () => newBulkRow(defaultGroup)));
      setServerErrors({});
      setSubmitted(false);
    } catch (err) {
      const mapped = mapBulkServerErrors(fieldErrorsOf(err), rowKeysRef.current);
      setServerErrors(mapped);
      toast.error('No ledgers were created', { message: Object.keys(mapped).length > 0 ? 'Correct the highlighted rows and try again — nothing is saved until every row is right.' : userMessage(err) });
    }
  };

  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => void submit() });
  const e = (r: BulkRow, f: string): string | undefined => errors[`${r.key}.${f}`];

  return (
    <Screen
      title="Multiple Ledger Creation"
      subtitle="Type one ledger per row. All rows are created together when you press Ctrl+A."
      icon="list"
      dirty={dirty}
      hint="Enter Next cell · Ctrl+A Create all · Esc Back"
      actions={[
        { key: 'Ctrl+A', label: totals.count > 0 ? `Create ${totals.count} ledger${totals.count === 1 ? '' : 's'}` : 'Create ledgers', icon: 'save', primary: true, onClick: () => void submit(), disabled: !canCreate || totals.count === 0 },
        { key: 'Alt+N', label: 'Add row', icon: 'plus', onClick: () => setRows((rs) => [...rs, newBulkRow(defaultGroup)]), disabled: !canCreate },
      ]}
      footer={
        canCreate ? (
          <>
            <span className="bx-muted">
              {totals.count} ledger{totals.count === 1 ? '' : 's'} · openings Dr ₹ {formatMoney(totals.debit)} · Cr ₹ {formatMoney(totals.credit)}
            </span>
            <Button onClick={() => void nav.back()}>Cancel</Button>
            <Button variant="primary" icon="save" loading={create.pending} disabled={totals.count === 0} onClick={() => void submit()} shortcut="Ctrl+A">
              Create all
            </Button>
          </>
        ) : undefined
      }
    >
      <div ref={formRef}>
        <Stack gap={4}>
          {!canCreate ? <ReadOnlyNotice what="ledgers" /> : null}
          <Field label="Default group for new rows" hint="Rows without a group take this one. You can change it per row." layout="inline">
            <GroupPicker value={defaultGroup} onChange={(id) => onDefaultGroup(id)} allowCreate={canCreate} />
          </Field>
          {errors._ ? <Banner tone="danger">{errors._}</Banner> : null}
          <div className="bx-acc-grid-wrap" style={{ maxHeight: 'none' }}>
            <table className="bx-acc-grid" aria-label="New ledgers">
              <thead>
                <tr>
                  <th className="bx-acc-grid__index" scope="col">
                    #
                  </th>
                  <th scope="col">Name</th>
                  <th scope="col">Under</th>
                  <th scope="col" className="is-num">
                    Opening balance
                  </th>
                  <th scope="col">GSTIN</th>
                  <th scope="col">State</th>
                  <th scope="col" className="bx-acc-grid__actions">
                    <span className="bx-sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.key}>
                    <td className="bx-acc-grid__index">{i + 1}</td>
                    <td style={{ minWidth: 220 }}>
                      <TextInput size="sm" value={r.name} onChange={(ev) => update(i, { ...r, name: ev.target.value })} aria-label={`Row ${i + 1} name`} aria-describedby={cellDescribedBy(errors, r.key, 'name')} invalid={!!e(r, 'name')} maxLength={200} readOnly={!canCreate} />
                      {e(r, 'name') ? <span id={cellErrorId(r.key, 'name')} className="bx-acc-grid__error">{e(r, 'name')}</span> : null}
                    </td>
                    <td style={{ minWidth: 220 }}>
                      <GroupPicker size="sm" value={r.groupId} onChange={(id) => update(i, { ...r, groupId: id })} aria-label={`Row ${i + 1} group`} aria-describedby={cellDescribedBy(errors, r.key, 'groupId')} invalid={!!e(r, 'groupId')} allowCreate={false} readOnly={!canCreate} />
                      {e(r, 'groupId') ? <span id={cellErrorId(r.key, 'groupId')} className="bx-acc-grid__error">{e(r, 'groupId')}</span> : null}
                    </td>
                    <td style={{ width: 180 }}>
                      {/* Starts on the usual side of the row's group (Cr for suppliers, capital, income); keyed so it follows a group change. */}
                      <AmountInput key={defaultOpeningSide(classOfGroup(index, r.groupId))} size="sm" drcr defaultSide={defaultOpeningSide(classOfGroup(index, r.groupId))} value={r.openingBalance} onChange={(v) => update(i, { ...r, openingBalance: v })} aria-label={`Row ${i + 1} opening balance`} aria-describedby={cellDescribedBy(errors, r.key, 'openingBalance')} invalid={!!e(r, 'openingBalance')} readOnly={!canCreate} />
                      {e(r, 'openingBalance') ? <span id={cellErrorId(r.key, 'openingBalance')} className="bx-acc-grid__error">{e(r, 'openingBalance')}</span> : null}
                    </td>
                    <td style={{ width: 190 }}>
                      <TextInput size="sm" value={r.gstin} onChange={(ev) => update(i, applyRowGstin(r, ev.target.value))} aria-label={`Row ${i + 1} GSTIN`} aria-describedby={cellDescribedBy(errors, r.key, 'gstin')} invalid={!!e(r, 'gstin')} uppercase mono maxLength={15} spellCheck={false} readOnly={!canCreate} />
                      {e(r, 'gstin') ? <span id={cellErrorId(r.key, 'gstin')} className="bx-acc-grid__error">{e(r, 'gstin')}</span> : null}
                    </td>
                    <td style={{ minWidth: 200 }}>
                      <StatePicker
                        size="sm"
                        value={r.stateCode}
                        onChange={(c) => update(i, { ...r, stateCode: c })}
                        aria-label={`Row ${i + 1} state`}
                        aria-describedby={cellDescribedBy(errors, r.key, 'stateCode')}
                        invalid={!!e(r, 'stateCode')}
                        readOnly={!canCreate}
                        placeholder="State"
                      />
                      {e(r, 'stateCode') ? <span id={cellErrorId(r.key, 'stateCode')} className="bx-acc-grid__error">{e(r, 'stateCode')}</span> : null}
                    </td>
                    <td className="bx-acc-grid__actions">
                      {canCreate && !isBlankRow(r) ? <IconButton icon="trash" size="sm" aria-label={`Remove row ${i + 1}`} tabIndex={-1} onClick={() => removeRow(i)} /> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <span className="bx-muted">
            Parties get bill-wise details and the rest of their settings from the group; open a ledger later (Ledgers → Enter) to add address, bank or GST details.
          </span>
        </Stack>
      </div>
    </Screen>
  );
}
