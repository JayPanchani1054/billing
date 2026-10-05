/**
 * The shell's own module: the Gateway home screen. Registered ahead of the feature modules.
 */
import { GatewayScreen } from './Gateway.tsx';
import { ROOT_SCREEN } from './lib/navStack.ts';
import type { ModuleDef } from './registry.ts';

export const shellModule: ModuleDef = {
  id: 'app',
  screens: [{ id: ROOT_SCREEN, title: 'Gateway', component: GatewayScreen }],
  menu: [],
};
