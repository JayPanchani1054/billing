import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_UNITS,
  MAIN_GODOWN_NAME,
  PERMISSIONS,
  PREDEFINED_GROUPS,
  PREDEFINED_LEDGERS,
  PREDEFINED_VOUCHER_TYPES,
} from '../../shared/constants.ts';
import { DEFAULT_CONFIG } from '../../shared/settings.ts';
import type { CreateCompanyInput } from '../../shared/types/app.ts';
import { AppError } from '../lib/errors.ts';
import { makeGstin } from '../testing/fixtures.ts';
import { Db } from './db.ts';
import { migrate } from './migrate.ts';
import { ensureGstLedgers, seedCompany } from './seed.ts';

const NOW = new Date('2026-04-15T04:30:00.000Z');

function freshDb(): Db {
  const db = new Db(':memory:');
  migrate(db);
  return db;
}

function input(over: Partial<CreateCompanyInput> = {}): CreateCompanyInput {
  return {
    name: 'Sharma Traders',
    stateCode: '27',
    gstRegistrationType: 'regular',
    gstin: makeGstin('27'),
    booksFrom: '2026-04-01',
    ...over,
  };
}

const settings = (db: Db, key: string): unknown => JSON.parse(db.value<string>('SELECT value FROM settings WHERE key = :key', { key }) ?? 'null');

