/**
 * Scenario picker (Alt+S) and budget column (Alt+B) of the Trial Balance, Profit & Loss and Balance
 * Sheet (Scenario Management / "New Column" with a budget). Scenarios and budgets are masters of
 * the documents module; this hook only reads them ('documents.scenario.list', 'documents.budget.list',
 * 'documents.budget.columns') and gives the screen the scenarioId for its report query and the budget
 * per row key for its Budget column. Choices stay for the life of the screen.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import { useApiQuery, useCan } from '../../app/index.ts';
import type { ScreenActionItem } from '../../app/index.ts';
import { Button, Field, Modal, Select, useEnterAdvance, useHotkeys } from '../../ui/index.ts';
import { overlayText } from './lib/overlay.ts';
import type { BudgetBasisByKey, BudgetByKey } from './lib/overlay.ts';

export interface ReportOverlay {
  /** For the report query (undefined = the books). */
  scenarioId: number | undefined;
  scenarioName: string | null;
  /** Budget per row key (Dr + / Cr −) and its basis per key, null when no budget column is shown. */
  budget: { name: string; byKey: BudgetByKey; basisByKey?: BudgetBasisByKey } | null;
  /** Rail actions: Alt+S Scenario, Alt+B Budget column. */
  actions: ScreenActionItem[];
  /** "Scenario: … · Budget: …" for the subtitle (null when neither is chosen). */
  text: string | null;
  /** The chooser dialogs (render once inside the screen). */
  dialogs: ReactNode;
}

export function useReportOverlay(period: { from: string; to: string }): ReportOverlay {
  const canMasters = useCan('reports.view');
  const [picking, setPicking] = useState<'scenario' | 'budget' | null>(null);
  const [scenarioId, setScenarioId] = useState<number | null>(null);
  const [budgetId, setBudgetId] = useState<number | null>(null);
  const scenarios = useApiQuery('documents.scenario.list', {}, { enabled: canMasters && (picking === 'scenario' || scenarioId !== null), staleTime: 60_000 });
  const budgets = useApiQuery('documents.budget.list', {}, { enabled: canMasters && (picking === 'budget' || budgetId !== null), staleTime: 60_000 });
  const columns = useApiQuery('documents.budget.columns', { budgetId: budgetId ?? 0, from: period.from, to: period.to }, { enabled: budgetId !== null, keepPrevious: true });
  const scenario = (scenarios.data ?? []).find((s) => s.id === scenarioId) ?? null;
  const budget = budgetId !== null && columns.data ? { name: columns.data.name, byKey: columns.data.byKey, basisByKey: columns.data.basisByKey ?? {}, proRata: columns.data.proRata } : null;

  const actions: ScreenActionItem[] = [
    {
      key: 'Alt+S',
      label: scenario ? `Scenario: ${scenario.name}` : 'Scenario',
      icon: 'layers',
      onClick: () => setPicking('scenario'),
      hidden: !canMasters,
      hint: 'Include memorandum, reversing journal or optional vouchers (Masters › Scenarios)',
      group: 'overlay',
    },
    {
      key: 'Alt+B',
      label: budget ? `Budget: ${budget.name}` : 'Budget column',
      icon: 'chart',
      onClick: () => setPicking('budget'),
      hidden: !canMasters,
      hint: 'Show a budget next to the amounts (Masters › Budgets)',
      group: 'overlay',
    },
  ];

  const dialogs =
    picking === 'scenario' ? (
      <ChooserDialog
        title="Scenario"
        hint="A scenario changes which vouchers this report counts; the books are not changed."
        loading={scenarios.loading}
        options={[{ value: '', label: 'None — the books' }, ...(scenarios.data ?? []).map((s) => ({ value: String(s.id), label: s.name }))]}
        value={scenarioId !== null ? String(scenarioId) : ''}
        onClose={() => setPicking(null)}
        onChoose={(v) => {
          setScenarioId(v ? Number(v) : null);
          setPicking(null);
        }}
      />
    ) : picking === 'budget' ? (
      <ChooserDialog
        title="Budget column"
        hint="Nett-transaction budgets are pro-rated by days to the report period; closing-balance budgets are shown as they are."
        loading={budgets.loading}
        options={[{ value: '', label: 'None' }, ...(budgets.data ?? []).map((b) => ({ value: String(b.id), label: `${b.name} (${formatDate(b.from)} – ${formatDate(b.to)})` }))]}
        value={budgetId !== null ? String(budgetId) : ''}
        onClose={() => setPicking(null)}
        onChoose={(v) => {
          setBudgetId(v ? Number(v) : null);
          setPicking(null);
        }}
      />
    ) : null;

  return {
    scenarioId: scenarioId ?? undefined,
    scenarioName: scenario?.name ?? null,
    budget: budget ? { name: budget.name, byKey: budget.byKey, basisByKey: budget.basisByKey } : null,
    actions,
    text: overlayText(scenario?.name ?? null, budget),
    dialogs,
  };
}

function ChooserKeys({ onAccept }: { onAccept: () => void }) {
  useHotkeys({ 'Ctrl+A': () => onAccept() });
  return null;
}

function ChooserDialog({
  title,
  hint,
  loading,
  options,
  value,
  onClose,
  onChoose,
}: {
  title: string;
  hint: string;
  loading: boolean;
  options: ReadonlyArray<{ value: string; label: string }>;
  value: string;
  onClose: () => void;
  onChoose: (v: string) => void;
}) {
  const [v, setV] = useState(value);
  const ref = useEnterAdvance<HTMLDivElement>({ onComplete: () => onChoose(v) });
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" onClick={() => onChoose(v)}>
            Choose
          </Button>
        </>
      }
    >
      <ChooserKeys onAccept={() => onChoose(v)} />
      <div ref={ref}>
        <Field label={title} hint={options.length <= 1 && !loading ? `None yet — create one under Gateway › Masters › ${title === 'Scenario' ? 'Scenarios' : 'Budgets'}.` : hint}>
          <Select options={options} value={v} onChange={setV} disabled={loading} data-autofocus />
        </Field>
      </div>
    </Modal>
  );
}
