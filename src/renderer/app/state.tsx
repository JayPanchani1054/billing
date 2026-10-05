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
import { clearQueryCache } from './queryClient.ts';

export type AppPhase = 'no-bridge' | 'loading' | 'error' | 'first-run' | 'select-company' | 'login' | 'change-password' | 'workspace';

export interface AppStateValue {
  phase: AppPhase;
  state: AppState | null;
  error: ApiError | null;
  company: OpenCompanySummary | null;
  session: SessionInfo | null;
  /** Owner holds every permission; with security off the implicit session does too. */
  can: (permission: Permission) => boolean;
  /** Re-read 'app.state' (silent: no loading screen). */
  refresh: () => Promise<AppState | null>;
  /** Adopt an AppState returned by a route (open, create, login, logout, close, dataDir.set). */
  applyState: (next: AppState) => void;
}

const AppStateContext = createContext<AppStateValue | null>(null);

/** Pure routing decision (exported for tests/readability). */
export function phaseOf(state: AppState | null, opts: { bridge: boolean; loading: boolean; error: boolean }): AppPhase {
  if (!opts.bridge) return 'no-bridge';
  if (!state) return opts.error ? 'error' : 'loading';
  if (state.firstRun) return 'first-run';
  if (state.pendingLogin) return 'login';
  if (!state.company || !state.session) return 'select-company';
  if (state.session.mustChangePassword) return 'change-password';
  return 'workspace';
}

export function AppStateProvider({ children }: { children?: ReactNode }) {
  const bridge = hasBridge();
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(bridge);
  const companyIdRef = useRef<string | null>(null);
  const userRef = useRef<string | null>(null);

  const applyState = useCallback((next: AppState) => {
    const companyId = next.company?.id ?? null;
    const user = next.session ? `${next.session.userId ?? 'implicit'}:${next.session.username}` : null;
    // Never let cached data cross companies or users.
    if (companyId !== companyIdRef.current || user !== userRef.current) clearQueryCache();
    companyIdRef.current = companyId;
    userRef.current = user;
    setState(next);
    setError(null);
  }, []);

  const inflight = useRef<Promise<AppState | null> | null>(null);
  const refresh = useCallback((): Promise<AppState | null> => {
    if (!bridge) return Promise.resolve(null);
    if (inflight.current) return inflight.current;
    const p = api('app.state')
      .then(
        (s) => {
          applyState(s);
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
    setSessionErrorListener(() => {
      void refresh();
    });
    return () => setSessionErrorListener(null);
  }, [refresh]);

  const session = state?.session ?? null;
  const can = useCallback(
    (permission: Permission): boolean => {
      if (!session) return false;
      return session.isOwner || session.permissions.includes(permission);
    },
    [session],
  );

  const value = useMemo<AppStateValue>(
    () => ({
      phase: phaseOf(state, { bridge, loading, error: error !== null }),
      state,
      error,
      company: state?.company ?? null,
      session,
      can,
      refresh,
      applyState,
    }),
    [state, bridge, loading, error, session, can, refresh, applyState],
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
