/**
 * Workspace-level shell services: overlays (Go To, shortcuts, voucher picker), global hotkeys,
 * native menu commands, session keep-alive and idle lock, the F12 automatic backup (after opening,
 * before closing / quitting), and company/session actions.
 *
 *   const shell = useShell();
 *   shell.openVoucher('sales');   // what F8 does (permission + feature checks, then nav.push)
 *   shell.openGoto();             // Ctrl+G
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { VoucherBaseType } from '../../shared/constants.ts';
import { PREDEFINED_VOUCHER_TYPES } from '../../shared/constants.ts';
import { useHotkeys, useToast } from '../ui/index.ts';
import { api } from './api.ts';
import { native, onBridgeEvent, setNativeDirty } from './bridge.ts';
import { confirmDialog } from './confirm.tsx';
import { GotoPalette } from './GotoPalette.tsx';
import { userMessage } from './lib/apiErrors.ts';
import { featureLabel } from './lib/featureCatalog.ts';
import { VOUCHER_FEATURE, VOUCHER_SHORTCUTS } from './lib/shortcuts.ts';
import { AUTO_BACKUP_CLOSE_WAIT_MS, AUTO_BACKUP_OPEN_DELAY_MS, AUTO_BACKUP_PROGRESS_DELAY_MS, autoBackupNotice, withTimeout } from './lib/autoBackup.ts';
import { IDLE_CHECK_INTERVAL_MS, shouldLock } from './lib/sessionLock.ts';
import { useNav } from './nav.tsx';
import { invalidate } from './queryClient.ts';
import { ShortcutsOverlay } from './ShortcutsOverlay.tsx';
import { useAppState } from './state.tsx';
import { VoucherPicker } from './VoucherPicker.tsx';
import { usePeriod, useWorkingDate } from './working.tsx';

/** Screen id the vouchers module registers for voucher entry (params: { baseType, id? }). */
export const VOUCHER_ENTRY_SCREEN = 'vouchers.entry';

export interface ShellApi {
  openGoto: (initialQuery?: string) => void;
  openShortcuts: () => void;
  openVoucherPicker: () => void;
  /**
   * Open voucher entry for a base type (checks permission and company features first). Pass
   * `{ voucherTypeId }` to enter a company-defined voucher type of that base type.
   */
  openVoucher: (baseType: VoucherBaseType, params?: Record<string, unknown>) => void;
  /** Whether a voucher type can be entered right now, with the reason when not. */
  voucherAvailability: (baseType: VoucherBaseType) => { ok: boolean; reason?: string };
  /** F3: close the company (asks about unsaved work) and return to the company list. */
  closeCompany: () => Promise<void>;
  logout: () => Promise<void>;
  /** Ctrl+Q: confirm and quit the app. */
  quit: () => Promise<void>;
}

const ShellContext = createContext<ShellApi | null>(null);

export function useShell(): ShellApi {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error('useShell must be used inside the workspace');
  return ctx;
}

type Overlay = { kind: 'goto'; query: string } | { kind: 'shortcuts' } | { kind: 'vouchers' } | null;

