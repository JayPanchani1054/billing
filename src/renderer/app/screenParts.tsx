/**
 * Helpers both screen templates use (Screen in Screen.tsx, ReportScreen in ReportScreen.tsx): the
 * first-load skeleton and the load-error state. Kept apart so ReportScreen.tsx never imports Screen.tsx
 * (which re-exports it) — no import cycle between the two templates.
 *
 * 2.1 quiet states (SPEC-21 D33): the skeleton is `aria-busy` at once but draws nothing for its first
 * 300 ms (a fast load never flashes grey bars); a load error is one line — its title verbatim
 * ("This could not be loaded" / "You don't have access to this", which e2e reads as detectors) — and
 * a "Try again" link.
 */
import { Button, Skeleton } from '../ui/index.ts';
import { ApiError, userMessage } from './lib/apiErrors.ts';

/** How long the skeleton stays invisible (ms); `aria-busy` is set from the start. Mirrored in shell.css. */
export const SKELETON_DELAY_MS = 300;

/** Placeholder while a screen's first data loads. */
export function ScreenSkeleton({ lines = 6 }: { lines?: number }) {
  return (
    <div className="bx-screen-skeleton" aria-busy="true" aria-label="Loading">
      <Skeleton variant="text" width="40%" />
      <Skeleton variant="text" lines={lines} />
    </div>
  );
}

/** Load error in one line, with Try again (not for a missing permission — retrying cannot help). */
export function ScreenError({ error, onRetry, title = 'This could not be loaded' }: { error: unknown; onRetry?: () => void; title?: string }) {
  const code = error instanceof ApiError ? error.code : null;
  const forbidden = code === 'FORBIDDEN';
  return (
    <div className="bx-screen-error">
      <p className="bx-screen-error__text">
        <strong className="bx-screen-error__title">{forbidden ? "You don't have access to this" : title}</strong>{' '}
        {forbidden ? '— ask the company owner.' : `— ${userMessage(error)}`}
      </p>
      {onRetry && !forbidden ? (
        <Button variant="link" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
