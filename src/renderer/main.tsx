/**
 * Renderer entry. Styles load once here (styles/index.css: tokens → base → components → charts →
 * shell → report → gateway).
 * No CSP <meta>: the main process sends CSP headers for app://pevqori.
 * `pevqori:boot` is marked once the entry bundle has been evaluated, before the first render
 * (app/lib/perfMarks.ts, docs/ARCHITECTURE.md §9a).
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import { App } from './app/App.tsx';
import { markBoot } from './app/lib/perfMarks.ts';
import { bootstrapPreferences } from './app/preferences.ts';

markBoot();
bootstrapPreferences();

const container = document.getElementById('root');
if (container) {
  createRoot(container, {
    onUncaughtError: (error) => {
      console.error('[pevqori] uncaught render error', error);
    },
  }).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
