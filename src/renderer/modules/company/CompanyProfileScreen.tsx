/**
 * 'company.profile' — Company Details (alter): identity, address, tax registration, books and logo.
 * Alt+H shows who changed the company details (Edit Log).
 */
import { useMemo, useState } from 'react';
import { formatDate } from '../../../shared/dates.ts';
import type { CompanyProfile, CompanyProfileInput, GstRegistrationType } from '../../../shared/types/company.ts';
import { COMPANY_LOGO_MAX_BYTES } from '../../../shared/types/company.ts';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { native } from '../../app/bridge.ts';
import { bytesToBase64, formatBytes, sniffImageMime } from '../../app/lib/exportFormat.ts';
import { fieldErrorsOf, userMessage } from '../../app/lib/apiErrors.ts';
import { useNav } from '../../app/nav.tsx';
import { ReadOnlyNotice, Screen } from '../../app/Screen.tsx';
import { useAppState, useCan } from '../../app/state.tsx';
import { Banner, Button, DateInput, Field, FieldGroup, Select, Stack, TextArea, TextInput, useEnterAdvance, useToast } from '../../ui/index.ts';
import { GstinOk, StatePicker } from './fields.tsx';
import { EMAIL_RE, gstinAutofill, gstinError, MONTH_OPTIONS, PAN_RE, PINCODE_RE } from './lib/companyForm.ts';
import { normalizeGstin, validateGstin } from '../../../shared/gst/gstin.ts';

const TAN_RE = /^[A-Z]{4}[0-9]{5}[A-Z]$/;
const CIN_RE = /^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/;

interface Draft {
  name: string;
  mailingName: string;
  address: string;
  stateCode: string;
  country: string;
  pincode: string;
  phone: string;
  mobile: string;
  email: string;
  website: string;
  gstRegistrationType: GstRegistrationType;
  gstin: string;
  pan: string;
  tan: string;
  cin: string;
  fyStartMonth: number;
  booksFrom: string;
  logo: string | null;
}

function toDraft(p: CompanyProfile): Draft {
  return {
    name: p.name,
    mailingName: p.mailingName ?? '',
    address: p.address ?? '',
    stateCode: p.stateCode ?? '',
    country: p.country || 'India',
    pincode: p.pincode ?? '',
    phone: p.phone ?? '',
    mobile: p.mobile ?? '',
    email: p.email ?? '',
    website: p.website ?? '',
    gstRegistrationType: p.gstRegistrationType,
    gstin: p.gstin ?? '',
    pan: p.pan ?? '',
    tan: p.tan ?? '',
    cin: p.cin ?? '',
    fyStartMonth: p.fyStartMonth,
    booksFrom: p.booksFrom,
    logo: p.logo,
  };
}

const opt = (s: string): string | null => (s.trim() === '' ? null : s.trim());

function toInput(d: Draft, original: CompanyProfile): CompanyProfileInput {
  const registered = d.gstRegistrationType !== 'unregistered';
  const input: CompanyProfileInput = {
    name: d.name.trim(),
    mailingName: opt(d.mailingName),
    address: opt(d.address),
    stateCode: d.stateCode,
    country: opt(d.country),
    pincode: opt(d.pincode),
    phone: opt(d.phone),
    mobile: opt(d.mobile),
    email: opt(d.email),
    website: opt(d.website),
    gstRegistrationType: d.gstRegistrationType,
    gstin: registered ? opt(normalizeGstin(d.gstin)) : null,
    pan: opt(d.pan.toUpperCase()),
    tan: opt(d.tan.toUpperCase()),
    cin: opt(d.cin.toUpperCase()),
    booksFrom: d.booksFrom,
    fyStartMonth: d.fyStartMonth,
  };
  if (d.logo !== original.logo) input.logo = d.logo;
  return input;
}

function validate(d: Draft): Record<string, string> {
  const e: Record<string, string> = {};
  if (!d.name.trim()) e.name = 'Enter the business name';
  if (!d.stateCode) e.stateCode = 'Choose the state';
  const g = gstinError(d.gstin, d.stateCode, d.gstRegistrationType);
  if (g) e.gstin = g;
  const pan = d.pan.trim().toUpperCase();
  if (pan && !PAN_RE.test(pan)) e.pan = 'PAN should look like ABCDE1234F';
  const tan = d.tan.trim().toUpperCase();
  if (tan && !TAN_RE.test(tan)) e.tan = 'TAN should look like ABCD12345E';
  const cin = d.cin.trim().toUpperCase();
  if (cin && !CIN_RE.test(cin)) e.cin = 'CIN should be 21 characters, e.g. U12345MH2020PTC123456';
  if (d.pincode.trim() && !PINCODE_RE.test(d.pincode.trim())) e.pincode = 'PIN code should be 6 digits';
  if (d.email.trim() && !EMAIL_RE.test(d.email.trim())) e.email = 'Enter an email like name@example.com';
  if (!d.booksFrom) e.booksFrom = 'Enter the books beginning date';
  return e;
}

