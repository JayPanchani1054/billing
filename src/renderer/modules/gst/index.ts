/**
 * GST module: returns (GSTR-1, GSTR-3B, GSTR-9), registers and analysis (HSN, sales / purchase
 * register, ITC, exceptions) and compliance files (e-invoice, e-way bill). Every screen needs GST
 * turned on (gstOnly); reads need gst.view, files and manual entries need gst.file (checked per action).
 */
import type { ModuleDef } from '../../app/registry.ts';
import { EinvoiceScreen } from './EinvoiceScreen.tsx';
import { EwaybillScreen } from './EwaybillScreen.tsx';
import { Gstr1Screen } from './Gstr1Screen.tsx';
import { Gstr1SectionScreen } from './Gstr1SectionScreen.tsx';
import { Gstr3bScreen } from './Gstr3bScreen.tsx';
import { Gstr9Screen } from './Gstr9Screen.tsx';
import { GstExceptionsScreen, GstRegisterScreen, HsnSummaryScreen, ItcScreen } from './RegisterScreens.tsx';
import './gst.css';

export const gstModule: ModuleDef = {
  id: 'gst',
  screens: [
    { id: 'gst.gstr1', title: 'GSTR-1', component: Gstr1Screen, access: 'gst.view', gstOnly: true, keywords: ['gstr1', 'outward', 'sales return', 'b2b', 'b2c', 'json', 'portal'] },
    { id: 'gst.gstr1.section', title: 'GSTR-1 Table', component: Gstr1SectionScreen, access: 'gst.view', gstOnly: true },
    { id: 'gst.gstr3b', title: 'GSTR-3B', component: Gstr3bScreen, access: 'gst.view', gstOnly: true, keywords: ['gstr3b', 'summary return', 'itc', 'set off', 'cash', 'payment', 'json'] },
    { id: 'gst.gstr9', title: 'GSTR-9', component: Gstr9Screen, access: 'gst.view', gstOnly: true, keywords: ['gstr9', 'annual return', 'yearly'] },
    { id: 'gst.hsn', title: 'HSN/SAC Summary', component: HsnSummaryScreen, access: 'gst.view', gstOnly: true, keywords: ['hsn', 'sac', 'table 12', 'uqc'] },
    { id: 'gst.register', title: 'GST Register', component: GstRegisterScreen, access: 'gst.view', gstOnly: true, keywords: ['sales register', 'purchase register', 'gst register'] },
    { id: 'gst.itc', title: 'Input Tax Credit', component: ItcScreen, access: 'gst.view', gstOnly: true, keywords: ['itc', 'input credit', 'blocked credit', '17(5)'] },
    { id: 'gst.exceptions', title: 'GST Exceptions', component: GstExceptionsScreen, access: 'gst.view', gstOnly: true, keywords: ['uncertain transactions', 'errors', 'mismatch', 'gstin', 'hsn missing'] },
    { id: 'gst.einvoice', title: 'e-Invoice', component: EinvoiceScreen, access: 'gst.view', gstOnly: true, feature: 'einvoice', keywords: ['irn', 'irp', 'einvoice', 'qr code'] },
    { id: 'gst.ewaybill', title: 'e-Way Bills', component: EwaybillScreen, access: 'gst.view', gstOnly: true, feature: 'ewayBill', keywords: ['eway', 'ewb', 'transport', 'vehicle'] },
  ],
  menu: [
    { section: 'gst', label: 'GSTR-1', screen: 'gst.gstr1', order: 10, description: 'Sales return for the month or quarter — tables, checks and JSON' },
    { section: 'gst', label: 'GSTR-3B', screen: 'gst.gstr3b', order: 20, description: 'Summary return — tax payable, ITC set-off and cash to pay' },
    { section: 'gst', label: 'GST Exceptions', screen: 'gst.exceptions', order: 30, description: 'Entries to fix before filing' },
    { section: 'gst', label: 'e-Invoice', screen: 'gst.einvoice', order: 40, description: 'Generate e-invoice JSON and record IRNs' },
    { section: 'gst', label: 'e-Way Bills', screen: 'gst.ewaybill', order: 50, description: 'Invoices that need an e-way bill and their numbers' },
    { section: 'gst', label: 'GST Register', screen: 'gst.register', order: 60, description: 'Sales and purchases with their GST, one line per document' },
    { section: 'gst', label: 'HSN/SAC Summary', screen: 'gst.hsn', order: 70, description: 'Supplies by HSN/SAC code and rate' },
    { section: 'gst', label: 'Input Tax Credit', screen: 'gst.itc', order: 80, description: 'ITC by supplier: eligible, blocked, reverse charge, imports' },
    { section: 'gst', label: 'GSTR-9', screen: 'gst.gstr9', order: 90, description: 'Annual summary prepared from the books' },
  ],
};
