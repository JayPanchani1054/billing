/**
 * Helpers both screen templates use (Screen in Screen.tsx, ReportScreen in ReportScreen.tsx): the
 * first-load skeleton and the load-error state. Kept apart so ReportScreen.tsx never imports Screen.tsx
 * (which re-exports it) — no import cycle between the two templates.
 */
import { Button, EmptyState, Skeleton } from '../ui/index.ts';
import { ApiError, userMessage } from './lib/apiErrors.ts';

/** Placeholder while a screen's first data loads. */
export function ScreenSkeleton({ lines = 6 }: { lines?: number }) {
  return (
    <div className="bx-screen-skeleton" aria-busy="true" aria-label="Loading">
      <Skeleton variant="text" width="40%" />
      <Skeleton variant="text" lines={lines} />
    </div>
  );
}

/** Friendly load error with Retry. */
export function ScreenError({ error, onRetry, title = 'This could not be loaded' }: { error: unknown; onRetry?: () => void; title?: string }) {
  const code = error instanceof ApiError ? error.code : null;
  const forbidden = code === 'FORBIDDEN';
  return (
    <EmptyState
      icon={forbidden ? 'lock' : 'alert'}
      title={forbidden ? "You don't have access to this" : title}
      body={forbidden ? 'Ask the company owner or an administrator for access.' : userMessage(error)}
      action={
        onRetry && !forbidden ? (
          <Button icon="refresh" onClick={onRetry}>
            Try again
          </Button>
        ) : undefined
      }
    />
  );
}