export function CompanyProfileScreen() {
  const q = useApiQuery('company.profile.get', {});
  if (!q.data) return <Screen title="Company Details" loading={q.loading} error={q.error} onRetry={() => void q.refetch()} />;
  return <ProfileForm key={q.data.updatedAt} profile={q.data} />;
}

function ProfileForm({ profile }: { profile: CompanyProfile }) {
  const app = useAppState();
  const nav = useNav();
  const toast = useToast();
  const canEdit = app.can('company.manage');
  const canAudit = useCan('audit.view');
  const baseline = useMemo(() => toDraft(profile), [profile]);
  const [d, setD] = useState<Draft>(baseline);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [logoError, setLogoError] = useState<string | null>(null);
  const save = useApiMutation('company.profile.save');
  const dirty = JSON.stringify(d) !== JSON.stringify(baseline);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setD((x) => ({ ...x, [k]: v }));
    setErrors((e) => (e[k] ? { ...e, [k]: '' } : e));
  };

  const onGstin = (raw: string) => {
    const fill = gstinAutofill(raw);
    setD((x) => ({ ...x, gstin: fill.gstin, stateCode: fill.stateCode ?? x.stateCode, pan: fill.pan ?? x.pan }));
    setErrors((e) => ({ ...e, gstin: '', pan: '', stateCode: '' }));
  };

  const submit = async () => {
    if (!canEdit || save.pending) return;
    const e = validate(d);
    setErrors(e);
    if (Object.values(e).some(Boolean)) return;
    try {
      await save.mutate(toInput(d, profile));
      await app.refresh();
      toast.success('Company details saved');
    } catch (err) {
      const f = fieldErrorsOf(err);
      if (Object.keys(f).length) setErrors(f);
      else toast.error('Company details were not saved', { message: userMessage(err) });
    }
  };

  const chooseLogo = async () => {
    setLogoError(null);
    try {
      const file = await native('dialog.openFile', { title: 'Choose a logo', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
      if (!file) return;
      if (file.bytes.length > COMPANY_LOGO_MAX_BYTES) {
        setLogoError(`This image is ${formatBytes(file.bytes.length)}. Use an image under 512 KB.`);
        return;
      }
      const mime = sniffImageMime(file.bytes);
      if (!mime) {
        setLogoError('That file is not a PNG, JPEG, WebP or GIF image.');
        return;
      }
      set('logo', `data:${mime};base64,${bytesToBase64(file.bytes)}`);
    } catch (err) {
      setLogoError(userMessage(err));
    }
  };

  const formRef = useEnterAdvance<HTMLDivElement>({ onComplete: () => void submit() });
  const registered = d.gstRegistrationType !== 'unregistered';
  const readOnly = !canEdit;

  return (
    <Screen
      title="Company Details"
      subtitle={`Created ${formatDate(profile.createdAt.slice(0, 10))} · last changed ${formatDate(profile.updatedAt.slice(0, 10))}`}
      icon="building"
      width="form"
      dirty={dirty}
      hint="Enter Next field · Ctrl+A Save · Esc Back"
      actions={[
        { key: 'Ctrl+A', label: 'Save', icon: 'save', primary: true, onClick: () => void submit(), disabled: readOnly || !dirty },
        { key: 'F11', label: 'Features', icon: 'sliders', onClick: () => nav.push('company.features'), group: 'more' },
        {
          key: 'Alt+H',
          label: 'Edit history',
          icon: 'clock',
          // The core audits the company details as entity 'company' #1 (company/service.ts).
          onClick: () => nav.push('security.audit', { entityType: 'company', entityId: 1, label: profile.name }),
          hidden: !canAudit,
          group: 'more',
        },
      ]}
      footer={
        canEdit ? (
          <>
            <Button onClick={() => void nav.back()}>Cancel</Button>
            <Button variant="primary" icon="save" loading={save.pending} disabled={!dirty} onClick={() => void submit()} shortcut="Ctrl+A">
              Save
            </Button>
          </>
        ) : undefined
      }
    >
      <div ref={formRef}>
        <Stack gap={6}>
          {readOnly ? <ReadOnlyNotice what="the company details" /> : null}
          <FieldGroup legend="Business" columns={2}>
            <Field label="Business name" required error={errors.name || undefined}>
              <TextInput value={d.name} onChange={(e) => set('name', e.target.value)} readOnly={readOnly} maxLength={120} />
            </Field>
            <Field label="Name on invoices" optional>
              <TextInput value={d.mailingName} onChange={(e) => set('mailingName', e.target.value)} readOnly={readOnly} placeholder={d.name} maxLength={200} />
            </Field>
          </FieldGroup>

          <FieldGroup legend="Address and contact" columns={2}>
            <Field label="Address" optional>
              <TextArea value={d.address} onChange={(e) => set('address', e.target.value)} readOnly={readOnly} rows={3} autoGrow maxRows={5} maxLength={500} />
            </Field>
            <Stack gap={3}>
              <Field label="State" required error={errors.stateCode || undefined}>
                <StatePicker value={d.stateCode} onChange={(c) => set('stateCode', c)} disabled={readOnly} invalid={!!errors.stateCode} />
              </Field>
              <Field label="PIN code" optional error={errors.pincode || undefined}>
                <TextInput value={d.pincode} onChange={(e) => set('pincode', e.target.value.replace(/\D/g, '').slice(0, 6))} readOnly={readOnly} inputMode="numeric" mono />
              </Field>
            </Stack>
            <Field label="Country" optional>
              <TextInput value={d.country} onChange={(e) => set('country', e.target.value)} readOnly={readOnly} maxLength={60} />
            </Field>
            <Field label="Phone" optional>
              <TextInput value={d.phone} onChange={(e) => set('phone', e.target.value)} readOnly={readOnly} inputMode="tel" maxLength={40} />
            </Field>
            <Field label="Mobile" optional>
              <TextInput value={d.mobile} onChange={(e) => set('mobile', e.target.value)} readOnly={readOnly} inputMode="tel" maxLength={40} />
            </Field>
            <Field label="Email" optional error={errors.email || undefined}>
              <TextInput value={d.email} onChange={(e) => set('email', e.target.value)} readOnly={readOnly} type="email" maxLength={120} />
            </Field>
            <Field label="Website" optional>
              <TextInput value={d.website} onChange={(e) => set('website', e.target.value)} readOnly={readOnly} maxLength={200} />
            </Field>
          </FieldGroup>

          <FieldGroup legend="Tax registration" columns={2}>
            <Field label="GST registration" required>
              <Select<GstRegistrationType>
                value={d.gstRegistrationType}
                disabled={readOnly}
                onChange={(v) => set('gstRegistrationType', v)}
                options={[
                  { value: 'regular', label: 'Regular' },
                  { value: 'composition', label: 'Composition' },
                  { value: 'unregistered', label: 'Not registered' },
                ]}
              />
            </Field>
            {registered ? (
              <Field label="GSTIN" required error={errors.gstin || undefined} hint={validateGstin(d.gstin).valid ? <GstinOk gstin={d.gstin} /> : undefined}>
                <TextInput value={d.gstin} onChange={(e) => onGstin(e.target.value)} readOnly={readOnly} uppercase mono maxLength={15} spellCheck={false} />
              </Field>
            ) : (
              <span />
            )}
            <Field label="PAN" optional error={errors.pan || undefined}>
              <TextInput value={d.pan} onChange={(e) => set('pan', e.target.value.toUpperCase().slice(0, 10))} readOnly={readOnly} uppercase mono />
            </Field>
            <Field label="TAN" optional error={errors.tan || undefined} hint="Needed if you deduct TDS.">
              <TextInput value={d.tan} onChange={(e) => set('tan', e.target.value.toUpperCase().slice(0, 10))} readOnly={readOnly} uppercase mono />
            </Field>
            <Field label="CIN" optional error={errors.cin || undefined} hint="For companies registered with the MCA.">
              <TextInput value={d.cin} onChange={(e) => set('cin', e.target.value.toUpperCase().slice(0, 21))} readOnly={readOnly} uppercase mono />
            </Field>
          </FieldGroup>

          <FieldGroup legend="Books" columns={2}>
            <Field label="Financial year starts in" hint="Can't be changed once vouchers exist.">
              <Select value={String(d.fyStartMonth)} disabled={readOnly} options={MONTH_OPTIONS} onChange={(v) => set('fyStartMonth', Number(v))} />
            </Field>
            <Field label="Books begin on" required error={errors.booksFrom || undefined} hint="No voucher may be dated before this.">
              <DateInput value={d.booksFrom || null} onChange={(v) => set('booksFrom', v ?? '')} readOnly={readOnly} />
            </Field>
          </FieldGroup>

          <FieldGroup legend="Logo" description="Printed on invoices and reports. PNG, JPEG, WebP or GIF, up to 512 KB.">
            <div className="bx-logo-field">
              <div className="bx-logo-field__preview">{d.logo ? <img src={d.logo} alt="Company logo" /> : <span className="bx-muted">No logo</span>}</div>
              {canEdit ? (
                <div className="bx-logo-field__actions">
                  <Button icon="upload" onClick={() => void chooseLogo()}>
                    {d.logo ? 'Replace logo…' : 'Upload logo…'}
                  </Button>
                  {d.logo ? (
                    <Button variant="ghost" icon="trash" onClick={() => set('logo', null)}>
                      Remove
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
            {logoError ? (
              <Banner tone="danger" inline>
                {logoError}
              </Banner>
            ) : null}
          </FieldGroup>
        </Stack>
      </div>
    </Screen>
  );
}
