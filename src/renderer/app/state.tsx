/**
 * App state: the result of 'app.state' (data folder, companies, open company, session) and the
 * top-level routing decision. Routes that change it (open/create/login/logout/close/dataDir) return
 * a fresh AppState — pass it to `applyState()`; otherwise call `refresh()`.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Permission } from '../../shared/constants.ts';
import type { CompanyConfig, CompanyFeatures } from '../../shared/settings.ts';
import type { AppState, OpenCompanySummary, SessionInfo } from '../../shared/types/app.ts';
import { api, setSessionErrorListener } from './api.ts';
import { hasBridge } from './bridge.ts';
import { useApiQuery } from './hooks/useApiQuery.ts';
import { ApiError } from './lib/apiErrors.ts';
import { clearQueryCache, invalidate } from './queryClient.ts';
import { nextLock } from './lib/sessionLock.ts';
import type { LockSnapshot } from './lib/sessionLock.ts';

import { phaseOf } from './lib/appPhase.ts';
import type { AppPhase } from './lib/appPhase.ts';

export type { AppPhase };

export interface AppStateValue {
  phase: AppPhase;
  state: AppState | null;
  error: ApiError | null;
  /** The open company (while locked: the company of the locked workspace). */
  company: OpenCompanySummary | null;
  /** The user's session (while locked: the locked user's, frozen — the server has none). */
  session: SessionInfo | null;
  /**
   * The idle timeout locked the workspace (phase 'locked'): it stays mounted behind the lock screen
   * until the same user logs in again (lib/sessionLock.ts).
   */
  locked: boolean;
  /** Owner holds every permission; with security off the implicit session does too. */
  can: (permission: Permission) => boolean;
  /** Re-read 'app.state' (silent: no loading screen). `lock`: the session ended for inactivity. */
  refresh: (opts?: { lock?: boolean }) => Promise<AppState | null>;
  /**
   * Adopt an AppState returned by a route (open, create, login, logout, close, dataDir.set).
   * `lock: true` when it is the result of an idle timeout ('app.session.lock').
   */
  applyState: (next: AppState, opts?: { lock?: boolean }) => void;
}

const AppStateContext = createContext<AppStateValue | null>(null);

export function AppStateProvider({ children }: { children?: ReactNode }) {
  const bridge = hasBridge();
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(bridge);
  const companyIdRef = useRef<string | null>(null);
  const userRef = useRef<string | null>(null);
  const stateRef = useRef<AppState | null>(null);
  const lockRef = useRef<LockSnapshot | null>(null);
  const [lock, setLock] = useState<LockSnapshot | null>(null);

  const applyState = useCallback((next: AppState, opts: { lock?: boolean } = {}) => {
    const wasLocked = lockRef.current;
    const nowLocked = nextLock(wasLocked, stateRef.current, next, opts.lock === true);
    // While locked, the workspace (and its cache) still belongs to the locked user.
    const session = next.session ?? nowLocked?.session ?? null;
    const companyId = next.company?.id ?? nowLocked?.companyId ?? null;
    const user = session ? `${session.userId ?? 'implicit'}:${session.username}` : null;
    // Never let cached data cross companies or users.
    if (companyId !== companyIdRef.current || user !== userRef.current) clearQueryCache();
    else if (wasLocked && !nowLocked && next.session) invalidate(); // resumed: refresh what is on screen
    companyIdRef.current = companyId;
    userRef.current = user;
    stateRef.current = next;
    lockRef.current = nowLocked;
    setLock(nowLocked);
    setState(next);
    setError(null);
  }, []);

  const inflight = useRef<Promise<AppState | null> | null>(null);
  const lockOnRefresh = useRef(false);
  const refresh = useCallback((opts: { lock?: boolean } = {}): Promise<AppState | null> => {
    if (!bridge) return Promise.resolve(null);
    if (opts.lock) lockOnRefresh.current = true;
    if (inflight.current) return inflight.current;
    const p = api('app.state')
      .then(
        (s) => {
          const lockIt = lockOnRefresh.current;
          lockOnRefresh.current = false;
          applyState(s, { lock: lockIt });
          return s;
        },
        (err: unknown) => {
          setError(err instanceof ApiError ? err : new ApiError('INTERNAL', 'Could not read the application state.'));
          return null;
        },
      )
      .finally(() => {
        inflight.current = null;
        setLoading(false);
      });
    inflight.current = p;
    return p;
  }, [bridge, applyState]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setSessionErrorListener((err) => {
      // Ended for inactivity (server-side check) → lock the workspace instead of tearing it down.
      const details = err.details as { reason?: unknown } | undefined;
      void refresh({ lock: details?.reason === 'idle' });
    });
    return () => setSessionErrorListener(null);
  }, [refresh]);

  const session = state?.session ?? lock?.session ?? null;
  const company = state?.company ?? lock?.company ?? null;
  const can = useCallback(
    (permission: Permission): boolean => {
      if (!session) return false;
      return session.isOwner || session.permissions.includes(permission);
    },
    [session],
  );

  const value = useMemo<AppStateValue>(
    () => ({
      phase: phaseOf(state, { bridge, loading, error: error !== null, locked: lock !== null }),
      state,
      error,
      company,
      session,
      locked: lock !== null,
      can,
      refresh,
      applyState,
    }),
    [state, bridge, loading, error, company, session, lock, can, refresh, applyState],
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState must be used inside <AppStateProvider>');
  return ctx;
}

/** The open company. Only call inside the workspace (throws otherwise). */
export function useCompany(): OpenCompanySummary {
  const c = useAppState().company;
  if (!c) throw new Error('useCompany() needs an open company (use it inside workspace screens)');
  return c;
}

export function useSession(): SessionInfo | null {
  return useAppState().session;
}

/** `useCan('vouchers.create')` → boolean for the current user. */
export function useCan(permission: Permission): boolean {
  return useAppState().can(permission);
}

/** Company features (F11) of the open company. */
export function useFeatures(): CompanyFeatures {
  return useCompany().features;
}

/** Company configuration (F12), cached; undefined while loading. */
export function useCompanyConfig(): CompanyConfig | undefined {
  const company = useAppState().company;
  return useApiQuery('company.config.get', {}, { enabled: company !== null, staleTime: 5 * 60_000 }).data;
}
