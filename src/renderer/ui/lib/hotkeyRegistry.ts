/**
 * Scope-aware hotkey dispatch. Pure logic (the DOM listener lives in hooks/useHotkeys.ts) so the
 * layering rules are unit-testable.
 *
 * Model
 * - A *layer* is a node in a tree mirroring the React tree of <HotkeyScope>s. Layer 0 is the root
 *   (app-global hotkeys). Screens get a non-blocking layer; Modal/Drawer/Popover get a *blocking* layer.
 * - A layer is *effective* when it and all its ancestors are active.
 * - The topmost effective blocking layer (latest activation) fences everything outside its subtree:
 *   while a dialog is open only the dialog's (and its descendants') hotkeys fire.
 * - Among eligible layers, deeper layers win, then the most recently activated; within a layer the
 *   most recent binding wins. A handler returning `false` passes the key on to the next candidate.
 * - Plain typing combos (no Ctrl/Alt/Meta, not F-keys/Escape) are ignored while focus is in an
 *   editable element unless the binding opts in with `allowInInputs`.
 * - Events already `defaultPrevented` (a component consumed the key) and IME composition are ignored.
 */
import { isTypingCombo, matchesHotkey } from './hotkeys.ts';
import type { KeyEventLike, ParsedHotkey } from './hotkeys.ts';

export interface HotkeyEventLike extends KeyEventLike {
  defaultPrevented: boolean;
  isComposing?: boolean;
  keyCode?: number;
  target: unknown;
  repeat?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export type RegistryHandler<E> = (event: E) => boolean | void;

export interface LayerSpec {
  parent: number;
  blocking: boolean;
  active: boolean;
}

interface Layer {
  id: number;
  parent: number | null;
  blocking: boolean;
  active: boolean;
  seq: number;
}

interface Binding<E> {
  id: number;
  layer: number;
  combos: readonly ParsedHotkey[];
  handler: RegistryHandler<E>;
  allowInInputs: boolean;
  allowRepeat: boolean;
}

export const ROOT_LAYER = 0;

export class HotkeyRegistry<E extends HotkeyEventLike = HotkeyEventLike> {
  private readonly layers = new Map<number, Layer>();
  private readonly bindings = new Map<number, Binding<E>>();
  private nextLayerId = 1;
  private nextBindingId = 1;
  private seq = 1;
  private readonly isEditable: (target: unknown) => boolean;

  constructor(isEditable: (target: unknown) => boolean) {
    this.isEditable = isEditable;
    this.layers.set(ROOT_LAYER, { id: ROOT_LAYER, parent: null, blocking: false, active: true, seq: 0 });
  }

  /** Reserve an id during render; the layer only participates once `upsertLayer` registers it. */
  allocateLayerId(): number {
    return this.nextLayerId++;
  }

  upsertLayer(id: number, spec: LayerSpec): void {
    const prev = this.layers.get(id);
    const becameActive = spec.active && (!prev || !prev.active);
    this.layers.set(id, {
      id,
      parent: spec.parent,
      blocking: spec.blocking,
      active: spec.active,
      seq: becameActive ? this.seq++ : (prev?.seq ?? this.seq++),
    });
  }

  setLayerActive(id: number, active: boolean): void {
    const l = this.layers.get(id);
    if (!l || l.active === active) return;
    l.active = active;
    if (active) l.seq = this.seq++;
  }

  removeLayer(id: number): void {
    if (id !== ROOT_LAYER) this.layers.delete(id);
  }

  addBinding(
    layer: number,
    combos: readonly ParsedHotkey[],
    handler: RegistryHandler<E>,
    opts: { allowInInputs?: boolean; allowRepeat?: boolean } = {},
  ): () => void {
    const id = this.nextBindingId++;
    this.bindings.set(id, {
      id,
      layer,
      combos,
      handler,
      allowInInputs: opts.allowInInputs ?? false,
      allowRepeat: opts.allowRepeat ?? true,
    });
    return () => {
      this.bindings.delete(id);
    };
  }

  private isEffective(l: Layer): boolean {
    let cur: Layer | undefined = l;
    let guard = 0;
    while (cur) {
      if (!cur.active) return false;
      if (cur.parent === null) return true;
      cur = this.layers.get(cur.parent);
      if (++guard > 256) return false;
    }
    return false; // parent not registered (yet)
  }

  private depth(l: Layer): number {
    let d = 0;
    let cur: Layer | undefined = l;
    while (cur && cur.parent !== null && d < 256) {
      cur = this.layers.get(cur.parent);
      d++;
    }
    return d;
  }

  private isDescendantOrSelf(l: Layer, ancestorId: number): boolean {
    let cur: Layer | undefined = l;
    let guard = 0;
    while (cur) {
      if (cur.id === ancestorId) return true;
      if (cur.parent === null) return false;
      cur = this.layers.get(cur.parent);
      if (++guard > 256) return false;
    }
    return false;
  }

  /** Layer ids that may receive keys right now, highest priority first. */
  eligibleLayers(): number[] {
    const effective: Layer[] = [];
    for (const l of this.layers.values()) if (this.isEffective(l)) effective.push(l);
    let fence: Layer | null = null;
    for (const l of effective) if (l.blocking && (!fence || l.seq > fence.seq)) fence = l;
    const eligible = fence ? effective.filter((l) => this.isDescendantOrSelf(l, (fence as Layer).id)) : effective;
    return eligible
      .map((l) => ({ l, d: this.depth(l) }))
      .sort((a, b) => b.d - a.d || b.l.seq - a.l.seq)
      .map((x) => x.l.id);
  }

  /** True when a blocking layer (dialog) currently fences the app. */
  hasBlockingLayer(): boolean {
    for (const l of this.layers.values()) if (l.blocking && this.isEffective(l)) return true;
    return false;
  }

  /** Route a keydown. Returns true when a handler consumed it (preventDefault + stopPropagation done). */
  dispatch(e: E): boolean {
    if (e.defaultPrevented) return false;
    if (e.isComposing || e.keyCode === 229) return false;
    const editable = this.isEditable(e.target);
    const order = this.eligibleLayers();
    if (order.length === 0) return false;
    const byLayer = new Map<number, Binding<E>[]>();
    for (const b of this.bindings.values()) {
      const list = byLayer.get(b.layer);
      if (list) list.push(b);
      else byLayer.set(b.layer, [b]);
    }
    for (const layerId of order) {
      const list = byLayer.get(layerId);
      if (!list) continue;
      for (let i = list.length - 1; i >= 0; i--) {
        const b = list[i];
        if (e.repeat && !b.allowRepeat) continue;
        for (const combo of b.combos) {
          if (!matchesHotkey(e, combo)) continue;
          if (editable && !b.allowInInputs && isTypingCombo(combo)) continue;
          const res = b.handler(e);
          if (res === false) break;
          e.preventDefault();
          e.stopPropagation();
          return true;
        }
      }
    }
    return false;
  }
}
