/**
 * Renderer module contract. Each feature module exports a ModuleDef from
 * src/renderer/modules/<module>/index.ts; the shell builds the Gateway menu, the Go-To
 * palette and the screen router from these. Extend — don't rename.
 */
import type { ComponentType } from 'react';
import type { Permission } from '../../shared/constants.ts';
import type { CompanyFeatures } from '../../shared/settings.ts';

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
  /**
   * Offer this screen in the Go To palette even though no menu item points at it. Only for screens
   * that work without params (menu items are always offered). Default false.
   */
  goto?: boolean;
  /** Extra words for the Go To palette search. */
  keywords?: string[];
  /** Requires this company feature (F11) to be on — hidden from menus/Go To and refused otherwise. */
  feature?: keyof CompanyFeatures;
  /** Requires the company GST feature to be on. */
  gstOnly?: boolean;
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
  /** Requires this company feature (F11) to be on, e.g. 'inventory' for stock reports. */
  feature?: keyof CompanyFeatures;
  /** One plain-language line shown as a tooltip on the Gateway and under the label in Go To. */
  description?: string;
}

export interface ModuleDef {
  id: string;
  screens: ScreenDef[];
  menu?: MenuItem[];
}
