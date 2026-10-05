/**
 * Anchored overlay placement with flip + shift (Popover, Menu, Combobox list, DateInput calendar).
 * Pure — unit tested in position.test.ts. Coordinates are viewport (position: fixed) pixels.
 */

export type Side = 'top' | 'bottom' | 'left' | 'right';
export type Align = 'start' | 'center' | 'end';
export type Placement =
  | 'bottom-start'
  | 'bottom'
  | 'bottom-end'
  | 'top-start'
  | 'top'
  | 'top-end'
  | 'right-start'
  | 'right'
  | 'right-end'
  | 'left-start'
  | 'left'
  | 'left-end';

export interface RectLike {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Position {
  top: number;
  left: number;
  placement: Placement;
  /** Space available on the chosen side (for max-height / max-width). */
  available: number;
}

export function splitPlacement(p: Placement): { side: Side; align: Align } {
  const [side, align] = p.split('-') as [Side, Align | undefined];
  return { side, align: align ?? 'center' };
}

function joinPlacement(side: Side, align: Align): Placement {
  return (align === 'center' ? side : `${side}-${align}`) as Placement;
}

const OPPOSITE: Readonly<Record<Side, Side>> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

function spaceOn(side: Side, a: RectLike, vp: Size, padding: number, offset: number): number {
  switch (side) {
    case 'bottom':
      return vp.height - (a.top + a.height) - offset - padding;
    case 'top':
      return a.top - offset - padding;
    case 'right':
      return vp.width - (a.left + a.width) - offset - padding;
    case 'left':
      return a.left - offset - padding;
  }
}

/**
 * Compute a position: prefer `placement`; flip to the opposite side when the floating element does
 * not fit and the opposite side has more room; then shift along the cross axis to stay `padding`
 * inside the viewport.
 */
export function computePosition(
  anchor: RectLike,
  floating: Size,
  viewport: Size,
  placement: Placement = 'bottom-start',
  offset = 4,
  padding = 8,
): Position {
  let { side, align } = splitPlacement(placement);
  const main = side === 'top' || side === 'bottom' ? floating.height : floating.width;
  const here = spaceOn(side, anchor, viewport, padding, offset);
  const there = spaceOn(OPPOSITE[side], anchor, viewport, padding, offset);
  if (main > here && there > here) side = OPPOSITE[side];
  const available = Math.max(0, spaceOn(side, anchor, viewport, padding, offset));

  let top = 0;
  let left = 0;
  if (side === 'bottom' || side === 'top') {
    top = side === 'bottom' ? anchor.top + anchor.height + offset : anchor.top - offset - Math.min(floating.height, available);
    if (align === 'start') left = anchor.left;
    else if (align === 'end') left = anchor.left + anchor.width - floating.width;
    else left = anchor.left + anchor.width / 2 - floating.width / 2;
    left = Math.min(Math.max(left, padding), Math.max(padding, viewport.width - padding - floating.width));
  } else {
    left = side === 'right' ? anchor.left + anchor.width + offset : anchor.left - offset - floating.width;
    if (align === 'start') top = anchor.top;
    else if (align === 'end') top = anchor.top + anchor.height - floating.height;
    else top = anchor.top + anchor.height / 2 - floating.height / 2;
    top = Math.min(Math.max(top, padding), Math.max(padding, viewport.height - padding - floating.height));
  }
  return { top: Math.round(top), left: Math.round(left), placement: joinPlacement(side, align), available: Math.floor(available) };
}
