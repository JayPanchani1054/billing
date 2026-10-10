/**
 * POS storage helpers: settings (settings table, key 'pos'), tender modes, the system exchange-credit
 * ledger + mode, the POS voucher types created when F11 › POS invoicing is turned on, and the
 * counter context.
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_POS_SETTINGS, POS_USER_TENDER_KINDS, type PosContext, type PosSettings, type PosSettingsInput, type PosTenderKind, type PosTenderMode, type PosTenderModeSaveInput } from '../../../shared/types/pos.ts';
import type { CompanyCtx } from '../../api/context.ts';
import type { Db } from '../../db/db.ts';
import { AppError, notFound, rule, validation } from '../../lib/errors.ts';
import { classFromChain, groupChain } from '../accounts/books.ts';
import { getFeatures, readSetting, writeSetting } from '../company/service.ts';

/** reserved_code of the system ledger exchange credit is kept in (Current Liabilities). */
export const POS_EXCHANGE_LEDGER_CODE = 'POS_EXCHANGE';
export const POS_EXCHANGE_LEDGER_NAME = 'POS Exchange Credit';
const POS_EXCHANGE_GROUP = 'CURRENT_LIABILITIES';

type Audit = CompanyCtx['audit'];

// ───────────────────────────── Feature gate ─────────────────────────────

export const POS_OFF_MESSAGE = 'POS invoicing is turned off. Turn it on in F11 › Features › POS invoicing.';

export function assertPosEnabled(db: Db): void {
  if (!getFeatures(db).pos) throw rule(POS_OFF_MESSAGE);
}

// ───────────────────────────── Settings ─────────────────────────────

const idOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);

export function getPosSettings(db: Db): PosSettings {
  const raw = readSetting(db, 'pos');
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    saleVoucherTypeId: idOrNull(s.saleVoucherTypeId),
    returnVoucherTypeId: idOrNull(s.returnVoucherTypeId),
    walkInLedgerId: idOrNull(s.walkInLedgerId),
    priceLevelId: idOrNull(s.priceLevelId),
    godownId: idOrNull(s.godownId),
    printAfterSave: typeof s.printAfterSave === 'boolean' ? s.printAfterSave : DEFAULT_POS_SETTINGS.printAfterSave,
    askCustomerFirst: typeof s.askCustomerFirst === 'boolean' ? s.askCustomerFirst : DEFAULT_POS_SETTINGS.askCustomerFirst,
  };
}

interface TypeRow {
  id: number;
  name: string;
  abbreviation: string | null;
  base_type: string;
  is_active: number;
  config: string;
}

function parseConfig(raw: string | null): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function isPosType(config: Record<string, unknown> | null | undefined): boolean {
  return config?.posInvoice === true;
}

/** Active POS Sales types (config.posInvoice), by name. */
export function posSaleTypes(db: Db): TypeRow[] {
  return db
    .all<TypeRow>(`SELECT id, name, abbreviation, base_type, is_active, config FROM voucher_types WHERE base_type = 'sales' AND is_active = 1 ORDER BY name`)
    .filter((t) => isPosType(parseConfig(t.config)));
}

function ledgerName(db: Db, id: number): string | undefined {
  return db.value<string>('SELECT name FROM ledgers WHERE id = :id', { id });
}

function cashLedgerId(db: Db): number | undefined {
  return db.value<number>(`SELECT id FROM ledgers WHERE reserved_code = 'CASH'`);
}

