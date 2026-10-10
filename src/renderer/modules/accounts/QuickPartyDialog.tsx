/**
 * Quick customer / supplier — Alt+C in a party picker (voucher entry's party field, or any LedgerPicker
 * for customers / suppliers). A small dialog instead of the full ledger form:
 *
 *   Create customer
 *     Name*            [Ravi Traders            ]
 *     GSTIN            [24AAACR1234A1Z5] ✓ Valid GSTIN · Gujarat · PAN AAACR1234A
 *     State            [24 - Gujarat ▾]   (only without a GSTIN: a valid GSTIN fills state and PAN)
 *     Mobile  [ ]   E-mail [ ]
 *     Billing address  [                          ]
 *     [Full form…]                                  [Cancel Esc] [Create Ctrl+A]
 *
 * Saves with 'accounts.ledger.save' under Sundry Debtors / Sundry Creditors (bill-wise when F11 › Bill-wise
 * is on) and hands back `{ id, name }` exactly like the ledger form opened for a result. "Full form…"
 * opens today's Ledger Creation instead, with the name typed so far. Pure part: vouchers/lib/quickParty.ts.
 */
import { useMemo, useState } from 'react';
import type { GroupRow } from '../../../shared/types/accounts.ts';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { fieldErrorsOf, userMessage } from '../../app/lib/apiErrors.ts';
import { useCompany } from '../../app/state.tsx';
import { Banner, Button, Field, FieldGroup, Hotkeys, Modal, Stack, TextArea, TextInput, useEnterAdvance, useToast } from '../../ui/index.ts';
import { emptyQuickParty, quickPartyInput, quickPartyNoun, quickPartyProblems, withGstin } from '../vouchers/lib/quickParty.ts';
import type { QuickPartyDraft, QuickPartyGroup } from '../vouchers/lib/quickParty.ts';
import { OkHint, StatePicker } from './components.tsx';
import { LEDGER_DEPENDENTS } from './hooks.ts';
import { initialGroupId } from './lib/groupClass.ts';
import { gstinOkText } from './lib/gstin.ts';

export interface QuickPartyDialogProps {
  group: QuickPartyGroup;
  /** The text typed in the picker (the new party's name). */
  initialName: string;
  /** The ledger was created: select it (same shape as the ledger form's result). */
  onCreated: (out: { id: number; name: string }) => void;
  /** Open the full Ledger Creation form instead (with the name typed so far). */
  onFullForm: (name: string) => void;
  onClose: () => void;
}

const EMPTY_GROUPS: readonly GroupRow[] = [];

export function QuickPartyDialog({ group, initialName, onCreated, onFullForm, onClose }: QuickPartyDialogProps) {
  const company = useCompany();
  const toast = useToast();
  const noun = quickPartyNoun(group);
  const [d, setD] = useState<QuickPartyDraft>(() => emptyQuickParty(initialName, company.stateCode));
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const groupsQ = useApiQuery('accounts.group.list', {}, { keepPrevious: true });
  const groups = groupsQ.data?.rows ?? EMPTY_GROUPS;
  const groupId = useMemo(() => initialGroupId(groups, { groupCode: group }), [groups, group]);
  const save = useApiMutation('accounts.ledger.save', { invalidates: [...LEDGER_DEPENDENTS] });

  const problems = quickPartyProblems(d, tried);
  const err = (k: keyof QuickPartyDraft): string | undefined => problems[k] ?? serverErrors[k];
  const set = (patch: Partial<QuickPartyDraft>) => {
    setD((x) => ({ ...x, ...patch }));
    setServerErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(patch)) delete next[k];
      return next;
    });
  };

  const submit = async () => {
    setTried(true);
    if (save.pending || groupId === null) return;
    if (Object.keys(quickPartyProblems(d, true)).length > 0) return;
    setFailure(null);
    try {
      const out = await save.mutate(quickPartyInput(d, { groupId, billWise: company.features.billWise }));
      toast.success(`Ledger “${out.name}” created`);
      onCreated({ id: out.id, name: out.name });
    } catch (e) {
      const fe = fieldErrorsOf(e);
      setServerErrors(fe);
      if (Object.keys(fe).length === 0) setFailure(userMessage(e));
    }
  };
  const formRef = useEnterAdvance<HTMLElement>({ onComplete: () => void submit() });
  const gstinOk = gstinOkText(d.gstin);

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={`Create ${noun}`}
      description={`A ${noun} ledger under ${group === 'SUNDRY_DEBTORS' ? 'Sundry Debtors' : 'Sundry Creditors'}. Credit period, bank details and opening balance can be added later in the ledger.`}
      footerStart={
        <Button variant="link" onClick={() => onFullForm(d.name)}>
          Full form…
        </Button>
      }
      footer={
        <>
          <Button onClick={onClose} shortcut="Esc">
            Cancel
          </Button>
          <Button variant="primary" shortcut="Ctrl+A" loading={save.pending} disabled={groupId === null} onClick={() => void submit()}>
            Create
          </Button>
        </>
      }
    >
      <Hotkeys map={{ 'Ctrl+A': () => void submit() }} />
      <Stack ref={formRef} gap={3}>
        {failure ? (
          <Banner tone="danger" title={`The ${noun} was not created`}>
            {failure}
          </Banner>
        ) : null}
        {groupsQ.error ? (
          <Banner tone="danger" title="Could not load the ledger groups">
            {userMessage(groupsQ.error)}
          </Banner>
        ) : null}
        <Field label="Name" required error={err('name')}>
          <TextInput value={d.name} maxLength={200} onValueChange={(name) => set({ name })} data-autofocus />
        </Field>
        <Field label="GSTIN" optional error={err('gstin')} hint={gstinOk ? <OkHint>{gstinOk}</OkHint> : 'Typing a valid GSTIN fills the state and PAN.'}>
          <TextInput value={d.gstin} onValueChange={(raw) => set(withGstin(d, raw))} uppercase mono maxLength={15} spellCheck={false} autoComplete="off" />
        </Field>
        {gstinOk ? null : (
          <Field label="State" optional error={err('stateCode')} hint="Decides CGST + SGST or IGST on invoices.">
            <StatePicker value={d.stateCode} onChange={(stateCode) => set({ stateCode })} />
          </Field>
        )}
        <FieldGroup columns={2}>
          <Field label="Mobile" optional error={err('mobile')}>
            <TextInput value={d.mobile} maxLength={20} inputMode="tel" onValueChange={(mobile) => set({ mobile })} />
          </Field>
          <Field label="E-mail" optional error={err('email')}>
            <TextInput value={d.email} maxLength={254} inputMode="email" spellCheck={false} onValueChange={(email) => set({ email })} />
          </Field>
        </FieldGroup>
        <Field label="Billing address" optional error={err('address')}>
          <TextArea value={d.address} maxLength={1000} autoGrow maxRows={4} onValueChange={(address) => set({ address })} />
        </Field>
      </Stack>
    </Modal>
  );
}