describe('seedCompany', () => {
  it('creates the company row with normalised identity', () => {
    const db = freshDb();
    const r = seedCompany(db, input({ gstin: ` ${makeGstin('27').toLowerCase()} `, mailingName: '' }), { now: NOW });
    const row = db.get<Record<string, unknown>>('SELECT * FROM company');
    assert.ok(row);
    assert.equal(row.id, 1);
    assert.equal(row.guid, r.companyGuid);
    assert.match(String(row.guid), /^[0-9a-f-]{36}$/);
    assert.equal(row.gstin, makeGstin('27'));
    assert.equal(row.pan, 'AAPFU0939F', 'PAN derived from GSTIN');
    assert.equal(row.mailing_name, 'Sharma Traders', 'mailing name defaults to name');
    assert.equal(row.country, 'India');
    assert.equal(row.fy_start_month, 4);
    assert.equal(row.base_currency, 'INR');
    assert.equal(row.created_at, NOW.toISOString());
    db.close();
  });

  it('seeds the 28 predefined groups with correct parents, natures and gross-profit flags', () => {
    const db = freshDb();
    const r = seedCompany(db, input(), { now: NOW });
    const rows = db.all<{ id: number; name: string; reserved_code: string; parent_id: number | null; nature: string; affects_gross_profit: number; is_predefined: number; sort_order: number }>(
      'SELECT * FROM groups ORDER BY sort_order',
    );
    assert.equal(rows.length, 28);
    const byId = new Map(rows.map((g) => [g.id, g]));
    for (const g of PREDEFINED_GROUPS) {
      const row = rows.find((x) => x.reserved_code === g.code);
      assert.ok(row, g.code);
      assert.equal(row.name, g.name);
      assert.equal(row.nature, g.nature, `${g.code} nature`);
      assert.equal(row.affects_gross_profit, g.affectsGrossProfit ? 1 : 0, `${g.code} gross profit`);
      assert.equal(row.is_predefined, 1);
      assert.equal(r.groupIds[g.code], row.id);
      if (g.parent) assert.equal(byId.get(row.parent_id as number)?.reserved_code, g.parent, `${g.code} parent`);
      else assert.equal(row.parent_id, null);
    }
    assert.equal(rows.filter((g) => g.parent_id === null).length, 15, '15 primary groups');
    assert.deepEqual(rows.map((g) => g.reserved_code), PREDEFINED_GROUPS.map((g) => g.code), 'sort order follows constants');
    db.close();
  });

  it('creates GST ledgers with tax metadata when GST is on', () => {
    const db = freshDb();
    const r = seedCompany(db, input(), { now: NOW });
    const ledgers = db.all<{ name: string; reserved_code: string; tax_type: string | null; gst_duty_head: string | null; gst_tax_direction: string | null; is_predefined: number; group_id: number }>(
      'SELECT * FROM ledgers',
    );
    assert.equal(ledgers.length, PREDEFINED_LEDGERS.length);
    for (const l of PREDEFINED_LEDGERS) {
      const row = ledgers.find((x) => x.reserved_code === l.code);
      assert.ok(row, l.code);
      assert.equal(row.is_predefined, 1);
      assert.equal(row.group_id, r.groupIds[l.group]);
      if (l.gstOnly) {
        assert.equal(row.tax_type, 'GST');
        assert.equal(row.gst_duty_head, l.dutyHead);
        assert.equal(row.gst_tax_direction, l.direction);
      } else {
        assert.equal(row.tax_type, null);
      }
    }
    const sales = db.get<{ gst_applicable: string; gst_taxability: string; inventory_values_affected: number }>(
      `SELECT * FROM ledgers WHERE reserved_code = 'SALES'`,
    );
    assert.equal(sales?.gst_applicable, 'applicable');
    assert.equal(sales?.gst_taxability, 'taxable');
    assert.equal(sales?.inventory_values_affected, 1);
    assert.equal(r.features.gst, true);
    db.close();
  });

  it('creates no GST ledgers and forces gst=false for an unregistered business', () => {
    const db = freshDb();
    const r = seedCompany(db, input({ gstRegistrationType: 'unregistered', gstin: makeGstin('27'), features: { gst: true, einvoice: true } }), {
      now: NOW,
    });
    assert.equal(r.features.gst, false);
    assert.equal(r.features.einvoice, false);
    assert.equal(db.value('SELECT gstin FROM company'), null, 'GSTIN ignored when unregistered');
    assert.equal(db.value(`SELECT COUNT(*) FROM ledgers WHERE tax_type = 'GST'`), 0);
    assert.equal(db.value('SELECT COUNT(*) FROM ledgers'), PREDEFINED_LEDGERS.filter((l) => !l.gstOnly).length);
    assert.equal((settings(db, 'features') as { gst: boolean }).gst, false);
    assert.equal(r.ledgerIds.OUTPUT_IGST, undefined);
    db.close();
  });

  it('creates GST ledgers off when the feature is switched off for a registered business', () => {
    const db = freshDb();
    seedCompany(db, input({ features: { gst: false } }), { now: NOW });
    assert.equal(db.value(`SELECT COUNT(*) FROM ledgers WHERE tax_type = 'GST'`), 0);
    db.close();
  });

  it('creates every predefined voucher type with automatic yearly numbering and default ledgers', () => {
    const db = freshDb();
    const r = seedCompany(db, input(), { now: NOW });
    const vts = db.all<{ id: number; name: string; base_type: string; numbering_method: string; numbering_restart: string; config: string; is_predefined: number }>(
      'SELECT * FROM voucher_types ORDER BY id',
    );
    assert.equal(vts.length, PREDEFINED_VOUCHER_TYPES.length);
    assert.deepEqual(vts.map((x) => x.name), PREDEFINED_VOUCHER_TYPES.map((x) => x.name));
    for (const vt of vts) {
      assert.equal(vt.numbering_method, 'automatic');
      assert.equal(vt.numbering_restart, 'yearly');
      assert.equal(vt.is_predefined, 1);
      assert.equal(r.voucherTypeIds[vt.base_type as keyof typeof r.voucherTypeIds], vt.id);
    }
    const cfg = (base: string) => JSON.parse(vts.find((x) => x.base_type === base)?.config ?? '{}') as { defaultLedgerId?: number };
    assert.equal(cfg('sales').defaultLedgerId, r.ledgerIds.SALES);
    assert.equal(cfg('credit_note').defaultLedgerId, r.ledgerIds.SALES);
    assert.equal(cfg('purchase').defaultLedgerId, r.ledgerIds.PURCHASE);
    assert.equal(cfg('debit_note').defaultLedgerId, r.ledgerIds.PURCHASE);
    assert.deepEqual(cfg('payment'), {});
    db.close();
  });

  it('seeds units, godown, currency, cost category, settings and roles', () => {
    const db = freshDb();
    const r = seedCompany(db, input(), { now: NOW });
    assert.equal(db.value('SELECT COUNT(*) FROM units'), DEFAULT_UNITS.length);
    assert.equal(db.value(`SELECT uqc FROM units WHERE symbol = 'Kg'`), 'KGS');
    assert.equal(db.value(`SELECT decimal_places FROM units WHERE symbol = 'Kg'`), 3);
    assert.deepEqual(db.get('SELECT name, is_predefined FROM godowns'), { name: MAIN_GODOWN_NAME, is_predefined: 1 });
    assert.equal(r.mainGodownId, db.value('SELECT id FROM godowns'));
    assert.deepEqual(db.get('SELECT symbol, iso_code, is_base FROM currencies'), { symbol: '₹', iso_code: 'INR', is_base: 1 });
    assert.equal(db.value('SELECT name FROM cost_categories'), 'Primary Cost Category');
    assert.deepEqual(settings(db, 'config'), DEFAULT_CONFIG);
    const roles = db.all<{ name: string; permissions: string; is_system: number }>('SELECT * FROM roles ORDER BY id');
    assert.deepEqual(roles.map((x) => x.name), ['Owner', 'Accountant', 'Data Entry', 'Auditor']);
    assert.deepEqual(JSON.parse(roles[0].permissions), [...PERMISSIONS], "'all' expands to every permission");
    assert.ok(!JSON.parse(roles[1].permissions).includes('security.manage'));
    assert.ok(roles.every((x) => x.is_system === 1));
    assert.equal(db.value('SELECT COUNT(*) FROM users'), 0);
    assert.equal((settings(db, 'features') as { security: boolean }).security, false);
    db.close();
  });

  it('creates the Owner user and turns security on when an owner is given', () => {
    const db = freshDb();
    const r = seedCompany(db, input({ owner: { username: 'admin', password: 'Secret123' } }), { now: NOW, ownerPasswordHash: 'scrypt$hash' });
    const u = db.get<{ username: string; display_name: string; password_hash: string; role_id: number }>('SELECT * FROM users');
    assert.equal(u?.username, 'admin');
    assert.equal(u?.display_name, 'admin');
    assert.equal(u?.password_hash, 'scrypt$hash');
    assert.equal(u?.role_id, r.roleIds.Owner);
    assert.equal(r.ownerUserId, 1);
    assert.equal(r.features.security, true);
    db.close();
  });

  it('requires the owner password hash and refuses to seed twice', () => {
    const db = freshDb();
    assert.throws(() => seedCompany(db, input({ owner: { username: 'admin', password: 'Secret123' } }), { now: NOW }), AppError);
    assert.equal(db.value('SELECT COUNT(*) FROM company'), 0, 'nothing written');
    seedCompany(db, input(), { now: NOW });
    assert.throws(() => seedCompany(db, input(), { now: NOW }), (e: unknown) => e instanceof AppError && e.code === 'CONFLICT');
    db.close();
  });

  it('validates GSTIN against the state and PAN', () => {
    const db = freshDb();
    const bad = (over: Partial<CreateCompanyInput>, path: string) =>
      assert.throws(
        () => seedCompany(db, input(over), { now: NOW }),
        (e: unknown) =>
          e instanceof AppError && e.code === 'VALIDATION' && (e.details as Array<{ path: string }>).some((i) => i.path === path),
      );
    bad({ gstin: makeGstin('29') }, 'gstin'); // state mismatch
    bad({ gstin: '27AAPFU0939F1ZX' }, 'gstin'); // bad check character
    bad({ gstin: undefined }, 'gstin'); // required for regular
    bad({ pan: 'ABCDE1234F' }, 'pan'); // PAN differs from GSTIN
    bad({ pincode: '12345' }, 'pincode');
    assert.equal(db.value('SELECT COUNT(*) FROM company'), 0);
    db.close();
  });
});

