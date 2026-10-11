/**
 * Hold Ctrl to peek (2.1, SPEC-21 D31 / §3.5, WP-B1): Ctrl pressed alone for PEEK_DELAY_MS sets
 * `<html data-keys>`, and every visible button shows its key until Ctrl is released. Pure state machine,
 * tested in keyPeek.test.ts; app/Workspace.tsx feeds it window events and writes the attribute.
 *
 * - Only Ctrl alone arms it: a Control keydown with Shift, Alt or Meta held does not.
 * - Auto-repeated Control keydowns (`repeat: true`, Windows/X11 while the key is held) are ignored.
 * - Any other key cancels — including AltGraph / AltRight (AltGr is a synthesised Ctrl+Alt on Windows) —
 *   as do pointer down, wheel or a selection drag; window blur and a visibility change hide it and start
 *   over. A cancelled peek stays off while Ctrl is held (repeats never re-arm it); a new press arms again.
 * - Releasing Ctrl hides it.
 * - Never Alt: a bare Alt toggles the auto-hidden native menu bar.
 * - `data-keys="fade"` fades the keys in over PEEK_FADE_MS; under reduced motion it is `"static"`.
 * No key is bound: a modifier alone is not a hotkey.
 */

/** How long Ctrl must be held alone before the keys show (ms). */
export const PEEK_DELAY_MS = 900;
/** The fade-in of the revealed keys (ms); none under reduced motion. */
export const PEEK_FADE_MS = 120;

export type PeekPhase = 'idle' | 'armed' | 'shown' | 'cancelled';

export interface PeekState {
  phase: PeekPhase;
  /** When Ctrl went down (ms, the caller's clock) — meaningful while armed. */
  since: number;
}

export type PeekEvent =
  | { type: 'keydown'; key: string; code?: string; repeat?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; at: number }
  | { type: 'keyup'; key: string; at: number }
  /** The timer the caller set for PEEK_DELAY_MS after arming fired. */
  | { type: 'tick'; at: number }
  /** pointerdown, wheel, a selection drag. */
  | { type: 'cancel' }
  /** Window blur or a visibility change: the keys' state is unknown (Ctrl may be released elsewhere) — hide and start over. */
  | { type: 'reset' };

export const PEEK_IDLE: PeekState = Object.freeze({ phase: 'idle', since: 0 });

const isControl = (key: string): boolean => key === 'Control';
const isAltGr = (key: string, code?: string): boolean => key === 'AltGraph' || code === 'AltRight';

/** The next state. Returns the same object when nothing changes (cheap to compare). */
export function peekReduce(state: PeekState, ev: PeekEvent): PeekState {
  switch (ev.type) {
    case 'keydown': {
      // AltGr arrives as Control (+ Alt) on AltRight: it never arms, and it cancels a peek in progress.
      if (isAltGr(ev.key, ev.code)) return state.phase === 'cancelled' ? state : { phase: 'cancelled', since: 0 };
      if (isControl(ev.key)) {
        if (ev.repeat) return state; // the OS repeating a held Ctrl is not a new press
        if (state.phase === 'armed' || state.phase === 'shown') return state; // the other Ctrl key
        if (ev.shiftKey || ev.altKey || ev.metaKey) return { phase: 'cancelled', since: 0 };
        return { phase: 'armed', since: ev.at };
      }
      // Any other key (a shortcut such as Ctrl+J, AltGr, Shift, a letter) cancels while Ctrl is down.
      return state.phase === 'idle' ? state : state.phase === 'cancelled' ? state : { phase: 'cancelled', since: 0 };
    }
    case 'keyup':
      return isControl(ev.key) ? (state.phase === 'idle' ? state : PEEK_IDLE) : state;
    case 'tick':
      return state.phase === 'armed' && ev.at - state.since >= PEEK_DELAY_MS ? { phase: 'shown', since: state.since } : state;
    case 'cancel':
      return state.phase === 'armed' || state.phase === 'shown' ? { phase: 'cancelled', since: 0 } : state;
    case 'reset':
      return state.phase === 'idle' ? state : PEEK_IDLE;
    default:
      return state;
  }
}

/** Are the keys shown? */
export function peekShown(state: PeekState): boolean {
  return state.phase === 'shown';
}

/** Value of `<html data-keys>`: absent (null) unless shown; 'fade' normally, 'static' under reduced motion. */
export function peekAttribute(state: PeekState, reducedMotion: boolean): 'fade' | 'static' | null {
  if (!peekShown(state)) return null;
  return reducedMotion ? 'static' : 'fade';
}

/** Should the caller start the PEEK_DELAY_MS timer after this transition (it just armed)? */
export function peekArmed(prev: PeekState, next: PeekState): boolean {
  return next.phase === 'armed' && prev.phase !== 'armed';
}
