/**
 * Recurring templates as stored (recurring_templates / recurring_runs) — read helpers shared by the
 * voucher hook and the recurring service. No dependency on the vouchers service.
 */
import type { VoucherBaseType } from '../../../shared/constants.ts';
import type { RecurringFrequency, RecurringSchedule } from '../../../shared/types/documents.ts';
import type { VoucherInput } from '../../../shared/types/vouchers.ts';
import type { Db } from '../../db/db.ts';

export interface TemplateDbRow {
  id: number;
  guid: string;
  name: string;
  voucher_type_id: number;
  type_name: string;
  base_type: string;
  input: string;
  frequency: string;
  interval_days: number | null;
  day_of_month: number | null;
  start_date: string;
  end_date: string | null;
  is_active: number;
  source_voucher_id: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export const TEMPLATE_SELECT = `SELECT t.*, vt.name AS type_name, vt.base_type FROM recurring_templates t JOIN voucher_types vt ON vt.id = t.voucher_type_id`;

export interface StoredTemplate extends RecurringSchedule {
  id: number;
  guid: string;
  name: string;
  voucherTypeId: number;
  voucherTypeName: string;
  baseType: VoucherBaseType;
  input: VoucherInput;
  isActive: boolean;
  sourceVoucherId: number | null;
  notes: string | null;
}

export function toTemplate(r: TemplateDbRow): StoredTemplate {
  let input: VoucherInput;
  try {
    input = JSON.parse(r.input) as VoucherInput;
  } catch {
    input = { voucherTypeId: r.voucher_type_id, date: r.start_date, mode: 'ledger' };
  }
  return {
    id: r.id,
    guid: r.guid,
    name: r.name,
    voucherTypeId: r.voucher_type_id,
    voucherTypeName: r.type_name,
    baseType: r.base_type as VoucherBaseType,
    input,
    frequency: r.frequency as RecurringFrequency,
    intervalDays: r.interval_days,
    dayOfMonth: r.day_of_month,
    startDate: r.start_date,
    endDate: r.end_date,
    isActive: r.is_active === 1,
    sourceVoucherId: r.source_voucher_id,
    notes: r.notes,
  };
}

export function loadSchedule(db: Db, id: number): StoredTemplate | null {
  const r = db.get<TemplateDbRow>(`${TEMPLATE_SELECT} WHERE t.id = :id`, { id });
  return r ? toTemplate(r) : null;
}
