/**
 * One empty-state rule (SPEC §5.2): every `<DataTable` in a module screen says what an empty list
 * means and, where it helps, offers the next step — through its `empty` prop (an `EmptyState` with
 * an action: "No customers yet. Create customer (Alt+C)"). The kit's fallback ("Nothing to show") is
 * only a safety net. Read from source (the screens import React).
 *
 * Ratchet: the tables that relied on the fallback when 2.0 started are listed below with their count
 * per file. The list may only shrink — a new table without its own empty state fails, and a file that
 * got better fails until its entry is lowered (or removed).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const modulesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../modules');

/** Today's offenders: file (relative to modules/) → number of DataTables without an empty state. */
const RATCHET: Readonly<Record<string, number>> = {
  'accounts/ChartScreen.tsx': 1,
  'accounts/CostCentresScreen.tsx': 2,
  'accounts/CurrenciesScreen.tsx': 2,
  'accounts/GroupScreens.tsx': 1,
  'accounts/LedgerFormScreen.tsx': 1,
  'accounts/LedgerListScreen.tsx': 1,
  'accounts/OpeningBalancesScreen.tsx': 1,
  'accounts/VoucherTypeScreens.tsx': 1,
  'attachments/AttachmentsScreens.tsx': 2,
  'banking/ImportScreen.tsx': 1,
  'banking/SummaryScreen.tsx': 1,
  'cheques/BookScreens.tsx': 1,
  'cheques/EPaymentScreen.tsx': 1,
  'cheques/LayoutScreens.tsx': 1,
  'cheques/PayeeScreens.tsx': 1,
  'cheques/RegisterScreen.tsx': 1,
  'company/CompanySelect.tsx': 1,
  'dashboard/components.tsx': 6,
  'data/BackupScreen.tsx': 1,
  'data/ImportScreen.tsx': 4,
  'data/VerifyScreen.tsx': 1,
  'data/XmlImportScreen.tsx': 4,
  'documents/PendingScreens.tsx': 2,
  'documents/PlanningScreens.tsx': 3,
  'documents/QuotationsScreen.tsx': 1,
  'documents/RecurringScreens.tsx': 3,
  'documents/components.tsx': 1,
  'forex/LedgerScreen.tsx': 1,
  'forex/OutstandingScreen.tsx': 1,
  'forex/RevaluationScreen.tsx': 1,
  'gst/AdvancesBoeScreens.tsx': 6,
  'gst/CompositionScreens.tsx': 5,
  'gst/EinvoiceScreen.tsx': 2,
  'gst/EwaybillScreen.tsx': 1,
  'gst/FilingScreens.tsx': 2,
  'gst/GapsScreens.tsx': 2,
  'gst/Gstr1SectionScreen.tsx': 5,
  'gst/Gstr9Screen.tsx': 1,
  'gst/LedgerScreens.tsx': 3,
  'gst/RegisterScreens.tsx': 4,
  'gst/SetoffScreen.tsx': 1,
  'gstrecon/GstReconScreen.tsx': 1,
  'inventory/GstFields.tsx': 1,
  'mfg/BomScreens.tsx': 3,
  'mfg/JobWorkOrderScreens.tsx': 2,
  'mfg/ReportScreens.tsx': 4,
  'outstanding/DueSoon.tsx': 1,
  'outstanding/InterestScreen.tsx': 2,
  'outstanding/OutstandingReport.tsx': 3,
  'outstanding/PartyScreen.tsx': 2,
  'outstanding/RemindersScreen.tsx': 1,
  'outstanding/StatementScreen.tsx': 2,
  'pos/CounterScreen.tsx': 1,
  'pos/ReturnScreen.tsx': 1,
  'pos/SettingsScreen.tsx': 1,
  'pos/SummaryScreen.tsx': 4,
  'pos/components.tsx': 3,
  'reports/CostCentresScreen.tsx': 2,
  'reports/ExceptionsScreen.tsx': 2,
  'reports/FlowScreens.tsx': 4,
  'reports/GroupSummaryScreen.tsx': 1,
  'reports/LedgerScreen.tsx': 1,
  'reports/MonthlySummaryScreen.tsx': 1,
  'reports/ProfitLossScreen.tsx': 1,
  'reports/RatiosScreen.tsx': 1,
  'reports/RegisterScreen.tsx': 2,
  'reports/StatisticsScreen.tsx': 2,
  'reports/components.tsx': 2,
  'security/AuditScreen.tsx': 1,
  'security/UsersRolesScreen.tsx': 2,
  'stock/AnalysisScreens.tsx': 4,
  'stock/GodownsScreen.tsx': 1,
  'stock/ItemScreen.tsx': 1,
  'stock/MovementScreen.tsx': 1,
  'stock/RegisterScreens.tsx': 3,
  'stock/SummaryScreens.tsx': 1,
  'tds/LedgerScreens.tsx': 1,
  'tds/NatureScreens.tsx': 1,
  'tds/ReceivableScreen.tsx': 1,
  'tds/ReportScreens.tsx': 6,
  'tds/ReturnScreen.tsx': 1,
  'vouchers/VoucherTable.tsx': 1,
  'vouchers/VoucherViewScreen.tsx': 3,
};

