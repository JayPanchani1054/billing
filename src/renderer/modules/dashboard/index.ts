/**
 * Dashboard module: 'dashboard.home' {embedded?}. Home renders it inline in its right panel with
 * { embedded: true } (2.1: the period, three figures, the "Sales — last 12 months" graph, Needs your
 * attention, the one-line Setup and "Full dashboard"; its one key is Ctrl+J while the graph exists);
 * Go To / the Reports menu open the full page (four figures, two graphs, the other cards as one line each).
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
