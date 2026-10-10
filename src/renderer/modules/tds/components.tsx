/**
 * Shared pieces of the TDS/TCS screens: the "turned off" screen, the TDS ↔ TCS switch (Ctrl+1 /
 * Ctrl+2), saving a text file the core built (quarterly statement CSVs) and small badges.
 */
import { useState } from 'react';
import type { PanStatus, TdsKind } from '../../../shared/types/tds.ts';
import { native } from '../../app/bridge.ts';
import { useNav } from '../../app/nav.tsx';
import type { ScreenActionItem } from '../../app/nav.tsx';
import { Screen } from '../../app/Screen.tsx';
import { useFeatures } from '../../app/state.tsx';
import { Badge, Button, EmptyState, SegmentedControl } from '../../ui/index.ts';
import { enabledKinds, initialKind, KIND_LABEL, PAN_LABEL } from './lib/model.ts';

/** Shown when neither TDS nor TCS (or not the kind the screen needs) is on in F11. */
export function TdsOff({ title, kind }: { title: string; kind?: TdsKind }) {
  const nav = useNav();
  const what = kind ? KIND_LABEL[kind] : 'TDS or TCS';
  return (
    <Screen title={title} icon="percent" hint="Esc Back">
      <EmptyState
        icon="percent"
        title={`${what} is turned off for this company`}
        body="Turn it on in Features (F11) › Taxation to deduct or collect tax at source and see these reports."
        action={
          <Button variant="primary" onClick={() => nav.push('company.features')}>
            Open Features (F11)
          </Button>
        }
      />
    </Screen>
  );
}

/** The kind a screen shows (requested one if on, else the first on) and the Ctrl+1 / Ctrl+2 actions. */
export function useKind(requested: TdsKind | undefined): {
  kind: TdsKind | null;
  kinds: TdsKind[];
  setKind: (k: TdsKind) => void;
  kindActions: ScreenActionItem[];
} {
  const features = useFeatures();
  const kinds = enabledKinds(features);
  const [chosen, setChosen] = useState<TdsKind | null>(() => initialKind(requested, features));
  const kind = chosen && kinds.includes(chosen) ? chosen : (kinds[0] ?? null);
  const kindActions: ScreenActionItem[] = [
    { key: 'Ctrl+1', label: 'TDS', group: 'view', hidden: !kinds.includes('tds') || kinds.length < 2, disabled: kind === 'tds', onClick: () => setChosen('tds') },
    { key: 'Ctrl+2', label: 'TCS', group: 'view', hidden: !kinds.includes('tcs') || kinds.length < 2, disabled: kind === 'tcs', onClick: () => setChosen('tcs') },
  ];
  return { kind, kinds, setKind: setChosen, kindActions };
}

/** TDS | TCS segmented switch (only when both are on). */
export function KindSwitch({ kind, kinds, onChange }: { kind: TdsKind; kinds: readonly TdsKind[]; onChange: (k: TdsKind) => void }) {
  if (kinds.length < 2) return null;
  return <SegmentedControl<TdsKind> aria-label="TDS or TCS" size="sm" value={kind} onChange={onChange} options={kinds.map((x) => ({ value: x, label: KIND_LABEL[x] }))} />;
}

export function PanBadge({ status, pan }: { status: PanStatus; pan: string | null }) {
  if (status === 'valid') return <span className="bx-num">{pan}</span>;
  if (status === 'not_applicable') return null;
  return (
    <Badge size="sm" tone={status === 'invalid' ? 'danger' : 'warning'} icon="alert">
      {status === 'invalid' && pan ? `${pan} — invalid` : PAN_LABEL[status]}
    </Badge>
  );
}

const CSV_FILTERS = [{ name: 'CSV file', extensions: ['csv'] }];

/** Save a CSV the core built where the user chooses. Resolves the path, or null when cancelled. */
export async function saveCsvFile(fileName: string, content: string, title: string): Promise<string | null> {
  const saved = await native('dialog.saveFile', { title, defaultName: fileName, filters: CSV_FILTERS, data: content });
  return saved ? saved.path : null;
}

/** Read a text file (CSV) the user picks; null when cancelled. UTF-8 (a BOM is dropped). */
export async function openCsvFile(title: string): Promise<{ name: string; text: string } | null> {
  const file = await native('dialog.openFile', { title, filters: [{ name: 'CSV or text file', extensions: ['csv', 'txt'] }] });
  if (!file) return null;
  const text = new TextDecoder('utf-8').decode(file.bytes).replace(/^﻿/, '');
  return { name: file.name, text };
}
