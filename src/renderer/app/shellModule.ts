/**
 * The shell's own module: the Home screen (id 'app.gateway', kept for compatibility: the nav landmark
 * is still named "Gateway menu"; 2.0 shows the title "Home" in the h1 and the breadcrumb root).
 * Registered ahead of the feature modules.
 */
import { GatewayScreen } from './Gateway.tsx';
import { ROOT_SCREEN } from './lib/navStack.ts';
import type { ModuleDef } from './registry.ts';

export const shellModule: ModuleDef = {
  id: 'app',
  screens: [{ id: ROOT_SCREEN, title: 'Home', component: GatewayScreen }],
  menu: [],
};
