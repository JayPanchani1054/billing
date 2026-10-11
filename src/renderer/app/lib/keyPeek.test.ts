import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PEEK_DELAY_MS, PEEK_FADE_MS, PEEK_IDLE, peekArmed, peekAttribute, peekReduce, peekShown } from './keyPeek.ts';
import type { PeekEvent, PeekState } from './keyPeek.ts';

const run = (events: readonly PeekEvent[], from: PeekState = PEEK_IDLE): PeekState => events.reduce(peekReduce, from);
const ctrlDown = (at: number, extra: Partial<Extract<PeekEvent, { type: 'keydown' }>> = {}): PeekEvent => ({ type: 'keydown', key: 'Control', code: 'ControlLeft', at, ...extra });
const ctrlUp = (at: number): PeekEvent => ({ type: 'keyup', key: 'Control', at });
const tick = (at: number): PeekEvent => ({ type: 'tick', at });

describe('hold Ctrl to peek (SPEC-21 D31, §3.5)', () => {
  test('900 ms, 120 ms fade', () => {
    assert.equal(PEEK_DELAY_MS, 900);
    assert.equal(PEEK_FADE_MS, 120);
  });

  test('Ctrl alone held ≥ 900 ms shows the keys; releasing Ctrl hides them', () => {
    const armed = run([ctrlDown(1000)]);
    assert.equal(armed.phase, 'armed');
    assert.ok(peekArmed(PEEK_IDLE, armed), 'the caller starts the timer');
    assert.equal(peekShown(run([ctrlDown(1000), tick(1899)])), false, 'not before 900 ms');
    const shown = run([ctrlDown(1000), tick(1900)]);
    assert.ok(peekShown(shown));
    assert.deepEqual(run([ctrlUp(2500)], shown), PEEK_IDLE);
  });

  test('auto-repeated Control keydowns (Windows/X11) are ignored: they neither restart nor cancel the wait', () => {
    const s = run([ctrlDown(0), ctrlDown(500, { repeat: true }), ctrlDown(530, { repeat: true }), tick(900)]);
    assert.ok(peekShown(s));
    const shown = run([ctrlDown(0), tick(900)]);
    assert.equal(peekReduce(shown, ctrlDown(1000, { repeat: true })), shown, 'a repeat while shown changes nothing');
  });

  test('AltGraph / AltRight cancels (AltGr is a synthesised Ctrl+Alt)', () => {
    assert.equal(run([ctrlDown(0), { type: 'keydown', key: 'AltGraph', code: 'AltRight', at: 10 }, tick(900)]).phase, 'cancelled');
    assert.equal(run([ctrlDown(0), { type: 'keydown', key: 'Alt', code: 'AltRight', at: 10 }, tick(900)]).phase, 'cancelled');
    assert.equal(run([ctrlDown(0, { key: 'Control', code: 'AltRight' })]).phase, 'cancelled', 'a Control key reported on AltRight is AltGr');
  });

  test('any other key cancels — a shortcut such as Ctrl+J never flashes the keys — and the peek stays off until Ctrl is pressed again', () => {
    const s = run([ctrlDown(0), { type: 'keydown', key: 'j', code: 'KeyJ', at: 200 }, tick(900)]);
    assert.equal(s.phase, 'cancelled');
    assert.equal(peekShown(run([tick(5000)], s)), false);
    assert.equal(run([ctrlDown(6000, { repeat: true }), tick(7000)], s).phase, 'cancelled', 'holding on does not re-arm');
    const again = run([ctrlUp(8000), ctrlDown(9000), tick(9900)], s);
    assert.ok(peekShown(again), 'release and press again works');
    assert.ok(peekShown(run([ctrlDown(9000), tick(9900)], s)), 'a fresh press (its release was missed) arms again');
    const hidden = run([{ type: 'keydown', key: 'a', at: 9950 }], again);
    assert.equal(peekShown(hidden), false, 'a key while shown hides the keys');
  });

  test('Ctrl with Shift, Alt or Meta held does not arm', () => {
    assert.equal(run([ctrlDown(0, { shiftKey: true }), tick(900)]).phase, 'cancelled');
    assert.equal(run([ctrlDown(0, { altKey: true }), tick(900)]).phase, 'cancelled');
    assert.equal(run([ctrlDown(0, { metaKey: true }), tick(900)]).phase, 'cancelled');
  });

  test('pointer down, wheel and a selection drag cancel (armed or shown)', () => {
    assert.equal(run([ctrlDown(0), { type: 'cancel' }, tick(900)]).phase, 'cancelled');
    assert.equal(run([ctrlDown(0), tick(900), { type: 'cancel' }]).phase, 'cancelled');
    assert.equal(peekReduce(PEEK_IDLE, { type: 'cancel' }), PEEK_IDLE, 'nothing to cancel when idle');
  });

  test('window blur and a visibility change hide the keys and start over (Ctrl may be released in another window)', () => {
    assert.deepEqual(run([ctrlDown(0), tick(900), { type: 'reset' }]), PEEK_IDLE);
    assert.deepEqual(run([ctrlDown(0), { type: 'reset' }, tick(900)]), PEEK_IDLE, 'an armed wait ends too');
    const back = run([ctrlDown(0), { type: 'keydown', key: 'j', at: 10 }, { type: 'reset' }, ctrlDown(5000), tick(5900)]);
    assert.ok(peekShown(back), 'after coming back, the next press works');
  });

  test('a stale tick (from an earlier press) shows nothing', () => {
    const s = run([ctrlDown(0), ctrlUp(300), ctrlDown(500)]);
    assert.equal(run([tick(900)], s).phase, 'armed', '900 ms after the first press is only 400 ms after the second');
    assert.ok(peekShown(run([tick(1400)], s)));
  });

  test('keys of other modifiers released while idle change nothing', () => {
    assert.equal(peekReduce(PEEK_IDLE, { type: 'keyup', key: 'Shift', at: 0 }), PEEK_IDLE);
    assert.equal(peekReduce(PEEK_IDLE, { type: 'keydown', key: 'x', at: 0 }), PEEK_IDLE);
  });

  test('the attribute: absent unless shown; "fade" normally, "static" under reduced motion', () => {
    const shown = run([ctrlDown(0), tick(900)]);
    assert.equal(peekAttribute(PEEK_IDLE, false), null);
    assert.equal(peekAttribute(run([ctrlDown(0)]), false), null);
    assert.equal(peekAttribute(shown, false), 'fade');
    assert.equal(peekAttribute(shown, true), 'static');
  });
});
