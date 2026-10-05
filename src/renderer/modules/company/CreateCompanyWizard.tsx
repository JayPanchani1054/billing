/**
 * Create a company in six short steps: Business → GST & tax → Books → Features → Security → Review.
 * Enter moves through fields and to the next step; Ctrl+A creates (jumping to any step that still
 * needs attention); Esc cancels (asking first when something was typed).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { financialYear, formatDate, todayLocal } from '../../../shared/dates.ts';
import { validateGstin } from '../../../shared/gst/gstin.ts';
import { stateLabel } from '../../../shared/gst/states.ts';
import type { GstRegistrationType } from '../../../shared/types/company.ts';
import { api } from '../../app/api.ts';
import { setNativeDirty } from '../../app/bridge.ts';
import { useConfirm } from '../../app/confirm.tsx';
import { fieldErrorsOf, userMessage } from '../../app/lib/apiErrors.ts';
import { featureInfo } from '../../app/lib/featureCatalog.ts';
import { useAppState } from '../../app/state.tsx';
import {
  Banner,
  Button,
  DateInput,
  Field,
  FieldGroup,
  Icon,
  KeyValueList,
  Kbd,
  PasswordInput,
  RadioGroup,
  Select,
  Stack,
  Switch,
  TextArea,
  TextInput,
  useEnterAdvance,
  useHotkeys,
} from '../../ui/index.ts';
import { getEnterTargets } from '../../ui/lib/dom.ts';
import { cx } from '../../ui/lib/cx.ts';
import { GstinOk, StatePicker, StrengthMeter } from './fields.tsx';
import { GateLayout } from './GateLayout.tsx';
import {
  applyGstin,
  booksFromForFy,
  buildCreateInput,
  defaultDraft,
  draftFieldOfPath,
  firstInvalidStep,
  MONTH_OPTIONS,
  STEP_LABELS,
  stepOfPath,
  validateStep,
  WIZARD_FEATURES,
  WIZARD_STEPS,
} from './lib/companyForm.ts';
import type { CompanyDraft, DraftErrors, WizardStep } from './lib/companyForm.ts';

const REGISTRATION_OPTIONS: ReadonlyArray<{ value: GstRegistrationType; label: string; description: string }> = [
  { value: 'regular', label: 'Regular', description: 'You charge GST on sales and claim input tax credit on purchases.' },
  { value: 'composition', label: 'Composition', description: 'You pay tax at a fixed rate on turnover and issue bills of supply.' },
  { value: 'unregistered', label: 'Not registered', description: 'You do not charge GST. You can register later in Company Details.' },
];

export function CreateCompanyWizard({ onCancel }: { onCancel: () => void }) {
  const app = useAppState();
  const confirm = useConfirm();
  const today = useMemo(() => todayLocal(), []);
  const [draft, setDraft] = useState<CompanyDraft>(() => defaultDraft(today));
  const [step, setStep] = useState<WizardStep>('business');
  const [furthest, setFurthest] = useState(0);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const createRef = useRef<HTMLButtonElement | null>(null);
  const stepIndex = WIZARD_STEPS.indexOf(step);
  const stepRef = useRef(step);
  stepRef.current = step;

  const update = (patch: Partial<CompanyDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setTouched(true);
    setErrors((e) => {
      const keys = (Object.keys(patch) as Array<keyof CompanyDraft>).filter((k) => k in e);
      if (keys.length === 0) return e;
      const next = { ...e };
      for (const k of keys) delete next[k];
      return next;
    });
  };

  // Focus the first field of a step, or the first invalid field after a failed Next/Create.
  const focusTarget = useRef<'first' | 'error'>('first');
  const [focusRequest, setFocusRequest] = useState(0);
  const requestFocus = (target: 'first' | 'error') => {
    focusTarget.current = target;
    setFocusRequest((n) => n + 1);
  };
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const body = bodyRef.current;
      if (!body) return;
      if (stepRef.current === 'review' && focusTarget.current === 'first') {
        createRef.current?.focus();
        return;
      }
      const invalid = focusTarget.current === 'error' ? body.querySelector<HTMLElement>('[aria-invalid="true"]') : null;
      const target = invalid ?? getEnterTargets(body)[0];
      target?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [focusRequest]);

  const goTo = (s: WizardStep, focus: 'first' | 'error' = 'first') => {
    const i = WIZARD_STEPS.indexOf(s);
    setStep(s);
    setFurthest((f) => Math.max(f, i));
    requestFocus(focus);
  };

  const next = () => {
    if (step === 'review') {
      void create();
      return;
    }
    const e = validateStep(step, draft);
    if (Object.keys(e).length > 0) {
      setErrors(e);
      requestFocus('error');
      return;
    }
    setErrors({});
    goTo(WIZARD_STEPS[stepIndex + 1]);
  };

  const back = () => {
    if (stepIndex > 0) {
      setErrors({});
      setStep(WIZARD_STEPS[stepIndex - 1]);
      requestFocus('first');
    }
  };

  const create = async () => {
    if (busy) return;
    const bad = firstInvalidStep(draft);
    if (bad) {
      setErrors(validateStep(bad, draft));
      goTo(bad, 'error');
      return;
    }
    setBusy(true);
    setServerError(null);
    try {
      const next = await api('app.company.create', buildCreateInput(draft));
      app.applyState(next);
    } catch (err) {
      const fields = fieldErrorsOf(err);
      const paths = Object.keys(fields);
      if (paths.length > 0) {
        const mapped: DraftErrors = {};
        for (const p of paths) mapped[draftFieldOfPath(p)] = fields[p];
        setErrors(mapped);
        goTo(stepOfPath(paths[0]), 'error');
      } else {
        setServerError(userMessage(err));
      }
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (busy) return;
    if (touched) {
      const ok = await confirm({
        title: 'Discard this new company?',
        message: 'The details you entered will be lost.',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        tone: 'danger',
      });
      if (!ok) return;
    }
    onCancel();
  };

  useHotkeys(
    {
      'Ctrl+A': () => void create(),
      Escape: () => void cancel(),
      'Alt+ArrowLeft': () => back(),
      'Alt+ArrowRight': () => next(),
    },
    [draft, step, touched, busy],
  );

  // Closing the window with a half-filled wizard asks first (main's close guard).
  useEffect(() => {
    setNativeDirty(touched);
    return () => setNativeDirty(false);
  }, [touched]);

  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: next });
  const fy = financialYear(draft.booksFrom || today, draft.fyStartMonth);
  const registered = draft.gstRegistrationType !== 'unregistered';

  return (
    <GateLayout
      title="Create Company"
      subtitle="A few details about your business. You can change all of this later."
      width="wide"
      footer={
        <span className="bx-gate__keys">
          <Kbd keys="Enter" size="sm" tone="subtle" /> Next field <Kbd keys="Alt+ArrowRight" size="sm" tone="subtle" /> Next step <Kbd keys="Ctrl+A" size="sm" tone="subtle" /> Create{' '}
          <Kbd keys="Escape" size="sm" tone="subtle" /> Cancel
        </span>
      }
    >
      <ol className="bx-stepper" aria-label="Steps">
        {WIZARD_STEPS.map((s, i) => {
          const state = i === stepIndex ? 'current' : i < stepIndex || i <= furthest ? 'reachable' : 'later';
          return (
            <li key={s} className={cx('bx-stepper__step', `is-${state}`, i < stepIndex && 'is-done')}>
              <button type="button" className="bx-stepper__button" disabled={state === 'later' || busy} aria-current={i === stepIndex ? 'step' : undefined} onClick={() => goTo(s)} tabIndex={-1}>
                <span className="bx-stepper__num" aria-hidden="true">
                  {i < stepIndex ? <Icon name="check" size="xs" /> : i + 1}
                </span>
                <span className="bx-stepper__label">{STEP_LABELS[s]}</span>
              </button>
            </li>
          );
        })}
      </ol>

      <div ref={formRef} className="bx-wizard">
        <div ref={bodyRef} className="bx-wizard__body">
          {step === 'business' ? (
            <Stack gap={3}>
              <h2 className="bx-wizard__step-title">Your business</h2>
              <Field label="Business name" required error={errors.name}>
                <TextInput value={draft.name} onChange={(e) => update({ name: e.target.value })} maxLength={120} placeholder="e.g. Sharma Traders" />
              </Field>
              <Field label="Name on invoices" optional hint="Only if it is different from the business name.">
                <TextInput value={draft.mailingName} onChange={(e) => update({ mailingName: e.target.value })} maxLength={200} placeholder={draft.name || 'Same as business name'} />
              </Field>
              <Field label="Address" optional hint="Ctrl+Enter moves to the next field.">
                <TextArea value={draft.address} onChange={(e) => update({ address: e.target.value })} rows={2} autoGrow maxRows={4} maxLength={500} />
              </Field>
              <FieldGroup columns={2}>
                <Field label="State" required error={errors.stateCode}>
                  <StatePicker value={draft.stateCode} onChange={(code) => update({ stateCode: code })} invalid={!!errors.stateCode} />
                </Field>
                <Field label="PIN code" optional error={errors.pincode}>
                  <TextInput value={draft.pincode} onChange={(e) => update({ pincode: e.target.value.replace(/\D/g, '').slice(0, 6) })} inputMode="numeric" mono />
                </Field>
              </FieldGroup>
              <FieldGroup columns={2}>
                <Field label="Phone" optional>
                  <TextInput value={draft.phone} onChange={(e) => update({ phone: e.target.value })} inputMode="tel" maxLength={40} />
                </Field>
                <Field label="Email" optional error={errors.email}>
                  <TextInput value={draft.email} onChange={(e) => update({ email: e.target.value })} type="email" maxLength={120} />
                </Field>
              </FieldGroup>
            </Stack>
          ) : null}

          {step === 'gst' ? (
            <Stack gap={3}>
              <h2 className="bx-wizard__step-title">GST and tax</h2>
              <RadioGroup<GstRegistrationType>
                label="GST registration"
                options={REGISTRATION_OPTIONS}
                value={draft.gstRegistrationType}
                onChange={(v) => update({ gstRegistrationType: v })}
              />
              {registered ? (
                <Field label="GSTIN" required error={errors.gstin} hint={validateGstin(draft.gstin).valid ? <GstinOk gstin={draft.gstin} /> : 'We fill in the state and PAN from it.'}>
                  <TextInput
                    value={draft.gstin}
                    onChange={(e) => {
                      setDraft((d) => applyGstin(d, e.target.value));
                      setTouched(true);
                      setErrors((er) => ({ ...er, gstin: undefined, pan: undefined, stateCode: undefined }));
                    }}
                    uppercase
                    mono
                    maxLength={15}
                    placeholder="15 characters, e.g. 27AAPFU0939F1ZV"
                    spellCheck={false}
                  />
                </Field>
              ) : (
                <Banner tone="info" inline>
                  Invoices will be plain bills without GST. Turn on GST later from Company Details when you register.
                </Banner>
              )}
              <Field label="PAN" optional error={errors.pan} hint={registered ? 'Filled in from the GSTIN.' : undefined}>
                <TextInput value={draft.pan} onChange={(e) => update({ pan: e.target.value.toUpperCase().slice(0, 10) })} uppercase mono maxLength={10} placeholder="ABCDE1234F" />
              </Field>
            </Stack>
          ) : null}

          {step === 'books' ? (
            <Stack gap={3}>
              <h2 className="bx-wizard__step-title">Books of accounts</h2>
              <Field label="Financial year starts in" required error={errors.fyStartMonth} hint="Most Indian businesses use April (April to March).">
                <Select
                  options={MONTH_OPTIONS}
                  value={String(draft.fyStartMonth)}
                  onChange={(v) => {
                    const m = Number(v);
                    const wasDefault = draft.booksFrom === booksFromForFy(today, draft.fyStartMonth);
                    update({ fyStartMonth: m, ...(wasDefault ? { booksFrom: booksFromForFy(today, m) } : {}) });
                  }}
                />
              </Field>
              <Field label="Books begin on" required error={errors.booksFrom} hint="Usually the first day of the financial year. Opening balances are entered as on this date.">
                <DateInput value={draft.booksFrom || null} onChange={(d) => update({ booksFrom: d ?? '' })} referenceDate={today} showWeekday />
              </Field>
              <p className="bx-wizard__note">
                <Icon name="calendar" size="sm" /> First financial year: <strong>{fy.label}</strong> ({formatDate(fy.start)} to {formatDate(fy.end)})
              </p>
            </Stack>
          ) : null}

          {step === 'features' ? (
            <Stack gap={3}>
              <h2 className="bx-wizard__step-title">What do you need?</h2>
              <p className="bx-muted">Turn on only what you use — the screens stay simpler. Change these any time with F11.</p>
              <div className="bx-feature-list">
                {WIZARD_FEATURES.map((key) => {
                  const info = featureInfo(key);
                  const needsInventory = info?.requires === 'inventory' && !draft.features.inventory;
                  const needsGst = info?.requires === 'gst' && !registered;
                  const blocked = needsInventory ? 'Needs “Maintain stock”.' : needsGst ? 'Needs GST registration.' : null;
                  return (
                    <div key={key} className={cx('bx-feature-row', blocked && 'is-disabled')}>
                      <Switch
                        checked={!blocked && draft.features[key] === true}
                        disabled={!!blocked}
                        onChange={(on) => update({ features: { ...draft.features, [key]: on } })}
                        label={info?.label ?? key}
                      />
                      <p className="bx-feature-row__desc">{blocked ?? info?.description}</p>
                    </div>
                  );
                })}
              </div>
            </Stack>
          ) : null}

          {step === 'security' ? (
            <Stack gap={3}>
              <h2 className="bx-wizard__step-title">Protect your books</h2>
              <div className="bx-feature-row">
                <Switch checked={draft.secure} onChange={(on) => update({ secure: on })} label="Protect this company with a password (recommended)" />
                <p className="bx-feature-row__desc">Anyone who opens this company will need a username and password. You become its Owner.</p>
              </div>
              {draft.secure ? (
                <>
                  <FieldGroup columns={2}>
                    <Field label="Owner username" required error={errors.ownerUsername}>
                      <TextInput value={draft.ownerUsername} onChange={(e) => update({ ownerUsername: e.target.value })} autoComplete="username" maxLength={32} />
                    </Field>
                    <Field label="Your name" optional>
                      <TextInput value={draft.ownerDisplayName} onChange={(e) => update({ ownerDisplayName: e.target.value })} maxLength={80} />
                    </Field>
                  </FieldGroup>
                  <Field label="Password" required error={errors.ownerPassword} hint="At least 8 characters with letters and digits.">
                    <PasswordInput value={draft.ownerPassword} onChange={(e) => update({ ownerPassword: e.target.value })} autoComplete="new-password" />
                  </Field>
                  <StrengthMeter password={draft.ownerPassword} context={[draft.name, draft.ownerUsername]} />
                  <Field label="Type the password again" required error={errors.ownerPasswordConfirm}>
                    <PasswordInput value={draft.ownerPasswordConfirm} onChange={(e) => update({ ownerPasswordConfirm: e.target.value })} autoComplete="new-password" />
                  </Field>
                  <Banner tone="warning" inline>
                    Keep this password safe. If it is lost, the company's data cannot be opened by anyone.
                  </Banner>
                </>
              ) : (
                <Banner tone="warning" title="Not protected">
                  Anyone who uses this computer can open the company and see or change your accounts.
                </Banner>
              )}
            </Stack>
          ) : null}

          {step === 'review' ? (
            <Stack gap={4}>
              <h2 className="bx-wizard__step-title">Check and create</h2>
              <ReviewSection title="Business" onEdit={() => goTo('business')}>
                <KeyValueList
                  items={[
                    { key: 'name', label: 'Business name', value: draft.name },
                    { key: 'mailing', label: 'Name on invoices', value: draft.mailingName || draft.name },
                    { key: 'address', label: 'Address', value: draft.address || '—' },
                    { key: 'state', label: 'State', value: stateLabel(draft.stateCode) || '—' },
                    { key: 'contact', label: 'Contact', value: [draft.phone, draft.email].filter(Boolean).join(' · ') || '—' },
                  ]}
                />
              </ReviewSection>
              <ReviewSection title="GST & tax" onEdit={() => goTo('gst')}>
                <KeyValueList
                  items={[
                    { key: 'reg', label: 'Registration', value: REGISTRATION_OPTIONS.find((o) => o.value === draft.gstRegistrationType)?.label ?? '' },
                    { key: 'gstin', label: 'GSTIN', value: registered ? draft.gstin : '—' },
                    { key: 'pan', label: 'PAN', value: draft.pan || '—' },
                  ]}
                />
              </ReviewSection>
              <ReviewSection title="Books" onEdit={() => goTo('books')}>
                <KeyValueList
                  items={[
                    { key: 'fy', label: 'Financial year', value: `${MONTH_OPTIONS[draft.fyStartMonth - 1]?.label ?? ''} to ${MONTH_OPTIONS[(draft.fyStartMonth + 10) % 12]?.label ?? ''}` },
                    { key: 'from', label: 'Books begin on', value: formatDate(draft.booksFrom) },
                  ]}
                />
              </ReviewSection>
              <ReviewSection title="Features" onEdit={() => goTo('features')}>
                <p className="bx-review__text">
                  {[registered ? 'GST' : null, ...WIZARD_FEATURES.filter((k) => draft.features[k]).map((k) => featureInfo(k)?.label ?? k)].filter(Boolean).join(', ') || 'Accounting only'}
                </p>
              </ReviewSection>
              <ReviewSection title="Security" onEdit={() => goTo('security')}>
                <p className="bx-review__text">{draft.secure ? `Password protected — owner “${draft.ownerUsername}”` : 'Not password protected'}</p>
              </ReviewSection>
              {serverError ? (
                <Banner tone="danger" title="The company was not created">
                  {serverError}
                </Banner>
              ) : null}
            </Stack>
          ) : null}
        </div>

        <div className="bx-wizard__footer">
          <Button variant="ghost" onClick={() => void cancel()} disabled={busy}>
            Cancel
          </Button>
          <span className="bx-wizard__spacer" />
          {stepIndex > 0 ? (
            <Button icon="arrow-left" onClick={back} disabled={busy}>
              Back
            </Button>
          ) : null}
          {step === 'review' ? (
            <Button ref={createRef} variant="primary" icon="check" onClick={() => void create()} loading={busy} shortcut="Ctrl+A">
              Create company
            </Button>
          ) : (
            <Button variant="primary" iconRight="arrow-right" onClick={next} disabled={busy}>
              Next
            </Button>
          )}
        </div>
      </div>
    </GateLayout>
  );
}

function ReviewSection({ title, onEdit, children }: { title: string; onEdit: () => void; children?: ReactNode }) {
  return (
    <section className="bx-review" aria-label={title}>
      <header className="bx-review__header">
        <h3 className="bx-review__title">{title}</h3>
        <Button variant="link" size="sm" onClick={onEdit}>
          Change
        </Button>
      </header>
      {children}
    </section>
  );
}
