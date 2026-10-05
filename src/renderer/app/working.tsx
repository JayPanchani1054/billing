/**
 * Working date (F2) and period (Alt+F2) for the open company, with their dialogs.
 *
 *   const { date } = useWorkingDate();          // default date for new vouchers ('YYYY-MM-DD')
 *   const { period, from, to } = usePeriod();   // reporting range
 *   usePeriod().openDialog();                   // what Alt+F2 does
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { formatDate, todayLocal } from '../../shared/dates.ts';
import { Button, DateInput, Field, Kbd, Modal, useEnterAdvance, useHotkeys } from '../ui/index.ts';
import { clampPeriod, clampWorkingDate, describePeriod, loadWorkingContext, periodPresets, savePeriod, saveWorkingDate } from './lib/workingContext.ts';
import type { Period, StorageLike } from './lib/workingContext.ts';

export type { Period };

export interface WorkingDateApi {
  date: string;
  setDate: (date: string) => void;
  openDialog: () => void;
  /** Working date equals today's date. */
  isToday: boolean;
}

export interface PeriodApi {
  period: Period;
  from: string;
  to: string;
  setPeriod: (period: Period) => void;
  openDialog: () => void;
  /** 'FY 2026-27', 'Oct 2026' or '1-Apr-26 to 5-Oct-26'. */
  label: string;
}

interface WorkingContextValue {
  date: WorkingDateApi;
  period: PeriodApi;
  booksFrom: string;
  fyStartMonth: number;
}

const WorkingContext = createContext<WorkingContextValue | null>(null);

function storage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function WorkingContextProvider({
  companyId,
  booksFrom,
  fyStartMonth,
  children,
}: {
  companyId: string;
  booksFrom: string;
  fyStartMonth: number;
  children?: ReactNode;
}) {
  const [state, setState] = useState(() => loadWorkingContext(storage(), { companyId, booksFrom, fyStartMonth }, todayLocal()));
  const [dialog, setDialog] = useState<'date' | 'period' | null>(null);

  const setDate = useCallback(
    (d: string) => {
      const date = clampWorkingDate(d, booksFrom);
      saveWorkingDate(storage(), companyId, date, todayLocal());
      setState((s) => (s.date === date ? s : { ...s, date }));
    },
    [booksFrom, companyId],
  );

  const setPeriod = useCallback(
    (p: Period) => {
      const period = clampPeriod(p, booksFrom);
      savePeriod(storage(), companyId, period);
      setState((s) => (s.period.from === period.from && s.period.to === period.to ? s : { ...s, period }));
    },
    [booksFrom, companyId],
  );

  const openDate = useCallback(() => setDialog('date'), []);
  const openPeriod = useCallback(() => setDialog('period'), []);

  const value = useMemo<WorkingContextValue>(
    () => ({
      date: { date: state.date, setDate, openDialog: openDate, isToday: state.date === todayLocal() },
      period: {
        period: state.period,
        from: state.period.from,
        to: state.period.to,
        setPeriod,
        openDialog: openPeriod,
        label: describePeriod(state.period, fyStartMonth),
      },
      booksFrom,
      fyStartMonth,
    }),
    [state, setDate, setPeriod, openDate, openPeriod, booksFrom, fyStartMonth],
  );

  return (
    <WorkingContext.Provider value={value}>
      {children}
      {dialog === 'date' ? (
        <WorkingDateDialog
          value={state.date}
          booksFrom={booksFrom}
          onClose={() => setDialog(null)}
          onApply={(d) => {
            setDate(d);
            setDialog(null);
          }}
        />
      ) : null}
      {dialog === 'period' ? (
        <PeriodDialog
          value={state.period}
          reference={state.date}
          booksFrom={booksFrom}
          fyStartMonth={fyStartMonth}
          onClose={() => setDialog(null)}
          onApply={(p) => {
            setPeriod(p);
            setDialog(null);
          }}
        />
      ) : null}
    </WorkingContext.Provider>
  );
}

function useWorking(): WorkingContextValue {
  const ctx = useContext(WorkingContext);
  if (!ctx) throw new Error('useWorkingDate/usePeriod must be used inside the workspace');
  return ctx;
}

export function useWorkingDate(): WorkingDateApi {
  return useWorking().date;
}

export function usePeriod(): PeriodApi {
  return useWorking().period;
}