describe('ensureGstLedgers', () => {
  it('is idempotent and fills in missing GST ledgers', () => {
    const db = freshDb();
    const r = seedCompany(db, input({ features: { gst: false } }), { now: NOW });
    const first = ensureGstLedgers(db, NOW.toISOString());
    assert.equal(Object.keys(first).length, 12);
    const second = ensureGstLedgers(db, NOW.toISOString());
    assert.deepEqual(second, first);
    assert.equal(db.value(`SELECT COUNT(*) FROM ledgers WHERE tax_type = 'GST'`), 12);
    assert.equal(db.value(`SELECT group_id FROM ledgers WHERE reserved_code = 'OUTPUT_IGST'`), r.groupIds.DUTIES_TAXES);
    db.close();
  });

  it('adopts a same-named user ledger under Duties & Taxes and renames around other clashes', () => {
    const db = freshDb();
    const r = seedCompany(db, input({ features: { gst: false } }), { now: NOW });
    const ts = NOW.toISOString();
    const add = (name: string, groupId: number) =>
      db.run(`INSERT INTO ledgers (guid, name, group_id, created_at, updated_at) VALUES (:g, :name, :groupId, :ts, :ts)`, {
        g: crypto.randomUUID(),
        name,
        groupId,
        ts,
      }).lastInsertRowid;
    const adopted = add('Output IGST', r.groupIds.DUTIES_TAXES);
    add('Input IGST', r.groupIds.INDIRECT_EXPENSES);
    const ids = ensureGstLedgers(db, ts);
    assert.equal(ids.OUTPUT_IGST, adopted);
    assert.equal(db.value('SELECT gst_duty_head FROM ledgers WHERE id = :id', { id: adopted }), 'IGST');
    assert.equal(db.value('SELECT name FROM ledgers WHERE id = :id', { id: ids.INPUT_IGST }), 'Input IGST (GST)');
    db.close();
  });
});
