import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isFromWorker, isStandaloneBytes, isToWorker, prepareTransfer, serializeError } from './core-protocol.ts';

describe('prepareTransfer', () => {
  it('owned: transfers a standalone array as is (zero copy) and detaches the sender view', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const input = { file: { name: 'a.csv', bytes }, n: 1 };
    const p = prepareTransfer(input, true);
    assert.equal(p.value, input, 'nothing to copy → same object');
    assert.deepEqual(p.transfer, [bytes.buffer]);
    const received = structuredClone(p.value, { transfer: p.transfer }) as typeof input;
    assert.deepEqual([...received.file.bytes], [1, 2, 3]);
    assert.equal(bytes.byteLength, 0, 'moved, not copied');
  });

  it('owned: a view into a larger buffer is copied, so only its own bytes cross', () => {
    const big = new Uint8Array(8192).fill(7);
    const view = big.subarray(10, 14);
    assert.equal(isStandaloneBytes(view), false);
    const input = { bytes: view };
    const p = prepareTransfer(input, true);
    const out = p.value as { bytes: Uint8Array };
    assert.notEqual(p.value, input, 'container copied on write');
    assert.equal(input.bytes, view, 'caller value untouched');
    assert.equal(out.bytes.buffer.byteLength, 4);
    assert.equal(p.transfer[0], out.bytes.buffer);
    assert.equal(big.byteLength, 8192, 'the big buffer is not detached');
  });

  it('owned: the same buffer referenced twice is transferred once', () => {
    const bytes = new Uint8Array([9]);
    const p = prepareTransfer([bytes, bytes], true);
    assert.equal(p.transfer.length, 1);
  });

  it('not owned (worker → main): copies every array, never detaches or mutates the original', () => {
    const cached = new Uint8Array([4, 5, 6]);
    const result = { ok: true, data: { rows: [{ id: 1 }], file: cached, nested: [[cached]] } };
    const p = prepareTransfer(result, false);
    assert.equal(p.transfer.length, 2, 'one fresh buffer per occurrence');
    const out = p.value as typeof result;
    assert.notEqual(out.data.file, cached);
    assert.equal(out.data.rows, result.data.rows, 'untouched subtrees are shared, not rebuilt');
    assert.equal(result.data.file, cached, 'original object not mutated');
    structuredClone(p.value, { transfer: p.transfer });
    assert.equal(cached.byteLength, 3, 'the original buffer is still usable after the transfer');
  });

  it('passes primitives, null-prototype objects, Dates and class instances through', () => {
    assert.deepEqual(prepareTransfer(42, false), { value: 42, transfer: [] });
    const obj = Object.assign(Object.create(null) as Record<string, unknown>, { a: new Uint8Array([1]) });
    const p = prepareTransfer(obj, false);
    assert.equal(p.transfer.length, 1);
    const d = new Date(0);
    assert.equal(prepareTransfer(d, false).value, d);
  });
});

describe('message guards', () => {
  it('accepts every main → worker message and rejects malformed ones', () => {
    assert.equal(isToWorker({ type: 'call', id: 1, op: 'dispatch', route: 'app.state', input: {} }), true);
    assert.equal(isToWorker({ type: 'call', id: 2, op: 'shutdown' }), true);
    assert.equal(isToWorker({ type: 'set-theme', mode: 'dark' }), true);
    assert.equal(isToWorker({ type: 'log', level: 'info', message: 'x' }), true);
    assert.equal(isToWorker({ type: 'authorize-choice', kind: 'folder', path: '/x' }), true);
    assert.equal(isToWorker({ type: 'call', id: 0, op: 'dispatch', route: 'x' }), false, 'ids start at 1');
    assert.equal(isToWorker({ type: 'call', id: 1, op: 'eval' }), false);
    assert.equal(isToWorker({ type: 'set-theme', mode: 'pink' }), false);
    assert.equal(isToWorker({ type: 'authorize-choice', kind: 'device', path: '/x' }), false);
    assert.equal(isToWorker(null), false);
  });

  it('accepts every worker → main message and rejects malformed ones', () => {
    const snapshot = { dataDir: '/d', hasOpenCompany: false, theme: 'system' };
    assert.equal(isFromWorker({ type: 'ready', snapshot }), true);
    assert.equal(isFromWorker({ type: 'reply', id: 3, ok: true, value: null, snapshot }), true);
    assert.equal(isFromWorker({ type: 'reply', id: 3, ok: true, value: 1, snapshot: null }), true);
    assert.equal(isFromWorker({ type: 'reply', id: 3, ok: false, error: { name: 'E', message: 'm' }, snapshot: null }), true);
    assert.equal(isFromWorker({ type: 'startup-failed', error: { name: 'E', message: 'm' } }), true);
    assert.equal(isFromWorker({ type: 'fault', kind: 'k', error: { name: 'E', message: 'm' } }), true);
    assert.equal(isFromWorker({ type: 'reply', id: 3, ok: true, snapshot }), false, 'a reply must carry a value');
    assert.equal(isFromWorker({ type: 'ready', snapshot: { dataDir: 1 } }), false);
  });

  it('serializeError keeps name, message, stack and string codes only', () => {
    const err = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    const s = serializeError(err);
    assert.equal(s.message, 'disk full');
    assert.equal(s.code, 'ENOSPC');
    assert.equal(typeof s.stack, 'string');
    assert.deepEqual(serializeError('plain'), { name: 'NonError', message: 'plain' });
  });
});