/** Save POS settings (company.manage). Every reference is checked; the change is audited. */
export function savePosSettings(ctx: CompanyCtx, input: PosSettingsInput): PosSettings {
  const { db } = ctx;
  assertPosEnabled(db);
  const before = getPosSettings(db);
  const next: PosSettings = { ...before };
  for (const [k, val] of Object.entries(input) as Array<[keyof PosSettings, unknown]>) {
    if (val !== undefined) (next as unknown as Record<string, unknown>)[k] = val;
  }
  const issues: Array<{ path: string; message: string }> = [];
  if (next.saleVoucherTypeId !== null) {
    const t = db.get<TypeRow>('SELECT id, name, abbreviation, base_type, is_active, config FROM voucher_types WHERE id = :id', { id: next.saleVoucherTypeId });
    if (!t || t.base_type !== 'sales' || !isPosType(parseConfig(t.config))) issues.push({ path: 'saleVoucherTypeId', message: 'Choose a Sales voucher type used as POS invoice (Masters › Voucher Types › Use as POS invoice).' });
    else if (t.is_active !== 1) issues.push({ path: 'saleVoucherTypeId', message: `Voucher type '${t.name}' is inactive.` });
  }
  if (next.returnVoucherTypeId !== null) {
    const t = db.get<TypeRow>('SELECT id, name, abbreviation, base_type, is_active, config FROM voucher_types WHERE id = :id', { id: next.returnVoucherTypeId });
    if (!t || t.base_type !== 'credit_note') issues.push({ path: 'returnVoucherTypeId', message: 'Choose a Credit Note voucher type for returns.' });
    else if (t.is_active !== 1) issues.push({ path: 'returnVoucherTypeId', message: `Voucher type '${t.name}' is inactive.` });
  }
  if (next.walkInLedgerId !== null) {
    const l = db.get<{ name: string; group_id: number; is_active: number }>('SELECT name, group_id, is_active FROM ledgers WHERE id = :id', { id: next.walkInLedgerId });
    if (!l) issues.push({ path: 'walkInLedgerId', message: 'The selected ledger does not exist.' });
    else if (!classFromChain(groupChain(db, l.group_id)).isCash) issues.push({ path: 'walkInLedgerId', message: `'${l.name}' is not a Cash-in-Hand ledger. A walk-in bill is paid at the counter: choose a cash ledger.` });
    else if (l.is_active !== 1) issues.push({ path: 'walkInLedgerId', message: `Ledger '${l.name}' is inactive.` });
  }
  if (next.priceLevelId !== null && db.value('SELECT 1 FROM price_levels WHERE id = :id', { id: next.priceLevelId }) === undefined) {
    issues.push({ path: 'priceLevelId', message: 'The selected price level does not exist.' });
  }
  if (next.godownId !== null && db.value('SELECT 1 FROM godowns WHERE id = :id', { id: next.godownId }) === undefined) {
    issues.push({ path: 'godownId', message: 'The selected godown does not exist.' });
  }
  if (issues.length > 0) throw validation(issues);
  writeSetting(db, 'pos', next, ctx.clock.now());
  ctx.audit({ action: 'settings', entityType: 'pos_settings', entityLabel: 'POS settings', before, after: next });
  return next;
}

// ───────────────────────────── Tender modes ─────────────────────────────

interface ModeRow {
  id: number;
  name: string;
  kind: PosTenderKind;
  ledger_id: number;
  ledger_name: string;
  sort_order: number;
  is_active: number;
  used: number;
}

const MODE_SQL = `SELECT m.id, m.name, m.kind, m.ledger_id, l.name AS ledger_name, m.sort_order, m.is_active,
                         (SELECT COUNT(DISTINCT p.voucher_id) FROM pos_payments p WHERE p.mode_id = m.id) AS used
                    FROM pos_tender_modes m JOIN ledgers l ON l.id = m.ledger_id`;

function toMode(r: ModeRow): PosTenderMode {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    ledgerId: r.ledger_id,
    ledgerName: r.ledger_name,
    sortOrder: r.sort_order,
    isActive: r.is_active === 1,
    isSystem: r.kind === 'exchange',
    usedCount: r.used,
  };
}

export function listTenderModes(db: Db, opts: { activeOnly?: boolean } = {}): PosTenderMode[] {
  const rows = db.all<ModeRow>(`${MODE_SQL} ${opts.activeOnly ? 'WHERE m.is_active = 1' : ''} ORDER BY m.sort_order, m.name`);
  return rows.map(toMode);
}

export function getTenderMode(db: Db, id: number): PosTenderMode {
  const r = db.get<ModeRow>(`${MODE_SQL} WHERE m.id = :id`, { id });
  if (!r) throw notFound('Tender mode', id);
  return toMode(r);
}

