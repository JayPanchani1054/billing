/**
 * mfg module (renderer): Bill of Materials, Manufacturing Journal, Material In / Out (job work), Job Work
 * Orders, Production Register, Pending Job Work (CGST s.143) and ITC-04. See README.md.
 *
 *   'mfg.bom.list'            {itemId?}                      Masters › Bills of Materials
 *   'mfg.bom.form'            {id?, itemId?, forResult?}     BOM creation / alteration (revision history Alt+H)
 *   'mfg.journal.entry'       {voucherTypeId? | cls?, id?, duplicateOf?, date?, jobWorkOrderId?, partyId?}
 *                             Manufacturing Journal / Material Out / Material In (vouchers.entry hands
 *                             classed stock journal types over to this screen)
 *   'mfg.jobWorkOrder.list'   {direction?}                   Job Work Out / In Orders
 *   'mfg.jobWorkOrder.form'   {id? | direction, partyId?}
 *   'mfg.production'          {itemId?, bomId?}              Production Register (period)
 *   'mfg.jobWork.pending'     {direction?, partyLedgerId?}   Pending Job Work with s.143 return dates
 *   'mfg.itc04'               —                              ITC-04 (tables 4, 5A, 5B, 5C)
 */
import './mfg.css';
import type { ModuleDef } from '../../app/registry.ts';
import { api, registerGotoProvider } from '../../app/index.ts';
import { BomFormScreen, BomListScreen } from './BomScreens.tsx';
import { JobWorkOrderFormScreen, JobWorkOrderListScreen } from './JobWorkOrderScreens.tsx';
import { JournalEntryScreen } from './JournalEntryScreen.tsx';
import { JobWorkAlertNotice, MfgCard, MfgVoucherPanel } from './notices.tsx';
import { Itc04Screen, PendingJobWorkScreen, ProductionRegisterScreen } from './ReportScreens.tsx';

export type { MfgJournalParams } from './JournalEntryScreen.tsx';

// Go To: bills of materials by item or BOM name, job work orders by number, party or item.
registerGotoProvider({
  id: 'mfg.boms',
  label: 'Bills of Materials',
  minQuery: 2,
  screens: ['mfg.bom.form'],
  search: async (query) =>
    (await api('mfg.bom.list', { search: query, limit: 8 })).rows.map((b) => ({
      id: `bom:${b.id}`,
      label: `${b.itemName} — ${b.name}`,
      group: 'Bills of Materials',
      description: `For ${b.outputQty} ${b.unit} · ${b.components} component${b.components === 1 ? '' : 's'}${b.isDefault ? ' · default' : ''}`,
      screen: 'mfg.bom.form',
      params: { id: b.id },
    })),
});

registerGotoProvider({
  id: 'mfg.jobWorkOrders',
  label: 'Job Work Orders',
  minQuery: 2,
  screens: ['mfg.jobWorkOrder.form'],
  search: async (query) =>
    (await api('mfg.jobWorkOrder.list', { search: query, status: 'all', limit: 8 })).rows.map((o) => ({
      id: `jwo:${o.id}`,
      label: `${o.direction === 'out' ? 'Job Work Out Order' : 'Job Work In Order'} ${o.number}`,
      group: 'Job Work Orders',
      description: `${o.partyName}${o.itemName ? ` · ${o.itemName}` : ''} · ${o.status === 'closed' ? 'closed' : o.overdue ? 'overdue' : 'open'}`,
      screen: 'mfg.jobWorkOrder.form',
      params: { id: o.id },
    })),
});

