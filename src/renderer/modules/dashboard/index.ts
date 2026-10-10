/**
 * Dashboard module: 'dashboard.home' {embedded?}. Home renders it inline in its right panel with
 * { embedded: true } (the 2.0 Home variant: four tiles, attention, Get started, recent vouchers and
 * "Show more insights"; no hotkeys); Go To / the Reports menu open the full page (unchanged).
 * Data: 'dashboard.summary' (src/core/modules/dashboard). See src/core/modules/dashboard/README.md.
 */
import type { ModuleDef } from '../../app/registry.ts';
import { DashboardScreen } from './DashboardScreen.tsx';
import './dashboard.css';

export const dashboardModule: ModuleDef = {
  id: 'dashboard',
  screens: [
    {
      id: 'dashboard.home',
      title: 'Dashboard',
      component: DashboardScreen,
      access: 'reports.view',
      goto: true,
      keywords: ['dashboard', 'home', 'overview', 'kpi', 'summary', 'business at a glance', 'mis'],
    },
  ],
  menu: [
    {
      section: 'reports',
      label: 'Dashboard',
      screen: 'dashboard.home',
      order: 0,
      keywords: ['dashboard', 'overview', 'kpi', 'summary', 'mis'],
      description: 'Sales, dues, cash, GST and alerts at a glance',
    },
  ],
};