/**
 * Which ledgers a tender may post to: Cash → a Cash-in-Hand ledger; card / UPI / wallet / other → a
 * cash or bank ledger, or a current asset (e.g. "Card settlements receivable") — never a party,
 * stock, tax, income or expense ledger.
 */
export function tenderLedgerIssue(db: Db, kind: PosTenderKind, ledgerId: number): string | null {
  const l = db.get<{ name: string; group_id: number; is_active: number; reserved_code: string | null }>(
    'SELECT name, group_id, is_active, reserved_code FROM ledgers WHERE id = :id',
    { id: ledgerId },
  );
  if (!l) return 'The selected ledger does not exist.';
  if (l.is_active !== 1) return `Ledger '${l.name}' is inactive.`;
  if (l.reserved_code === POS_EXCHANGE_LEDGER_CODE) return `'${l.name}' is kept for exchange credit; choose another ledger.`;
  const chain = groupChain(db, l.group_id);
  const cls = classFromChain(chain);
  if (kind === 'cash') return cls.isCash ? null : `'${l.name}' is not a Cash-in-Hand ledger. Cash tenders go to a cash ledger.`;
  if (cls.isCashOrBank) return null;
  const codes = new Set(chain.map((g) => g.reservedCode));
  if (cls.primaryCode === 'CURRENT_ASSETS' && !codes.has('STOCK_IN_HAND') && !cls.isParty) return null;
  return `'${l.name}' cannot receive POS payments. Choose a bank ledger (UPI / card settled to the bank) or a current-asset clearing ledger such as "Card Settlements Receivable".`;
}

export function saveTenderMode(ctx: CompanyCtx, input: PosTenderModeSaveInput): PosTenderMode {
  const { db } = ctx;
  assertPosEnabled(db);
  const now = ctx.clock.now().toISOString();
  const existing = input.id !== undefined ? getTenderMode(db, input.id) : null;
  const name = input.name.trim();
  if (existing?.isSystem) {
    // The exchange-credit mode: only its name, order and active flag may change.
    if (input.kind !== 'exchange' || input.ledgerId !== existing.ledgerId) {
      throw validation([{ path: 'kind', message: 'The exchange-credit mode keeps its kind and ledger; you may rename, reorder or deactivate it.' }]);
    }
  } else {
    if (!(POS_USER_TENDER_KINDS as readonly string[]).includes(input.kind)) {
      throw validation([{ path: 'kind', message: 'Exchange credit is a system mode; choose Cash, Card, UPI, Wallet or Other.' }]);
    }
    const issue = tenderLedgerIssue(db, input.kind, input.ledgerId);
    if (issue) throw validation([{ path: 'ledgerId', message: issue }]);
    if (existing && existing.usedCount > 0 && (existing.kind !== input.kind || existing.ledgerId !== input.ledgerId)) {
      throw validation([
        {
          path: existing.ledgerId !== input.ledgerId ? 'ledgerId' : 'kind',
          message: `This mode is used on ${existing.usedCount} bill(s); its kind and ledger cannot change. Create a new mode and deactivate this one.`,
        },
      ]);
    }
  }
  const clash = db.value<number>('SELECT id FROM pos_tender_modes WHERE name = :name COLLATE NOCASE AND id IS NOT :id', { name, id: existing?.id ?? null });
  if (clash !== undefined) throw validation([{ path: 'name', message: `A tender mode named '${name}' already exists.` }]);
  const sortOrder = input.sortOrder ?? existing?.sortOrder ?? (db.value<number>(`SELECT COALESCE(MAX(sort_order), 0) + 10 FROM pos_tender_modes WHERE kind <> 'exchange'`) ?? 10);
  const isActive = input.isActive ?? existing?.isActive ?? true;
  let id: number;
  if (existing) {
    id = existing.id;
    db.run('UPDATE pos_tender_modes SET name = :name, kind = :kind, ledger_id = :ledger, sort_order = :sort, is_active = :active, updated_at = :now WHERE id = :id', {
      id,
      name,
      kind: existing.isSystem ? 'exchange' : input.kind,
      ledger: input.ledgerId,
      sort: sortOrder,
      active: isActive ? 1 : 0,
      now,
    });
  } else {
    id = db.run(
      `INSERT INTO pos_tender_modes (guid, name, kind, ledger_id, sort_order, is_active, created_at, updated_at)
       VALUES (:guid, :name, :kind, :ledger, :sort, :active, :now, :now)`,
      { guid: randomUUID(), name, kind: input.kind, ledger: input.ledgerId, sort: sortOrder, active: isActive ? 1 : 0, now },
    ).lastInsertRowid;
  }
  const after = getTenderMode(db, id);
  ctx.audit({
    action: existing ? 'alter' : 'create',
    entityType: 'pos_tender_mode',
    entityId: id,
    entityLabel: after.name,
    before: existing ? { name: existing.name, kind: existing.kind, ledger: existing.ledgerName, sortOrder: existing.sortOrder, active: existing.isActive } : undefined,
    after: { name: after.name, kind: after.kind, ledger: after.ledgerName, sortOrder: after.sortOrder, active: after.isActive },
  });
  return after;
}