function sources(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith('.tsx')) out.push({ file: path.relative(modulesDir, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') });
  }
  return out;
}

/**
 * The opening tag of each `<DataTable …>` (attributes only, up to its closing `>` / `/>` at brace
 * depth 0; strings and nested JSX inside `{…}` are skipped over).
 */
export function dataTableTags(text: string): string[] {
  const out: string[] = [];
  const re = /<DataTable\b/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let i = m.index + m[0].length;
    let depth = 0;
    let quote: string | null = null;
    for (; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        quote = c;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    out.push(text.slice(m.index, i + 1));
  }
  return out;
}

const hasEmptyState = (tag: string): boolean => /\s(?:empty|emptyState|emptyText)=/.test(tag);

describe('empty states', () => {
  const files = sources(modulesDir);
  const offenders = new Map<string, number>();
  let tables = 0;
  for (const f of files) {
    for (const tag of dataTableTags(f.text)) {
      tables++;
      if (!hasEmptyState(tag)) offenders.set(f.file, (offenders.get(f.file) ?? 0) + 1);
    }
  }

  test('the scan reads every module table', () => {
    assert.ok(tables >= 90, `only ${tables} DataTables found`);
    assert.equal(hasEmptyState('<DataTable rows={rows} empty={<EmptyState title="x" />} />'), true);
    assert.equal(hasEmptyState('<DataTable rows={rows} columns={cols} />'), false);
    // Nested JSX and arrows inside braces do not end the tag early.
    assert.deepEqual(dataTableTags('<DataTable a={() => <b>x</b>} c={x > 1 ? "y>" : `z`} empty={<E />} />\n<p />'), ['<DataTable a={() => <b>x</b>} c={x > 1 ? "y>" : `z`} empty={<E />} />']);
  });

  test('no new table without its own empty state (ratchet of the 2.0 baseline)', () => {
    const worse: string[] = [];
    for (const [file, n] of offenders) {
      const allowed = RATCHET[file] ?? 0;
      if (n > allowed) worse.push(`${file}: ${n} DataTable(s) without \`empty\` (allowed ${allowed})`);
    }
    assert.deepEqual(worse, []);
  });

  test('the ratchet only shrinks: lower an entry when a file gets better', () => {
    const stale: string[] = [];
    for (const [file, allowed] of Object.entries(RATCHET)) {
      const n = offenders.get(file) ?? 0;
      if (n < allowed) stale.push(`${file}: allowed ${allowed}, now ${n} — lower the entry`);
    }
    assert.deepEqual(stale, []);
  });
});
