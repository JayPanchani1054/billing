/**
 * 'company.periodLock' (dialog) — lock the books up to a date, or unlock them.
 */
import { useRef, useState } from 'react';
import { formatDate, todayLocal } from '../../../shared/dates.ts';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { userMessage } from '../../app/lib/apiErrors.ts';
import { DialogScreen, useNav } from '../../app/nav.tsx';
import { useBooks } from '../../app/working.tsx';
import { Banner, Button, DateInput, Field, Skeleton, Stack, useEnterAdvance, useHotkeys, useToast } from '../../ui/index.ts';

export function PeriodLockScreen() {
  const q = useApiQuery('company.config.get', {});
  const nav = useNav();
  if (!q.data) {
    return (
      <DialogScreen title="Lock Books" size="sm" footer={<Button onClick={() => void nav.back()}>Close</Button>}>
        {q.error ? <Banner tone="danger">{userMessage(q.error)}</Banner> : <Skeleton lines={3} />}
      </DialogScreen>
    );
  }
  return <LockForm lockedUpTo={q.data.lockedUpTo} />;
}

function LockForm({ lockedUpTo }: { lockedUpTo: string | null }) {
  const nav = useNav();
  const toast = useToast();
  const books = useBooks();
  const today = todayLocal();
  const [date, setDate] = useState<string | null>(lockedUpTo ?? null);
  const [error, setError] = useState<string | null>(null);
  const setLock = useApiMutation('company.periodLock.set');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const apply = async (value: string | null) => {
    if (setLock.pending) return;
    if (value !== null && value > today) {
      setError(`You can lock only up to today (${formatDate(today)}).`);
      return;
    }
    setError(null);
    try {
      const r = await setLock.mutate({ date: value });
      toast.success(r.lockedUpTo ? `Books locked up to ${formatDate(r.lockedUpTo)}` : 'Books unlocked', {
        message: r.lockedUpTo ? 'Entries on or before this date can no longer be added, changed or deleted.' : undefined,
      });
      nav.pop(r);
    } catch (err) {
      setError(userMessage(err));
    }
  };

  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => void apply(date) });

  return (
    <DialogScreen
      title="Lock Books"
      description="Stop changes to entries on or before a date — for example after filing GST returns or finalising accounts."
      size="sm"
      footerStart={
        lockedUpTo ? (
          <Button variant="ghost" icon="unlock" onClick={() => void apply(null)} disabled={setLock.pending}>
            Unlock all
          </Button>
        ) : undefined
      }
      footer={
        <>
          <Button onClick={() => void nav.back()}>Cancel</Button>
          <Button variant="primary" icon="lock" loading={setLock.pending} disabled={!date} onClick={() => void apply(date)} shortcut="Ctrl+A">
            Lock books
          </Button>
        </>
      }
    >
      <AcceptKey onAccept={() => void apply(date)} />
      <div ref={formRef}>
        <Stack gap={3}>
          <p className="bx-muted">{lockedUpTo ? `Currently locked up to ${formatDate(lockedUpTo)}.` : 'The books are not locked.'}</p>
          <Field label="Lock entries up to" required hint={`Between ${formatDate(books.booksFrom)} and today.`}>
            <DateInput ref={inputRef} value={date} onChange={setDate} referenceDate={today} minDate={books.booksFrom} maxDate={today} showWeekday />
          </Field>
          {error ? (
            <Banner tone="danger" inline>
              {error}
            </Banner>
          ) : null}
        </Stack>
      </div>
    </DialogScreen>
  );
}

function AcceptKey({ onAccept }: { onAccept: () => void }) {
  useHotkeys({ 'Ctrl+A': () => onAccept() });
  return null;
}