export function deleteTenderMode(ctx: CompanyCtx, id: number): { id: number } {
  const { db } = ctx;
  assertPosEnabled(db);
  const m = getTenderMode(db, id);
  if (m.isSystem) throw rule('The exchange-credit mode is a system mode; deactivate it instead of deleting it.');
  if (m.usedCount > 0) throw rule(`'${m.name}' is used on ${m.usedCount} bill(s) and cannot be deleted. Deactivate it instead.`);
  db.run('DELETE FROM pos_tender_modes WHERE id = :id', { id });
  ctx.audit({ action: 'delete', entityType: 'pos_tender_mode', entityId: id, entityLabel: m.name, before: { name: m.name, kind: m.kind, ledger: m.ledgerName } });
  return { id };
}

// ───────────────────────────── Setup (F11 › POS invoicing) ─────────────────────────────

/** The system exchange-credit ledger (Current Liabilities), created when missing. Audited. */
export function ensureExchangeLedger(db: Db, ts: string, audit?: Audit): number {
  const existing = db.value<number>('SELECT id FROM ledgers WHERE reserved_code = :code', { code: POS_EXCHANGE_LEDGER_CODE });
  if (existing !== undefined) return existing;
  const groupId = db.value<number>('SELECT id FROM groups WHERE reserved_code = :g', { g: POS_EXCHANGE_GROUP });
  if (groupId === undefined) throw new AppError('INTERNAL', `Group ${POS_EXCHANGE_GROUP} is missing`);
  let name = POS_EXCHANGE_LEDGER_NAME;
  for (let i = 2; db.value('SELECT 1 FROM ledgers WHERE name = :name', { name }) !== undefined && i < 1000; i++) name = `${POS_EXCHANGE_LEDGER_NAME} (${i})`;
  const guid = randomUUID();
  const id = db.run(
    `INSERT INTO ledgers (guid, name, group_id, reserved_code, is_predefined, gst_applicable, created_at, updated_at)
     VALUES (:guid, :name, :groupId, :code, 1, 'not_applicable', :ts, :ts)`,
    { guid, name, groupId, code: POS_EXCHANGE_LEDGER_CODE, ts },
  ).lastInsertRowid;
  audit?.({ action: 'create', entityType: 'ledger', entityId: id, entityGuid: guid, entityLabel: name, after: { name, group: POS_EXCHANGE_GROUP, reservedCode: POS_EXCHANGE_LEDGER_CODE, createdBy: 'pos' } });
  return id;
}

function uniqueTypeName(db: Db, base: string): string {
  let name = base;
  for (let n = 2; db.value('SELECT 1 FROM voucher_types WHERE name = :name COLLATE NOCASE OR alias = :name COLLATE NOCASE', { name }) !== undefined && n < 50; n++) name = `${base} ${n}`;
  return name;
}

