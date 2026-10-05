/**
 * GSTR-1 JSON (GSTN offline-tool format). gstr1.golden.json is the reviewed output for the April-2026
 * dataset (testkit.ts); every amount in it is the hand-worked figure of gstr1.test.ts divided by 100.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadCompany } from './docs.ts';
import { computeGstr1 } from './gstr1.ts';
import { buildGstr1Json, GSTR1_JSON_VERSION } from './gstr1-json.ts';
import { resolvePeriod } from './period.ts';
import { aprilDataset, insertDoc, setupParties, type Dataset } from './testkit.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

type J = Record<string, unknown>;

describe('GSTR-1 JSON', () => {
  let ds: Dataset;
  let file: ReturnType<typeof buildGstr1Json>;
  let json: J;
  before(() => {
    ds = aprilDataset();
    file = buildGstr1Json(computeGstr1(ds.t.db, loadCompany(ds.t.db), resolvePeriod({ period: '042026' }), ds.t.today));
    json = JSON.parse(file.json) as J;
  });
  after(() => ds.t.close());

  it('matches the golden snapshot byte for byte (deterministic ordering)', () => {
    const golden = fs.readFileSync(path.join(here, 'gstr1.golden.json'), 'utf8');
    assert.equal(file.json, JSON.stringify(JSON.parse(golden)));
    assert.equal(file.fileName, `GSTR1_${String(json.gstin)}_042026.json`);
    assert.deepEqual(file.warnings, []);
  });

  it('header, section keys and omission of empty sections', () => {
    assert.deepEqual(Object.keys(json), ['gstin', 'fp', 'version', 'hash', 'b2b', 'b2cl', 'b2cs', 'exp', 'cdnr', 'cdnur', 'nil', 'hsn', 'doc_issue']);
    assert.equal(json.fp, '042026');
    assert.equal(json.version, GSTR1_JSON_VERSION);
    assert.equal(json.hash, 'hash');
  });

  it('b2b: invoices grouped by ctin, items per rate, intra camt/samt, inter iamt, RCM and SEZ/DE types', () => {
    const b2b = json.b2b as Array<{ ctin: string; inv: J[] }>;
    assert.deepEqual(
      b2b.map((g) => [g.ctin.slice(0, 2), g.inv.map((i) => `${String(i.inum)}:${String(i.inv_typ)}:${String(i.rchrg)}`)]),
      [
        ['08', ['S-14:R:N']],
        ['24', ['S-10:SEWOP:N', 'S-11:SEWP:N']],
        ['27', ['S-1:R:N', 'S-3:R:Y']],
        ['29', ['S-2:R:N']],
        ['33', ['S-12:DE:N']],
      ],
    );
    const s1 = b2b[2].inv[0];
    assert.deepEqual(s1, {
      inum: 'S-1',
      idt: '02-04-2026',
      val: 1705,
      pos: '27',
      rchrg: 'N',
      inv_typ: 'R',
      itms: [
        { num: 1, itm_det: { txval: 500, rt: 5, camt: 12.5, samt: 12.5, csamt: 0 } },
        { num: 2, itm_det: { txval: 1000, rt: 18, camt: 90, samt: 90, csamt: 0 } },
      ],
    });
    // S-2: the exempt rice line is not an item (it is in nil); value is the whole invoice.
    assert.deepEqual(b2b[3].inv[0].itms, [{ num: 1, itm_det: { txval: 2000, rt: 18, iamt: 360, csamt: 0 } }]);
    assert.equal(b2b[3].inv[0].val, 2660);
  });

  it('exports carry shipping bill details only when present; cdnur carries pos only for B2CL', () => {
    const exp = json.exp as Array<{ exp_typ: string; inv: J[] }>;
    assert.deepEqual(exp.map((e) => e.exp_typ), ['WPAY', 'WOPAY']);
    assert.deepEqual(exp[0].inv[0], { inum: 'S-8', idt: '09-04-2026', val: 5900, sbpcode: 'INNSA1', sbnum: '1234567', sbdt: '10-04-2026', itms: [{ txval: 5000, rt: 18, iamt: 900, csamt: 0 }] });
    assert.deepEqual(exp[1].inv[0], { inum: 'S-9', idt: '10-04-2026', val: 10000, itms: [{ txval: 10000, rt: 18, iamt: 0, csamt: 0 }] });
    assert.deepEqual(json.cdnur, [
      { typ: 'B2CL', ntty: 'C', nt_num: 'CN-2', nt_dt: '21-04-2026', val: 11800, pos: '07', itms: [{ num: 1, itm_det: { txval: 10000, rt: 18, iamt: 1800, csamt: 0 } }] },
    ]);
    assert.deepEqual((json.cdnr as Array<{ nt: J[] }>)[0].nt[0], {
      ntty: 'C',
      nt_num: 'CN-1',
      nt_dt: '20-04-2026',
      val: 590,
      pos: '29',
      rchrg: 'N',
      inv_typ: 'R',
      itms: [{ num: 1, itm_det: { txval: 500, rt: 18, iamt: 90, csamt: 0 } }],
    });
  });

  it('b2cs rows, nil rows, hsn split and doc_issue', () => {
    assert.deepEqual(json.b2cs, [
      { sply_ty: 'INTER', pos: '07', typ: 'OE', rt: 18, txval: 84745.76, iamt: 15254.24, csamt: 0 },
      { sply_ty: 'INTRA', pos: '27', typ: 'OE', rt: 5, txval: 100, camt: 2.5, samt: 2.5, csamt: 0 },
      { sply_ty: 'INTRA', pos: '27', typ: 'OE', rt: 18, txval: 400, camt: 36, samt: 36, csamt: 0 },
    ]);
    assert.deepEqual(json.nil, {
      inv: [
        { sply_ty: 'INTRB2B', expt_amt: 300, nil_amt: 0, ngsup_amt: 0 },
        { sply_ty: 'INTRAB2C', expt_amt: 0, nil_amt: 500, ngsup_amt: 700 },
      ],
    });
    const hsn = json.hsn as { hsn_b2b: J[]; hsn_b2c: J[] };
    assert.equal(hsn.hsn_b2b.length, 5);
    assert.deepEqual(hsn.hsn_b2c[4], { num: 5, hsn_sc: '8471', desc: 'Laptop', uqc: 'NOS', qty: 21, rt: 18, txval: 164895.76, iamt: 29609.24, camt: 36, samt: 36, csamt: 0 });
    assert.deepEqual(json.doc_issue, {
      doc_det: [
        { doc_num: 1, docs: [{ num: 1, from: 'S-1', to: 'S-15', totnum: 15, cancel: 1, net_issue: 14 }] },
        { doc_num: 5, docs: [{ num: 1, from: 'CN-1', to: 'CN-3', totnum: 3, cancel: 0, net_issue: 3 }] },
      ],
    });
  });

  it('a quarter file uses the last month as fp; an empty period has only the header', () => {
    const { t, P } = setupParties({ today: '2026-07-20' });
    insertDoc(t, { type: 'sales', number: 'Q1', date: '2026-05-10', party: P.acme, nature: 'b2b', pos: '27', lines: [{ hsn: '8471', rate: 18, taxable: 12345, cgst: 1111, sgst: 1111 }] });
    const q = buildGstr1Json(computeGstr1(t.db, loadCompany(t.db), resolvePeriod({ period: '2026-27-Q1' }), t.today));
    const qj = JSON.parse(q.json) as J;
    assert.equal(qj.fp, '062026');
    assert.equal(q.fileName.endsWith('_062026.json'), true);
    // 123.45 taxable, 11.11 each — exact two-decimal numbers
    assert.deepEqual(((qj.b2b as Array<{ inv: J[] }>)[0].inv[0].itms as J[])[0], { num: 1, itm_det: { txval: 123.45, rt: 18, camt: 11.11, samt: 11.11, csamt: 0 } });
    const empty = JSON.parse(buildGstr1Json(computeGstr1(t.db, loadCompany(t.db), resolvePeriod({ period: '072026' }), t.today)).json) as J;
    assert.deepEqual(Object.keys(empty), ['gstin', 'fp', 'version', 'hash']);
    t.close();
  });
});
