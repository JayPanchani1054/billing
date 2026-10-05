/**
 * Renderer module contract. Each feature module exports a ModuleDef from
 * src/renderer/modules/<module>/index.ts; the shell builds the Gateway menu, the Go-To
 * palette and the screen router from these. Extend — don't rename.
 */
import type { ComponentType } from 'react';
import type { Permission } from '../../shared/constants.ts';

export interface ScreenProps<P = Record<string, unknown>> {
  /** Parameters passed by nav.push(screenId, params). Must be JSON-serialisable. */
  params: P;
}

export interface ScreenDef {
  /** Globally unique, '<module>.<screen>' e.g. 'accounts.ledger.form'. */
  id: string;
  /** Default title shown in the header/breadcrumb (screens may override at runtime). */
  title: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: ComponentType<ScreenProps<any>>;
  /** Permission needed to open the screen (hidden from menus otherwise). */
  access?: Permission;
  /** 'full' (default) uses the whole workspace; 'dialog' renders as a modal over the current screen. */
  presentation?: 'full' | 'dialog';
}

export type MenuSection =
  | 'masters'
  | 'transactions'
  | 'reports'
  | 'inventory_reports'
  | 'gst'
  | 'banking'
  | 'utilities'
  | 'data'
  | 'security'
  | 'company';

export interface MenuItem {
  section: MenuSection;
  label: string;
  screen: string;
  params?: Record<string, unknown>;
  /** Global shortcut, e.g. 'F8', 'Ctrl+F8', 'Alt+F5'. Registered by the shell. */
  hotkey?: string;
  /** Extra words for the Go-To palette search. */
  keywords?: string[];
  access?: Permission;
  /** Lower sorts first within the section. */
  order?: number;
  /** Requires the company GST feature to be enabled. */
  gstOnly?: boolean;
}

export interface ModuleDef {
  id: string;
  screens: ScreenDef[];
  menu?: MenuItem[];
}
