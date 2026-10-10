/**
 * Voucher hooks — the documented extension point of the posting engine (shared by several feature
 * modules: documents, tds, …). Extend-only: add optional members / append hooks, never change the
 * meaning of an existing member.
 *
 * A feature module that must check its own voucher fields, add automatic lines to a voucher (TDS/TCS),
 * or derive a per-voucher detail table (like gst_lines) plugs in here instead of duplicating posting
 * logic. Posting stays in this module: hooks only adjust the plan through the context they are given.
 *
 * Two ways to plug in:
 *   - STATIC_HOOKS below (imported here; always active, also in tests that never import the module), or
 *   - registerVoucherHook(hook) from the module (active once that module is imported).
 *
 * Lifecycle (service.ts / posting.ts), in hook order:
 *   compose   preview AND save, first (before prepare and the posting): may return a rewritten input,
 *             e.g. item lines derived from the module's own block (mfg: Manufacturing Journal / Material
 *             In / Out lines from `stockJournal`). Never writes. The rewritten input is what is posted and stored.
 *   prepare   save only, before the plan is built, inside the save transaction. May write masters the
 *             posting needs (e.g. create a duty ledger on demand; audit it with ctx.audit). Never
 *             called by preview.
 *   adjust    preview AND save, after the lines are built and before bill-wise, cost centres, the
 *             balance check and the guards. Never writes. May add entries, change entry amounts (the
 *             voucher must still balance: an invoice-mode imbalance is an INTERNAL error), add to the
 *             invoice value, raise warnings and stash data for write() / preview().
 *   validate  preview AND save, after the plan is built: hard field checks of the module's own voucher
 *             fields (throw a VALIDATION / BUSINESS_RULE AppError). Never writes.
 *   write     save, after header + child rows were written (same transaction): rebuild derived rows
 *             from the data stashed by adjust(). Rows carry date / affects_books / is_post_dated.
 *   afterSave save, after write(): links / state of the module that depend on the saved voucher.
 *   clear     whenever the voucher's child rows are removed: alter (before the rewrite), cancel, delete.
 *   preview   maps the stashed data to extra VoucherPreview fields.
 *
 * A hook must be a cheap no-op when its feature is off or the voucher does not concern it.
 */
import type { VoucherBaseType } from '../../../shared/constants.ts';
import type { Paise } from '../../../shared/money.ts';
import type {
  BillAllocationInput,
  LedgerEntryRole,
  VoucherInput,
  VoucherMode,
  VoucherPreview,
  VoucherWarningCode,
  VoucherWarningLevel,
} from '../../../shared/types/vouchers.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { tdsVoucherHook } from '../tds/hook.ts';
import { gstVoucherHook } from '../gst/hook.ts';
import { mfgVoucherHook } from '../mfg/hook.ts';
import { chequeVoucherHook } from '../cheques/hook.ts';
import { forexVoucherHook } from '../forex/hook.ts';
import type { LedgerInfo, Masters } from './masters.ts';
import type { VoucherTypeInfo } from './numbering.ts';
import type { PlanEntry, PlanEntryForex, PostingEnv, PostingPlan } from './posting.ts';
import type { VoucherRow } from './service.ts';

// ───────────────────────────── validate / afterSave ─────────────────────────────

export interface VoucherHookValidateArgs {
  input: VoucherInput;
  /** The saved voucher being altered, else null. */
  existing: VoucherRow | null;
  baseType: VoucherBaseType;
  partyLedgerId: number | null;
}

export interface VoucherHookSaveArgs extends VoucherHookValidateArgs {
  id: number;
  isNew: boolean;
  number: string | null;
  affectsBooks: boolean;
  isOptional: boolean;
  isPostDated: boolean;
}

// ───────────────────────────── adjust (posting) ─────────────────────────────

/** A computed invoice line (invoice modes), aligned with the input's items / ledgers. */
export interface HookInvoiceLine {
  kind: 'item' | 'ledger';
  /** Index into input.items / input.ledgers. */
  index: number;
  /** Item line: its sales/purchase ledger; ledger line: the ledger. */
  ledgerId: number | null;
  /** Taxable value (excludes GST; a discount line is negative). Non-GST charges: their amount. */
  taxableValue: Paise;
  /** GST on the line (all heads incl. cess). */
  tax: Paise;
  /**
   * Inward computed lines: ITC eligibility as posted ('inputs' | 'capital_goods' | 'input_services' |
   * 'ineligible'; always 'ineligible' for a company that takes no credit); null/absent otherwise.
   */
  itcEligibility?: string | null;
}