/** Books beginning date and FY start month of the open company. */
export function useBooks(): { booksFrom: string; fyStartMonth: number } {
  const w = useWorking();
  return { booksFrom: w.booksFrom, fyStartMonth: w.fyStartMonth };
}

function WorkingDateDialog({ value, booksFrom, onApply, onClose }: { value: string; booksFrom: string; onApply: (d: string) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<string | null>(value);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const today = todayLocal();
  const apply = () => {
    if (!draft) {
      setErr('Enter a date, for example 5-10 or 05-10-2026.');
      return;
    }
    if (draft < booksFrom) {
      setErr(`The books begin on ${formatDate(booksFrom)}. Choose that date or later.`);
      return;
    }
    onApply(draft);
  };
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: apply });
  return (
    <Modal
      open
      onClose={onClose}
      title="Change Working Date"
      description="New vouchers use this date. Reports are not affected."
      size="sm"
      initialFocusRef={inputRef}
      footerStart={
        <Button variant="ghost" size="sm" onClick={() => onApply(clampWorkingDate(today, booksFrom))}>
          Use today ({formatDate(today, 'D-MMM-YY')})
        </Button>
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" onClick={apply}>
            Set date
          </Button>
        </>
      }
    >
      <AcceptKey onAccept={apply} />
      <div ref={formRef}>
        <Field label="Date" error={err ?? undefined} hint="Type 5 for the 5th of this month, 5-10 for 5 October, or t for today.">
          <DateInput
            ref={inputRef}
            value={draft}
            onChange={(d) => {
              setDraft(d);
              setErr(null);
            }}
            referenceDate={value}
            minDate={booksFrom}
            showWeekday
          />
        </Field>
      </div>
    </Modal>
  );
}

function PeriodDialog({
  value,
  reference,
  booksFrom,
  fyStartMonth,
  onApply,
  onClose,
}: {
  value: Period;
  reference: string;
  booksFrom: string;
  fyStartMonth: number;
  onApply: (p: Period) => void;
  onClose: () => void;
}) {
  const [from, setFrom] = useState<string | null>(value.from);
  const [to, setTo] = useState<string | null>(value.to);
  const [err, setErr] = useState<string | null>(null);
  const fromRef = useRef<HTMLInputElement | null>(null);
  const presets = useMemo(() => periodPresets(reference, booksFrom, fyStartMonth), [reference, booksFrom, fyStartMonth]);
  const apply = () => {
    if (!from || !to) {
      setErr('Enter both dates.');
      return;
    }
    if (to < from) {
      setErr('The “to” date is before the “from” date.');
      return;
    }
    onApply({ from, to });
  };
  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: apply });
  return (
    <Modal
      open
      onClose={onClose}
      title="Change Period"
      description="Reports show entries between these dates."
      size="md"
      initialFocusRef={fromRef}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" shortcut="Ctrl+A" onClick={apply}>
            Apply period
          </Button>
        </>
      }
    >
      <AcceptKey onAccept={apply} />
      <div className="bx-period-dialog">
        <div ref={formRef} className="bx-period-dialog__fields">
          <Field label="From" required>
            <DateInput
              ref={fromRef}
              value={from}
              onChange={(d) => {
                setFrom(d);
                setErr(null);
              }}
              referenceDate={reference}
              minDate={booksFrom}
            />
          </Field>
          <Field label="To" required error={err ?? undefined}>
            <DateInput
              value={to}
              onChange={(d) => {
                setTo(d);
                setErr(null);
              }}
              referenceDate={reference}
              minDate={from ?? booksFrom}
            />
          </Field>
        </div>
        <div className="bx-period-dialog__presets" role="group" aria-label="Quick periods">
          {presets.map((p) => (
            <Button key={p.id} size="sm" variant="ghost" onClick={() => onApply(p.period)} title={describePeriod(p.period, fyStartMonth)}>
              {p.label}
            </Button>
          ))}
        </div>
        <p className="bx-period-dialog__note bx-muted">
          Books begin on {formatDate(booksFrom)}. <Kbd keys="Alt+F2" size="sm" tone="subtle" /> opens this from anywhere.
        </p>
      </div>
    </Modal>
  );
}

/** Ctrl+A accepts inside the dialog (the dialog's blocking hotkey scope). */
function AcceptKey({ onAccept }: { onAccept: () => void }) {
  useHotkeys({ 'Ctrl+A': () => onAccept() });
  return null;
}