export function ShellProvider({ children }: { children?: ReactNode }) {
  const nav = useNav();
  const app = useAppState();
  const toast = useToast();
  const [overlay, setOverlay] = useState<Overlay>(null);
  const appRef = useRef(app);
  appRef.current = app;

  const voucherAvailability = useCallback((baseType: VoucherBaseType): { ok: boolean; reason?: string } => {
    const { can, company } = appRef.current;
    if (!can('vouchers.create')) return { ok: false, reason: "You don't have permission to create vouchers." };
    const feature = VOUCHER_FEATURE[baseType];
    if (feature && company && !company.features[feature]) return { ok: false, reason: `Turn on ${featureLabel(feature)} in Features (F11) first.` };
    return { ok: true };
  }, []);

  const openVoucher = useCallback(
    (baseType: VoucherBaseType, params: Record<string, unknown> = {}) => {
      // params.voucherTypeId opens a company-defined type of that base type (F10, Go To).
      const name = PREDEFINED_VOUCHER_TYPES.find((t) => t.baseType === baseType)?.name ?? 'Voucher';
      const a = voucherAvailability(baseType);
      if (!a.ok) {
        toast.info(`${name} entry is not available`, { message: a.reason, id: 'voucher-unavailable' });
        return;
      }
      nav.push(VOUCHER_ENTRY_SCREEN, { baseType, ...params });
    },
    [nav, toast, voucherAvailability],
  );

  /** F12 automatic backup; shows the outcome when there is something to say (lib/autoBackup.ts). */
  const notifyAutoBackup = useCallback(
    (result: unknown) => {
      const n = autoBackupNotice(result);
      if (!n) return;
      if (n.tone === 'success') {
        invalidate('data.backup');
        invalidate('dashboard');
        toast.success(n.title, { message: n.message, id: 'auto-backup' });
      } else {
        toast.warning(n.title, {
          message: n.message,
          id: 'auto-backup',
          duration: 12_000,
          action: n.openBackup && nav.canOpen('data.backup') ? { label: 'Open Backup', onClick: () => nav.push('data.backup') } : undefined,
        });
      }
    },
    [nav, toast],
  );

  /** Before F3 / Ctrl+Q: the automatic backup, waited for at most AUTO_BACKUP_CLOSE_WAIT_MS. */
  const backupBeforeClose = useCallback(async (): Promise<void> => {
    const work = api('data.backup.auto', { trigger: 'close' }).catch(() => null);
    const progress = setTimeout(() => toast.info('Backing up…', { message: 'Automatic backup before closing the company.', id: 'auto-backup', duration: 0 }), AUTO_BACKUP_PROGRESS_DELAY_MS);
    const r = await withTimeout(work, AUTO_BACKUP_CLOSE_WAIT_MS);
    clearTimeout(progress);
    toast.dismiss('auto-backup');
    // On timeout the core still finishes the backup before it closes the database.
    if (r !== 'timeout') notifyAutoBackup(r);
  }, [toast, notifyAutoBackup]);

  // After the company opens (or a user logs in — the workspace is keyed by company and user):
  // catch up on the automatic backup, once the first screen has had time to load.
  const notifyRef = useRef(notifyAutoBackup);
  notifyRef.current = notifyAutoBackup;
  useEffect(() => {
    const timer = setTimeout(() => {
      api('data.backup.auto', { trigger: 'open' }).then(
        (r) => notifyRef.current(r),
        () => undefined,
      );
    }, AUTO_BACKUP_OPEN_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  // Locked: close the shell's own overlays (they are portaled above the hidden workspace).
  useEffect(() => {
    if (app.locked) setOverlay(null);
  }, [app.locked]);

  const closeCompany = useCallback(async () => {
    if (!(await nav.confirmDiscardAll())) return;
    try {
      await backupBeforeClose();
      setNativeDirty(false);
      const next = await api('app.company.close');
      appRef.current.applyState(next);
    } catch (err) {
      toast.error('Could not close the company', { message: userMessage(err) });
    }
  }, [nav, toast, backupBeforeClose]);

  const logout = useCallback(async () => {
    if (!(await nav.confirmDiscardAll())) return;
    try {
      setNativeDirty(false);
      const next = await api('app.auth.logout');
      appRef.current.applyState(next);
    } catch (err) {
      toast.error('Could not log out', { message: userMessage(err) });
    }
  }, [nav, toast]);

  const quit = useCallback(async () => {
    const dirty = nav.hasUnsavedChanges();
    const ok = await confirmDialog({
      title: 'Quit Bahi ERP?',
      message: dirty
        ? 'Some open screens have changes that are not saved. They will be lost if you quit now.'
        : 'Everything you saved is kept. You can open Bahi ERP again any time.',
      confirmLabel: dirty ? 'Discard and quit' : 'Quit',
      cancelLabel: 'Stay',
      tone: dirty ? 'danger' : 'default',
    });
    if (!ok) return;
    await backupBeforeClose();
    setNativeDirty(false);
    try {
      await native('app.quit', undefined);
    } catch (err) {
      toast.error('Could not quit', { message: userMessage(err) });
    }
  }, [nav, toast, backupBeforeClose]);

  const shell = useMemo<ShellApi>(
    () => ({
      openGoto: (initialQuery = '') => setOverlay({ kind: 'goto', query: initialQuery }),
      openShortcuts: () => setOverlay({ kind: 'shortcuts' }),
      openVoucherPicker: () => setOverlay({ kind: 'vouchers' }),
      openVoucher,
      voucherAvailability,
      closeCompany,
      logout,
      quit,
    }),
    [openVoucher, voucherAvailability, closeCompany, logout, quit],
  );

  const close = useCallback(() => setOverlay(null), []);

  return (
    <ShellContext.Provider value={shell}>
      {children}
      <GlobalHotkeys />
      <BridgeCommands />
      <SessionKeepAlive />
      {overlay?.kind === 'goto' ? <GotoPalette initialQuery={overlay.query} onClose={close} /> : null}
      {overlay?.kind === 'shortcuts' ? <ShortcutsOverlay onClose={close} /> : null}
      {overlay?.kind === 'vouchers' ? <VoucherPicker onClose={close} /> : null}
    </ShellContext.Provider>
  );
}

/** Global keys (root hotkey layer: fenced automatically while any dialog is open). */
function GlobalHotkeys() {
  const shell = useShell();
  const nav = useNav();
  const date = useWorkingDate();
  const period = usePeriod();
  const locked = useAppState().locked;

  const map: Record<string, () => void> = {
    F2: () => date.openDialog(),
    'Alt+F2': () => period.openDialog(),
    F3: () => void shell.closeCompany(),
    'Ctrl+G, Alt+G, Ctrl+K': () => shell.openGoto(),
    F10: () => shell.openVoucherPicker(),
    F11: () => nav.push('company.features'),
    F12: () => nav.push('company.config'),
    'F1, Ctrl+H': () => shell.openShortcuts(),
    'Ctrl+Q': () => void shell.quit(),
  };
  for (const v of VOUCHER_SHORTCUTS) {
    const baseType = v.baseType;
    if (baseType) map[v.keys] = () => shell.openVoucher(baseType);
  }
  useHotkeys(map, [], { scope: 'global', enabled: !locked });
  return null;
}

/** Native menu commands ('goto', 'company.close', 'help.shortcuts'). */
function BridgeCommands() {
  const shell = useShell();
  const app = useAppState();
  const shellRef = useRef(shell);
  shellRef.current = shell;
  const lockedRef = useRef(app.locked);
  lockedRef.current = app.locked;
  useEffect(
    () =>
      onBridgeEvent('command', ({ id }) => {
        if (lockedRef.current) return; // nothing reaches the locked workspace
        const s = shellRef.current;
        if (id === 'goto') s.openGoto();
        else if (id === 'company.close') void s.closeCompany();
        else if (id === 'help.shortcuts') s.openShortcuts();
      }),
    [],
  );
  return null;
}

/**
 * Session keep-alive and idle lock (secured companies):
 *  - user activity (keys, mouse, wheel) is remembered; at most once a minute it also calls
 *    'app.session.touch' (a null answer means the session already ended → refresh, which locks);
 *  - when there has been no input for the session's idle timeout (SessionInfo.idleTimeoutMs), the
 *    shell calls 'app.session.lock' and the workspace is locked behind the lock screen
 *    (lib/sessionLock.ts). Background refetches do not count as activity.
 */
function SessionKeepAlive() {
  const app = useAppState();
  const appRef = useRef(app);
  appRef.current = app;
  useEffect(() => {
    let lastInput = Date.now();
    let lastTouch = 0;
    let busy = false;
    let locking = false;
    const touch = () => {
      const now = Date.now();
      if (busy || now - lastTouch < 60_000) return;
      lastTouch = now;
      busy = true;
      api('app.session.touch')
        .then((s) => {
          const a = appRef.current;
          if (s === null && a.session && !a.locked) void a.refresh({ lock: !a.session.implicit });
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    };
    const onActivity = () => {
      lastInput = Date.now();
      if (!appRef.current.locked) touch();
    };
    const lock = () => {
      if (locking) return;
      locking = true;
      api('app.session.lock')
        .then(
          (next) => appRef.current.applyState(next, { lock: true }),
          () => appRef.current.refresh({ lock: true }),
        )
        .finally(() => {
          locking = false;
          lastInput = Date.now();
        });
    };
    const timer = window.setInterval(() => {
      const a = appRef.current;
      if (a.locked || !a.session || a.session.implicit) {
        lastInput = Date.now(); // the clock starts again after unlocking
        return;
      }
      if (shouldLock(Date.now(), lastInput, a.session.idleTimeoutMs)) lock();
    }, IDLE_CHECK_INTERVAL_MS);
    const opts = { capture: true, passive: true } as const;
    window.addEventListener('keydown', onActivity, opts);
    window.addEventListener('pointerdown', onActivity, opts);
    window.addEventListener('pointermove', onActivity, opts);
    window.addEventListener('wheel', onActivity, opts);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('keydown', onActivity, opts);
      window.removeEventListener('pointerdown', onActivity, opts);
      window.removeEventListener('pointermove', onActivity, opts);
      window.removeEventListener('wheel', onActivity, opts);
    };
  }, []);
  return null;
}
