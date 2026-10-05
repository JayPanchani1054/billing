/**
 * 'company.features' (F11) — turn company features on/off, grouped, in plain language.
 */
import { useMemo, useState } from 'react';
import type { CompanyFeatures } from '../../../shared/settings.ts';
import { useApiMutation } from '../../app/hooks/useApiMutation.ts';
import { useApiQuery } from '../../app/hooks/useApiQuery.ts';
import { userMessage } from '../../app/lib/apiErrors.ts';
import { changedFeatures, FEATURE_CATALOG, FEATURE_GROUP_LABELS, featureBlockedReason, normalizeFeatureToggles } from '../../app/lib/featureCatalog.ts';
import type { FeatureInfo } from '../../app/lib/featureCatalog.ts';
import { useNav } from '../../app/nav.tsx';
import { ReadOnlyNotice, Screen } from '../../app/Screen.tsx';
import { useAppState } from '../../app/state.tsx';
import { Banner, Button, FieldGroup, Stack, Switch, useToast } from '../../ui/index.ts';
import { cx } from '../../ui/lib/cx.ts';

export function FeaturesScreen() {
  const q = useApiQuery('company.features.get', {});
  if (!q.data) return <Screen title="Features" loading={q.loading} error={q.error} onRetry={() => void q.refetch()} />;
  return <FeaturesForm key={JSON.stringify(q.data)} saved={q.data} />;
}

const GROUPS: ReadonlyArray<FeatureInfo['group']> = ['accounting', 'inventory', 'taxation', 'security'];

function FeaturesForm({ saved }: { saved: CompanyFeatures }) {
  const app = useAppState();
  const nav = useNav();
  const toast = useToast();
  const canEdit = app.can('company.manage');
  const canSecurity = app.can('security.manage');
  const [draft, setDraft] = useState<CompanyFeatures>(saved);
  const [error, setError] = useState<string | null>(null);
  const save = useApiMutation('company.features.save');
  const changed = useMemo(() => changedFeatures(saved, draft), [saved, draft]);
  const dirty = changed.length > 0;
  const unregistered = !app.company?.gstin;

  const toggle = (key: keyof CompanyFeatures, on: boolean) => {
    setDraft((d) => normalizeFeatureToggles({ ...d, [key]: on }));
    setError(null);
  };

  const submit = async () => {
    if (!dirty || !canEdit || save.pending) return;
    const patch: Partial<CompanyFeatures> = {};
    for (const k of changed) patch[k] = draft[k];
    try {
      await save.mutate(patch);
      await app.refresh();
      const gstOn = patch.gst === true;
      toast.success('Features saved', { message: gstOn ? 'GST is on. The GST tax ledgers have been created for you.' : undefined });
    } catch (err) {
      setError(userMessage(err));
    }
  };

  const blockedReason = (info: FeatureInfo): string | null => {
    if (info.key === 'gst' && unregistered && !draft.gst) return 'Your company is not GST-registered. Add the GSTIN in Company Details first.';
    if (info.key === 'security' && !canSecurity) return 'Only a user who manages security can change this.';
    return featureBlockedReason(info.key, draft);
  };

  return (
    <Screen
      title="Features"
      subtitle="Turn on only what your business uses — screens stay simpler."
      icon="sliders"
      width="form"
      dirty={dirty}
      hint="Tab Move · Space or Y/N Toggle · Ctrl+A Save · Esc Back"
      actions={[
        { key: 'Ctrl+A', label: 'Save', icon: 'save', primary: true, onClick: () => void submit(), disabled: !dirty || !canEdit },
        { key: 'F12', label: 'Configure', icon: 'settings', onClick: () => nav.push('company.config'), group: 'more' },
      ]}
      footer={
        canEdit ? (
          <>
            <Button onClick={() => void nav.back()}>Cancel</Button>
            <Button variant="primary" icon="save" disabled={!dirty} loading={save.pending} onClick={() => void submit()} shortcut="Ctrl+A">
              Save {dirty ? `(${changed.length} change${changed.length === 1 ? '' : 's'})` : ''}
            </Button>
          </>
        ) : undefined
      }
    >
      <Stack gap={6}>
        {!canEdit ? <ReadOnlyNotice what="the features" /> : null}
        {error ? (
          <Banner tone="danger" title="Features were not saved" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        ) : null}
        {GROUPS.map((group) => (
          <FieldGroup key={group} legend={FEATURE_GROUP_LABELS[group]}>
            <div className="bx-feature-list">
              {FEATURE_CATALOG.filter((f) => f.group === group).map((info) => {
                const reason = blockedReason(info);
                const changedHere = draft[info.key] !== saved[info.key];
                return (
                  <div key={info.key} className={cx('bx-feature-row', reason && 'is-disabled', changedHere && 'is-changed')}>
                    <Switch checked={draft[info.key]} disabled={!canEdit || (!!reason && !draft[info.key])} onChange={(on) => toggle(info.key, on)} label={info.label} />
                    <p className="bx-feature-row__desc">{reason && !draft[info.key] ? reason : info.description}</p>
                  </div>
                );
              })}
            </div>
          </FieldGroup>
        ))}
      </Stack>
    </Screen>
  );
}