export interface PostingAdjustContext {
  readonly env: PostingEnv;
  readonly input: VoucherInput;
  readonly baseType: VoucherBaseType;
  readonly mode: VoucherMode;
  readonly voucherType: VoucherTypeInfo;
  /** Voucher being altered (exclude it from aggregates), else null. */
  readonly voucherId: number | null;
  readonly number: string | null;
  readonly date: string;
  readonly isOptional: boolean;
  readonly masters: Masters;
  /** Party of the voucher (explicit, or inferred in ledger mode). */
  readonly party: LedgerInfo | null;
  /** GST direction (outward: we supply). */
  readonly outward: boolean;
  /** Invoice modes only; empty otherwise. */
  readonly invoiceLines: readonly HookInvoiceLine[];
  /** Invoice modes: the invoice value G after round-off (before hook additions); null otherwise. */
  readonly invoiceValue: Paise | null;
  /** Entries built so far (read; change them only through adjustEntry / addEntry). */
  readonly entries: readonly PlanEntry[];
  /** Append an entry posted by this hook. */
  addEntry(e: { ledgerId: number; amount: Paise; role: LedgerEntryRole; narration?: string | null }): PlanEntry;
  /**
   * Change an entry's amount by `delta` (signed). The amount the entry had before any hook changed it
   * is kept in `originalAmount`, so bill-wise / cost allocations typed for it are rescaled.
   */
  adjustEntry(entry: PlanEntry, delta: Paise): void;
  /** Add to the voucher's invoice value (vouchers.total_amount), e.g. TCS collected on a sale. */
  addToInvoiceValue(delta: Paise): void;
  /** Record the foreign-currency side of an entry (forex module); bill allocations then keep their forexAmount. */
  setForex(entry: PlanEntry, forex: PlanEntryForex): void;
  /**
   * Decide an entry's bill-wise allocations (magnitudes, like BillAllocationInput) instead of the ones
   * typed — e.g. the forex hook carries a settled bill at the INR it was booked at. applyBills checks
   * them exactly like typed allocations (names, pending bills, sum = |entry amount|).
   */
  setBillAllocations(entry: PlanEntry, allocations: BillAllocationInput[]): void;
  warn(code: VoucherWarningCode, message: string, level?: VoucherWarningLevel, path?: string): void;
  /** Data handed to write() and preview() of this hook. */
  setData(data: unknown): void;
}

export interface VoucherHookWriteContext {
  db: Db;
  voucherId: number;
  plan: PostingPlan;
  date: string;
  affectsBooks: boolean;
  isPostDated: boolean;
  /** What adjust() passed to setData (undefined when it did not). */
  data: unknown;
}

// ───────────────────────────── Hook ─────────────────────────────

export interface VoucherHook {
  /** For diagnostics. */
  name?: string;
  /** See the lifecycle above; `voucherId` is the voucher being altered (else null). */
  compose?(env: PostingEnv, input: VoucherInput, voucherType: VoucherTypeInfo, voucherId: number | null): VoucherInput | undefined;
  prepare?(ctx: CompanyCtx, args: { env: PostingEnv; input: VoucherInput; voucherType: VoucherTypeInfo }): void;
  adjust?(ctx: PostingAdjustContext): void;
  validate?(ctx: CompanyCtx, args: VoucherHookValidateArgs): void;
  write?(ctx: VoucherHookWriteContext): void;
  afterSave?(ctx: CompanyCtx, args: VoucherHookSaveArgs): void;
  clear?(db: Db, voucherId: number): void;
  /**
   * Delete / cancel, before anything is removed (inside the transaction): throw an AppError to refuse
   * (e.g. the gst module refuses a document reported in a filed GSTR-1).
   */
  beforeRemove?(ctx: CompanyCtx, row: VoucherRow, action: 'delete' | 'cancel'): void;
  preview?(data: unknown): Partial<VoucherPreview>;
}

/** Always-on hooks (run first, in this order). Extend-only. */
const STATIC_HOOKS: readonly VoucherHook[] = [tdsVoucherHook, gstVoucherHook, mfgVoucherHook, forexVoucherHook, chequeVoucherHook];
const registered: VoucherHook[] = [];

/** Register a hook (idempotent per hook object). */
export function registerVoucherHook(hook: VoucherHook): void {
  if (!registered.includes(hook) && !STATIC_HOOKS.includes(hook)) registered.push(hook);
}

/** Apply every hook's compose() in order (the input unchanged when none rewrites it). */
export function composeVoucherInput(env: PostingEnv, input: VoucherInput, voucherType: VoucherTypeInfo, voucherId: number | null): VoucherInput {
  let out = input;
  for (const hook of voucherHooks()) out = hook.compose?.(env, out, voucherType, voucherId) ?? out;
  return out;
}

/** Hooks in run order: STATIC_HOOKS, then registered ones in registration order. */
export function voucherHooks(): readonly VoucherHook[] {
  return registered.length === 0 ? STATIC_HOOKS : [...STATIC_HOOKS, ...registered];
}
