/**
 * (2.0) Route schema for a print layout layer (shared/printLayout.ts PrintLayoutSpec). Used by
 * `company.config.save { invoice: { layout } }` (level 'company') and `accounts.voucherType.save
 * { config: { printLayout } }` (level 'voucherType'). The value is cleaned by validatePrintLayout; any
 * issue (unknown / locked / option-owned id, too many entries, a text over its length, a malformed entry)
 * refuses the save with VALIDATION at `<field>.<issue path>` — nothing is silently dropped on save.
 *
 * Kept in its own file (imports only validate helpers and shared code) so the company and accounts
 * schemas can use it without importing the print data builder.
 */
import type { FieldIssue } from '../../../shared/api.ts';
import { validatePrintLayout, type PrintLayoutLevel, type PrintLayoutSpec } from '../../../shared/printLayout.ts';
import type { CompanyConfig } from '../../../shared/settings.ts';
import { customSchema } from '../../lib/schemas.ts';
import type { Schema } from '../../lib/validate.ts';

export function printLayoutSchema(level: Exclude<PrintLayoutLevel, 'print'>): Schema<PrintLayoutSpec> {
  return customSchema<PrintLayoutSpec>((value: unknown, path: string, issues: FieldIssue[]) => {
    const { value: clean, issues: found } = validatePrintLayout(value, level);
    if (found.length === 0) return clean;
    for (const i of found) issues.push({ path: i.path ? `${path}.${i.path}` : path || '(root)', message: i.message });
    return undefined;
  });
}

/**
 * The configuration as the screens get it (`company.config.get` / `.save`): `invoice.layout` cleaned by
 * validatePrintLayout. Invoice Printing sends its whole draft back on save, so a stored layer that is not
 * valid any more (hand-edited, restored, corrupt) would otherwise refuse every later Invoice Printing save
 * with an error on a field that screen does not show. The stored value itself is left as it is until the
 * next save; print data validates it again (print/data.ts).
 */
export function withValidCompanyLayout(cfg: CompanyConfig): CompanyConfig {
  const { value, issues } = validatePrintLayout(cfg.invoice.layout, 'company');
  return issues.length === 0 ? cfg : { ...cfg, invoice: { ...cfg.invoice, layout: value } };
}
