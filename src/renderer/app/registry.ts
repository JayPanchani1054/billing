/**
 * Renderer module contract. Each feature module exports a ModuleDef from
 * src/renderer/modules/<module>/index.ts; the shell builds the Gateway menu, the Go-To
 * palette and the screen router from these. Extend — don't rename.
 */
import type { ComponentType } from 'react';
import type { Permission, VoucherBaseType } from '../../shared/constants.ts';
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
  /** (additive) Requires at least one of these features to be on (e.g. ['tds', 'tcs']). */
  anyFeature?: ReadonlyArray<keyof CompanyFeatures>;
}

export type MenuSection =
  | 'masters'
  | 'transactions'
  | 'reports'
  | 'inventory_reports'
  | 'gst'
  /** TDS / TCS (tds module; shown only when F11 › TDS or TCS is on). */
  | 'tds'
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
  /** (additive) Requires at least one of these features to be on (e.g. ['tds', 'tcs']). */
  anyFeature?: ReadonlyArray<keyof CompanyFeatures>;
  /**
   * (additive) Shown only for these GST registration types of the company (e.g. ['composition'] for
   * CMP-08, ['regular'] for GSTR-1). The screen itself stays openable (it explains itself).
   */
  gstRegistrations?: ReadonlyArray<'regular' | 'composition' | 'unregistered'>;
  /** One plain-language line shown as a tooltip on the Gateway and under the label in Go To. */
  description?: string;
  /**
   * (additive) A voucher-entry item for this predefined voucher type: hidden when the company has
   * deactivated that predefined type (Masters › Voucher Types; MenuContext.inactiveBaseTypes).
   */
  voucherBaseType?: VoucherBaseType;
}

export interface ModuleDef {
  id: string;
  screens: ScreenDef[];
  menu?: MenuItem[];
  /**
   * (additive) Notices at the top of the Gateway's right panel, shown when the company opens (e.g.
   * "3 recurring vouchers are due"). Render null when there is nothing to say; dismissible; they must
   * not bind hotkeys (plain letters belong to the Gateway menu).
   */
  gatewayNotices?: ComponentType[];
  /** (additive) Cards another module adds to the dashboard grid (no hotkeys: the Gateway embeds it). */
  dashboardCards?: ComponentType<{ className?: string }>[];
  /**
   * (additive) Panels at the end of 'vouchers.view' for the voucher shown (links, status). They may add
   * rail actions with useScreenActions (keys must not clash with the voucher view's own).
   */
  voucherPanels?: ComponentType<VoucherPanelProps>[];
}

export interface VoucherPanelProps {
  voucherId: number;
  baseType: VoucherBaseType;
  isCancelled: boolean;
  isOptional: boolean;
  /** VoucherDetail.updatedAt — changes when the voucher is saved again. */
  updatedAt: string;
}
