/**
 * Runtime assembly with an explicit route table. Production code uses createRuntime() from
 * runtime.ts (all module routes); tests use this to run against a subset of routes so they do not
 * depend on every feature module.
 */
import path from 'node:path';
import { createDispatcher } from '../api/dispatch.ts';
import type { RouteMap } from '../api/route.ts';
import { systemClock } from './clock.ts';
import { AppConfigStore } from './config.ts';
import { AppController } from './controller.ts';
import { createLogger } from './logger.ts';
import type { Runtime, RuntimeOptions } from './runtime.ts';

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
  });
  const dispatcher = createDispatcher(routes, () => controller.dispatchState());
  logger.log('info', 'Runtime started', { version: opts.appVersion, platform: process.platform });

  return {
    dispatch: (route, input) => dispatcher.dispatch(route, input),
    get app() {
      return controller.app;
    },
    shutdown: async () => {
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
