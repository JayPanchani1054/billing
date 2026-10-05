/**
 * Renderer entry. Styles load once here (tokens → base → components, then the shell layer).
 * No CSP <meta>: the main process sends CSP headers for app://bahi.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import './styles/shell.css';
import { App } from './app/App.tsx';
import { bootstrapPreferences } from './app/preferences.ts';

bootstrapPreferences();

const container = document.getElementById('root');
if (container) {
  createRoot(container, {
    onUncaughtError: (error) => {
      console.error('[bahi] uncaught render error', error);
    },
  }).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