export const mfgModule: ModuleDef = {
  id: 'mfg',
  screens: [
    { id: 'mfg.bom.list', title: 'Bills of Materials', component: BomListScreen, access: 'masters.view', feature: 'manufacturing', keywords: ['bom', 'recipe', 'components', 'formula'] },
    { id: 'mfg.bom.form', title: 'Bill of Materials', component: BomFormScreen, access: 'masters.view', feature: 'manufacturing', keywords: ['bom'] },
    {
      id: 'mfg.journal.entry',
      title: 'Manufacturing Journal',
      component: JournalEntryScreen,
      access: 'vouchers.view',
      anyFeature: ['manufacturing', 'jobWork'],
      keywords: ['production', 'manufacture', 'job work', 'challan', 'material in', 'material out'],
    },
    { id: 'mfg.jobWorkOrder.list', title: 'Job Work Orders', component: JobWorkOrderListScreen, access: 'vouchers.view', feature: 'jobWork', keywords: ['job work out order', 'job work in order', 'jobwork'] },
    { id: 'mfg.jobWorkOrder.form', title: 'Job Work Order', component: JobWorkOrderFormScreen, access: 'vouchers.view', feature: 'jobWork' },
    { id: 'mfg.production', title: 'Production Register', component: ProductionRegisterScreen, access: 'reports.view', anyFeature: ['manufacturing', 'jobWork'], keywords: ['manufacturing register', 'cost of production'] },
    { id: 'mfg.jobWork.pending', title: 'Pending Job Work', component: PendingJobWorkScreen, access: 'reports.view', feature: 'jobWork', keywords: ['s.143', 'section 143', 'goods with job worker', 'jobwork'] },
    { id: 'mfg.itc04', title: 'ITC-04', component: Itc04Screen, access: 'gst.view', feature: 'jobWork', gstOnly: true, keywords: ['itc 04', 'job work return', 'itc04'] },
  ],
  menu: [
    { section: 'masters', label: 'Bills of Materials', screen: 'mfg.bom.list', order: 45, feature: 'manufacturing', keywords: ['bom', 'recipe'], description: 'Components, by-products and scrap of the goods you make' },
    { section: 'masters', label: 'Create BOM', screen: 'mfg.bom.form', order: 46, feature: 'manufacturing', access: 'masters.create', keywords: ['bill of materials'] },
    { section: 'transactions', label: 'Manufacturing Journal', screen: 'mfg.journal.entry', params: { cls: 'manufacturing' }, order: 41, feature: 'manufacturing', access: 'vouchers.create', keywords: ['production', 'manufacture'], description: 'Make finished goods from a bill of materials; the cost is worked out for you' },
    { section: 'transactions', label: 'Material Out', screen: 'mfg.journal.entry', params: { cls: 'material_out' }, order: 42, feature: 'jobWork', access: 'vouchers.create', keywords: ['job work', 'delivery challan', 'send to job worker'], description: 'Job work challan: send material to a job worker (or back to a principal)' },
    { section: 'transactions', label: 'Material In', screen: 'mfg.journal.entry', params: { cls: 'material_in' }, order: 43, feature: 'jobWork', access: 'vouchers.create', keywords: ['job work', 'receive from job worker'], description: 'Receive goods back from a job worker (or a principal’s material)' },
    { section: 'transactions', label: 'Job Work Orders', screen: 'mfg.jobWorkOrder.list', order: 44, feature: 'jobWork', keywords: ['job work out order', 'job work in order'], description: 'Plan work given to job workers or taken from principals' },
    { section: 'inventory_reports', label: 'Production Register', screen: 'mfg.production', order: 60, anyFeature: ['manufacturing', 'jobWork'], description: 'What was made, from what, and at what cost' },
    { section: 'inventory_reports', label: 'Pending Job Work', screen: 'mfg.jobWork.pending', order: 61, feature: 'jobWork', keywords: ['s.143'], description: 'Goods with job workers and their one-year / three-year return dates' },
    { section: 'gst', label: 'ITC-04', screen: 'mfg.itc04', order: 70, feature: 'jobWork', gstOnly: true, keywords: ['job work return'], description: 'Goods sent to and received from job workers (CSV for the offline tool)' },
  ],
  gatewayNotices: [JobWorkAlertNotice],
  dashboardCards: [MfgCard],
  voucherPanels: [MfgVoucherPanel],
};
