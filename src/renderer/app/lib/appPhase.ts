/**
 * Top-level routing decision from the app state — pure (tested in appPhase.test.ts).
 *
 *   no bridge → 'no-bridge' · loading → 'loading' · failed → 'error' · first launch → 'first-run'
 *   company open but waiting for a user → 'login' · no company → 'select-company'
 *   user must change password → 'change-password' · otherwise → 'workspace'
 */
import type { AppState } from '../../../shared/types/app.ts';

export type AppPhase = 'no-bridge' | 'loading' | 'error' | 'first-run' | 'select-company' | 'login' | 'change-password' | 'workspace';

export function phaseOf(state: AppState | null, opts: { bridge: boolean; loading: boolean; error: boolean }): AppPhase {
  if (!opts.bridge) return 'no-bridge';
  if (!state) return opts.error ? 'error' : 'loading';
  if (state.firstRun) return 'first-run';
  if (state.pendingLogin) return 'login';
  if (!state.company || !state.session) return 'select-company';
  if (state.session.mustChangePassword) return 'change-password';
  return 'workspace';
}
