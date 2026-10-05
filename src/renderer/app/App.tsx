/**
 * Root component: providers + the top-level routing decided by the app state
 * (no bridge → explanation; first run → data folder; login; company list; forced password
 * change; otherwise the workspace).
 */
import { useEffect, useMemo } from 'react';
import { modules as featureModules } from '../modules/index.ts';
import { CompanySelect, DataFolderSetup, ForcedChangePassword, LoginScreen } from '../modules/company/gate.ts';
import { Button, EmptyState, Icon, Spinner, ToastProvider, useToast } from '../ui/index.ts';
import { ConfirmProvider } from './confirm.tsx';
import { isApiError, userMessage } from './lib/apiErrors.ts';
import type { ModuleDef } from './registry.ts';
import { shellModule } from './shellModule.ts';
import { AppStateProvider, useAppState } from './state.tsx';
import { Workspace } from './Workspace.tsx';

export function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <AppStateProvider>
          <GlobalErrorToasts />
          <Root />
        </AppStateProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

function Root() {
  const app = useAppState();
  const modules = useMemo<readonly ModuleDef[]>(() => [shellModule, ...featureModules], []);
  switch (app.phase) {
    case 'no-bridge':
      return <BridgeMissing />;
    case 'loading':
      return <Splash />;
    case 'error':
      return <StartupError />;
    case 'first-run':
      return <DataFolderSetup />;
    case 'login':
      return <LoginScreen />;
    case 'select-company':
      return <CompanySelect />;
    case 'change-password':
      return <ForcedChangePassword />;
    case 'workspace': {
      const key = `${app.company?.id ?? ''}:${app.session?.userId ?? 'implicit'}:${app.session?.username ?? ''}`;
      return <Workspace key={key} modules={modules} />;
    }
    default:
      return <Splash />;
  }
}

function Splash() {
  return (
    <div className="bx-splash" role="status" aria-live="polite">
      <span className="bx-splash__mark" aria-hidden="true">
        <Icon name="book" size="xl" />
      </span>
      <span className="bx-splash__name">Bahi ERP</span>
      <Spinner size="md" label="Opening Bahi ERP" />
    </div>
  );
}

function BridgeMissing() {
  return (
    <div className="bx-fullpage">
      <EmptyState
        size="lg"
        icon="alert"
        title="Open Bahi ERP from the desktop app"
        body="This page is part of the Bahi ERP desktop application and works only inside it. Close this browser tab and start Bahi ERP from the Start menu or the desktop shortcut."
      />
    </div>
  );
}

function StartupError() {
  const app = useAppState();
  return (
    <div className="bx-fullpage">
      <EmptyState
        size="lg"
        icon="alert"
        title="Bahi ERP could not start"
        body={`${userMessage(app.error)} If this keeps happening, restart the app; your data is not affected.`}
        action={
          <Button variant="primary" icon="refresh" onClick={() => void app.refresh()} autoFocus>
            Try again
          </Button>
        }
      />
    </div>
  );
}

/** Unhandled promise rejections and script errors become a calm toast (never a blank screen). */
function GlobalErrorToasts() {
  const toast = useToast();
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      const reason: unknown = e.reason;
      if (reason instanceof DOMException && reason.name === 'AbortError') return;
      console.error('[bahi] unhandled rejection', reason);
      e.preventDefault();
      toast.error(isApiError(reason) ? 'That did not work' : 'Something went wrong', { message: userMessage(reason), id: 'unhandled' });
    };
    const onError = (e: ErrorEvent) => {
      // ResizeObserver loop notices are benign.
      if (typeof e.message === 'string' && e.message.includes('ResizeObserver')) return;
      console.error('[bahi] uncaught error', e.error ?? e.message);
      toast.error('Something went wrong', { message: 'The last action may not have finished. Your saved data is safe.', id: 'uncaught' });
    };
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('error', onError);
    return () => {
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('error', onError);
    };
  }, [toast]);
  return null;
}
