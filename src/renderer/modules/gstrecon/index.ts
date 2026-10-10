/**
 * GST reconciliation: GSTR-2B / GSTR-2A against purchase books and GSTR-1 against sales books.
 * One screen ('gstrecon.home'); reads and the supplier e-mail need gst.view, the export also needs
 * data.export, imports / runs / decisions need gst.file (checked per action). GST must be on (gstOnly).
 */
import type { ModuleDef } from '../../app/registry.ts';
import { GstReconScreen } from './GstReconScreen.tsx';
import './gstrecon.css';

export const gstreconModule: ModuleDef = {
  id: 'gstrecon',
  screens: [
    {
      id: 'gstrecon.home',
      title: 'GST Reconciliation',
      component: GstReconScreen,
      access: 'gst.view',
      gstOnly: true,
      keywords: ['gstr2b', 'gstr-2b', 'gstr2a', '2b', '2a', 'itc', 'reconcile', 'reconciliation', 'matching', 'supplier', 'portal', 'gstr1 vs books'],
    },
  ],
  menu: [
    {
      section: 'gst',
      label: 'GST Reconciliation',
      screen: 'gstrecon.home',
      order: 24,
      keywords: ['2b', '2a', 'itc', 'match', 'reconcile'],
      description: 'Match GSTR-2B / 2A with purchases and GSTR-1 with sales; follow up with suppliers',
    },
  ],
};
