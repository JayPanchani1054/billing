/**
 * Runtime assembly with an explicit route table. Production code uses createRuntime() from
 * runtime.ts (all module routes); tests use this to run against a subset of routes so they do not
 * depend on every feature module.
 */
import path from 'node:path';
import { createDispatcher } from '../api/dispatch.ts';
import type { RouteMap } from '../api/route.ts';
import { systemClock } from './clock.ts';
import { FileAuditAnchorStore } from './auditAnchors.ts';
import { AppConfigStore } from './config.ts';
import { AppController } from './controller.ts';
import { createLogger } from './logger.ts';
import type { Runtime, RuntimeOptions } from './runtime.ts';

/** Default bound for one shutdown route (RuntimeOptions.shutdownStepTimeoutMs). */
export const SHUTDOWN_STEP_TIMEOUT_MS = 20_000;

export function createRuntimeWithRoutes(opts: RuntimeOptions, routes: RouteMap): Runtime {
  const logger = createLogger({
    dir: opts.logDir ?? path.join(opts.userDataDir, 'logs'),
    console: opts.consoleLog ?? process.env.NODE_ENV === 'development',
  });
  const config = new AppConfigStore(opts.userDataDir, opts.defaultDataDir, (l, m, meta) => logger.log(l, m, meta));
  const controller = new AppController({
    config,
    appVersion: opts.appVersion,
    clock: opts.clock ?? systemClock,
    logger,
    idleTimeoutMs: opts.idleTimeoutMs,
    authorizeDataDir: opts.authorizeDataDir,
    authorizePath: opts.authorizePath,
    auditAnchors: new FileAuditAnchorStore({ dir: opts.userDataDir, log: (l, m, meta) => logger.log(l, m, meta), sealer: opts.secretSealer, key: opts.auditAnchorKey }),
  });
  const dispatcher = createDispatcher(routes, () => controller.dispatchState());
  logger.log('info', 'Runtime started', { version: opts.appVersion, platform: process.platform });

  return {
    dispatch: (route, input) => dispatcher.dispatch(route, input),
    get app() {
      return controller.app;
    },
    shutdown: async () => {
      // Work that must happen while the company is still open (the F12 automatic backup): bounded,
      // so quitting never hangs; a step still running is waited for (bounded) by the controller's drain.
      for (const step of opts.shutdownRoutes ?? []) {
        if (!controller.hasOpenCompany() || !Object.hasOwn(routes, step.route)) continue;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), opts.shutdownStepTimeoutMs ?? SHUTDOWN_STEP_TIMEOUT_MS);
        });
        try {
          const r = await Promise.race([dispatcher.dispatch(step.route, step.input), timeout]);
          if (r === 'timeout') logger.log('warn', 'Shutdown step is taking too long; closing anyway', { route: step.route });
          else if (!r.ok && r.error.code !== 'UNAUTHENTICATED') logger.log('warn', 'Shutdown step failed', { route: step.route, code: r.error.code });
        } catch (err) {
          logger.log('warn', 'Shutdown step failed', { route: step.route, error: err });
        } finally {
          clearTimeout(timer);
        }
      }
      try {
        await controller.shutdown();
      } catch (err) {
        logger.log('error', 'Shutdown failed', { error: err });
      }
    },
    hasOpenCompany: () => controller.hasOpenCompany(),
    getTheme: () => config.get().theme,
    setTheme: (mode) => {
      if (mode !== 'system' && mode !== 'light' && mode !== 'dark') return;
      try {
        config.update({ theme: mode });
      } catch (err) {
        logger.log('warn', 'Could not save the theme preference', { error: err });
      }
    },
  };
}