function createType(db: Db, ts: string, spec: { base: 'sales' | 'credit_note'; name: string; abbr: string; prefix: string; config: Record<string, unknown> }, audit?: Audit): number {
  const parent = db.get<{ id: number }>(`SELECT id FROM voucher_types WHERE base_type = :b AND is_predefined = 1 ORDER BY id LIMIT 1`, { b: spec.base });
  const name = uniqueTypeName(db, spec.name);
  const guid = randomUUID();
  const id = db.run(
    `INSERT INTO voucher_types (guid, name, abbreviation, base_type, parent_id, is_predefined, is_active, numbering_method,
                                numbering_prefix, numbering_restart, config, created_at, updated_at)
     VALUES (:guid, :name, :abbr, :base, :parent, 0, 1, 'automatic', :prefix, 'yearly', :config, :ts, :ts)`,
    { guid, name, abbr: spec.abbr, base: spec.base, parent: parent?.id ?? null, prefix: spec.prefix, config: JSON.stringify(spec.config), ts },
  ).lastInsertRowid;
  audit?.({ action: 'create', entityType: 'voucher_type', entityId: id, entityGuid: guid, entityLabel: name, after: { name, baseType: spec.base, prefix: spec.prefix, config: spec.config, createdBy: 'pos' } });
  return id;
}

/**
 * Everything the counter needs, created once when POS invoicing is turned on (F11, or a new company
 * created with it): the "POS Sales" voucher type (Sales, POS invoice class, own series POS/1, thermal
 * receipt with MRP), the "POS Return" Credit Note type (series PR/1), the Cash tender (reserved Cash
 * ledger), the system exchange-credit ledger and mode. Idempotent; existing types are reused (a renamed
 * or deactivated POS type still counts). Returns the ids it created.
 */
export function ensurePosSetup(db: Db, ts: string, audit?: Audit): { createdTypeIds: number[] } {
  const created: number[] = [];
  const cash = cashLedgerId(db);
  const settings = getPosSettings(db);
  const anyPosType = db
    .all<{ id: number; config: string }>(`SELECT id, config FROM voucher_types WHERE base_type = 'sales'`)
    .some((t) => isPosType(parseConfig(t.config)));
  if (!anyPosType) {
    const salesLedger = db.value<number>(`SELECT id FROM ledgers WHERE reserved_code = 'SALES'`);
    created.push(
      createType(
        db,
        ts,
        {
          base: 'sales',
          name: 'POS Sales',
          abbr: 'POS',
          prefix: 'POS/',
          config: {
            posInvoice: true,
            invoiceMode: 'item',
            printTemplate: 'compact',
            showMrp: true,
            ...(cash !== undefined ? { defaultPartyLedgerId: cash } : {}),
            ...(salesLedger !== undefined ? { defaultLedgerId: salesLedger } : {}),
          },
        },
        audit,
      ),
    );
  }
  let returnTypeId = settings.returnVoucherTypeId;
  if (returnTypeId !== null && db.value(`SELECT 1 FROM voucher_types WHERE id = :id AND base_type = 'credit_note'`, { id: returnTypeId }) === undefined) returnTypeId = null;
  if (returnTypeId === null) {
    const salesLedger = db.value<number>(`SELECT id FROM ledgers WHERE reserved_code = 'SALES'`);
    returnTypeId = createType(
      db,
      ts,
      {
        base: 'credit_note',
        name: 'POS Return',
        abbr: 'POS Ret',
        prefix: 'PR/',
        config: { invoiceMode: 'item', printTemplate: 'compact', ...(salesLedger !== undefined ? { defaultLedgerId: salesLedger } : {}) },
      },
      audit,
    );
    created.push(returnTypeId);
  }
  if (cash !== undefined && db.value(`SELECT 1 FROM pos_tender_modes WHERE kind = 'cash'`) === undefined) {
    db.run(
      `INSERT INTO pos_tender_modes (guid, name, kind, ledger_id, sort_order, is_active, created_at, updated_at)
       VALUES (:guid, :name, 'cash', :ledger, 10, 1, :ts, :ts)`,
      { guid: randomUUID(), name: db.value('SELECT 1 FROM pos_tender_modes WHERE name = :n', { n: 'Cash' }) === undefined ? 'Cash' : 'Cash (counter)', ledger: cash, ts },
    );
  }
  if (db.value(`SELECT 1 FROM pos_tender_modes WHERE kind = 'exchange'`) === undefined) {
    const ledger = ensureExchangeLedger(db, ts, audit);
    db.run(
      `INSERT INTO pos_tender_modes (guid, name, kind, ledger_id, sort_order, is_active, created_at, updated_at)
       VALUES (:guid, :name, 'exchange', :ledger, 1000, 1, :ts, :ts)`,
      { guid: randomUUID(), name: db.value('SELECT 1 FROM pos_tender_modes WHERE name = :n', { n: 'Exchange credit' }) === undefined ? 'Exchange credit' : 'Exchange credit (system)', ledger, ts },
    );
  }
  if (returnTypeId !== settings.returnVoucherTypeId) writeSetting(db, 'pos', { ...settings, returnVoucherTypeId: returnTypeId }, new Date(ts));
  return { createdTypeIds: created };
}

