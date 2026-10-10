/**
 * Pure view-model of the in-app updates UI (About › Updates panel, the Home notice). No React, no bridge:
 * everything the panel shows is derived here from the main process's UpdateStatus, so the wording and
 * the button rules are unit-tested (updateView.test.ts).
 */
import type { UpdateStatus } from '../../../../shared/bridge.ts';

export type UpdateActionId = 'check' | 'download' | 'restart' | 'on-quit';

export interface UpdateAction {
  id: UpdateActionId;
  label: string;
  primary: boolean;
}

export interface UpdateView {
  /** One plain-language status line. */
  headline: string;
  detail: string | null;
  tone: 'info' | 'success' | 'warning' | 'danger' | 'neutral';
  /** A check or download is running (buttons disabled, status announced). */
  busy: boolean;
  progress: { percent: number; text: string } | null;
  /** Release notes (plain text) and their heading. */
  notes: { title: string; text: string } | null;
  actions: UpdateAction[];
  /** "Check automatically once a week". Hidden when updates are unavailable. */
  modeSwitch: { visible: boolean; checked: boolean; disabled: boolean; hint: string | null };
  /** "Last checked: …" or null. */
  lastChecked: string | null;
}

/** localStorage keys (per profile; the UI works without storage). */
export const ASKED_AUTOMATIC_KEY = 'pevqori.updates.askedAutomatic';
export const NOTICE_DISMISSED_KEY = 'pevqori.updates.noticeDismissed';

/** 98_765_432 → '94.2 MB'. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}

/** '2026-10-10T06:12:00Z' → 'today at 11:42 am' / 'yesterday at …' / '8-Oct-26' (local time). */
export function checkedText(iso: string | null, now: Date): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  let h = d.getHours();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  const time = `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
  if (d.toDateString() === now.toDateString()) return `today at ${time}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `yesterday at ${time}`;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
}

function releaseDateText(iso: string): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

const NO_SWITCH = { visible: false, checked: false, disabled: true, hint: null };

/** Everything the Updates panel shows, for a status (null = still loading). */
export function updateView(status: UpdateStatus | null, now: Date): UpdateView {
  if (!status) {
    return { headline: 'Looking up the update settings…', detail: null, tone: 'neutral', busy: true, progress: null, notes: null, actions: [], modeSwitch: NO_SWITCH, lastChecked: null };
  }
  const p = status.policy;
  const modeSwitch =
    status.state === 'unavailable'
      ? NO_SWITCH
      : { visible: true, checked: p.mode === 'weekly', disabled: p.locked, hint: p.locked ? (p.reason ?? 'Managed by your administrator.') : null };
  const check: UpdateAction = { id: 'check', label: 'Check for updates', primary: true };
  const base = { busy: false, progress: null, notes: null, modeSwitch, lastChecked: null as string | null };
  const last = (iso: string | null) => checkedText(iso, now);

  switch (status.state) {
    case 'unavailable':
      return { ...base, headline: status.reason, detail: null, tone: 'neutral', actions: [] };
    case 'idle':
      return {
        ...base,
        headline: `You are using Pevqori ${status.current}.`,
        detail: p.mode === 'weekly' ? 'Pevqori checks for a new version once a week.' : 'Pevqori looks for a new version only when you ask.',
        tone: 'neutral',
        actions: [check],
        lastChecked: last(status.lastCheck),
      };
    case 'checking':
      return { ...base, headline: 'Checking for updates…', detail: null, tone: 'info', busy: true, actions: [{ ...check, label: 'Checking…' }] };
    case 'up-to-date':
      return {
        ...base,
        headline: `Pevqori ${status.current} is up to date.`,
        detail: null,
        tone: 'success',
        actions: [{ ...check, primary: false }],
        lastChecked: last(status.checkedAt),
      };
    case 'available': {
      const size = formatSize(status.sizeBytes);
      const date = releaseDateText(status.releaseDate);
      return {
        ...base,
        headline: `Pevqori ${status.version} is available.`,
        detail: [date && `Released ${date}`, size && `Download ${size}`].filter(Boolean).join(' · ') || null,
        tone: 'info',
        notes: status.notes ? { title: `What's new in ${status.version}`, text: status.notes } : null,
        actions: [{ id: 'download', label: 'Download update', primary: true }],
      };
    }
    case 'downloading': {
      const percent = Math.max(0, Math.min(100, Math.round(status.percent)));
      const speed = formatSize(status.bytesPerSecond);
      return {
        ...base,
        headline: `Downloading Pevqori ${status.version}…`,
        detail: 'You can keep working. The download is checked before it is used.',
        tone: 'info',
        busy: true,
        progress: { percent, text: speed ? `${percent}% · ${speed}/s` : `${percent}%` },
        actions: [],
      };
    }
    case 'ready':
      return {
        ...base,
        headline: status.installOnQuit ? `Pevqori ${status.version} will be installed when you quit.` : `Pevqori ${status.version} is ready to install.`,
        detail: 'Installing takes about a minute. Your companies, data and settings are kept.',
        tone: 'success',
        notes: status.notes ? { title: `What's new in ${status.version}`, text: status.notes } : null,
        actions: [
          { id: 'restart', label: 'Restart to update', primary: true },
          ...(status.installOnQuit ? [] : [{ id: 'on-quit' as const, label: 'Install when I quit', primary: false }]),
        ],
      };
    case 'error':
      return {
        ...base,
        headline: status.message,
        detail: null,
        tone: 'danger',
        actions: status.retryable ? [{ ...check, label: 'Try again' }] : [{ ...check, primary: false }],
      };
  }
}

/** The one-time "check automatically?" card: an editable policy, still manual, and not answered yet. */
export function shouldAskAutomatic(status: UpdateStatus | null, answered: boolean): boolean {
  if (!status || answered || status.state === 'unavailable') return false;
  return !status.policy.locked && status.policy.mode === 'manual';
}

/** The Home notice for a status, unless dismissed for this version. */
export function noticeFor(status: UpdateStatus | null, dismissedVersion: string | null): { version: string; title: string; ready: boolean } | null {
  if (!status) return null;
  if (status.state === 'ready') {
    if (dismissedVersion === `ready:${status.version}`) return null;
    return { version: status.version, title: `Pevqori ${status.version} is ready — Restart to update`, ready: true };
  }
  if (status.state === 'available') {
    if (dismissedVersion === `available:${status.version}` || dismissedVersion === `ready:${status.version}`) return null;
    return { version: status.version, title: `Pevqori ${status.version} is available`, ready: false };
  }
  return null;
}

/** The value stored when the notice is dismissed (per version and stage). */
export function dismissKey(notice: { version: string; ready: boolean }): string {
  return `${notice.ready ? 'ready' : 'available'}:${notice.version}`;
}