// ───────────────────────────── Context ─────────────────────────────

/** Walk-in party: the configured cash ledger, else the reserved Cash ledger. */
export function walkInLedgerId(db: Db, settings: PosSettings = getPosSettings(db)): number | null {
  if (settings.walkInLedgerId !== null && db.value('SELECT 1 FROM ledgers WHERE id = :id', { id: settings.walkInLedgerId }) !== undefined) return settings.walkInLedgerId;
  return cashLedgerId(db) ?? null;
}

export function resolvedReturnTypeId(db: Db, settings: PosSettings = getPosSettings(db)): number | null {
  if (settings.returnVoucherTypeId !== null) {
    const ok = db.value(`SELECT 1 FROM voucher_types WHERE id = :id AND base_type = 'credit_note' AND is_active = 1`, { id: settings.returnVoucherTypeId });
    if (ok !== undefined) return settings.returnVoucherTypeId;
  }
  return db.value<number>(`SELECT id FROM voucher_types WHERE base_type = 'credit_note' AND is_predefined = 1 AND is_active = 1 ORDER BY id LIMIT 1`) ?? null;
}

export function posContext(ctx: CompanyCtx): PosContext {
  const { db } = ctx;
  const features = getFeatures(db);
  const settings = getPosSettings(db);
  const saleTypes = posSaleTypes(db).map((t) => ({ id: t.id, name: t.name, abbreviation: t.abbreviation }));
  const returnTypes = db.all<{ id: number; name: string }>(`SELECT id, name FROM voucher_types WHERE base_type = 'credit_note' AND is_active = 1 ORDER BY is_predefined DESC, name`);
  const saleId = settings.saleVoucherTypeId !== null && saleTypes.some((t) => t.id === settings.saleVoucherTypeId) ? settings.saleVoucherTypeId : (saleTypes[0]?.id ?? null);
  const walkId = walkInLedgerId(db, settings);
  const named = (table: 'price_levels' | 'godowns', id: number | null) => {
    if (id === null) return null;
    const name = db.value<string>(`SELECT name FROM ${table} WHERE id = :id`, { id });
    return name === undefined ? null : { id, name };
  };
  const company = db.get<{ state_code: string | null; gst_registration_type: string }>('SELECT state_code, gst_registration_type FROM company WHERE id = 1');
  const perms = ctx.session.permissions;
  const has = (p: Parameters<typeof perms.has>[0]): boolean => ctx.session.isOwner || perms.has(p);
  return {
    enabled: features.pos,
    settings,
    saleTypes,
    returnTypes,
    saleVoucherTypeId: saleId,
    returnVoucherTypeId: resolvedReturnTypeId(db, settings),
    walkIn: walkId !== null ? { id: walkId, name: ledgerName(db, walkId) ?? 'Cash' } : null,
    tenderModes: listTenderModes(db, { activeOnly: true }),
    priceLevel: features.priceLevels ? named('price_levels', settings.priceLevelId) : null,
    godown: features.multipleGodowns ? named('godowns', settings.godownId) : null,
    companyStateCode: company?.state_code ?? null,
    gstEnabled: features.gst && company?.gst_registration_type !== 'unregistered',
    can: {
      bill: has('vouchers.create'),
      alter: has('vouchers.alter'),
      createCustomer: has('masters.create'),
      manage: has('company.manage'),
      backdate: has('vouchers.backdate'),
    },
  };
}
