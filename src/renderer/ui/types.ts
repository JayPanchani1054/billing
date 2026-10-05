/** Shared prop vocabularies for the kit. */

/** Semantic colour tones (map to --{tone}-* tokens). */
export type Tone = 'neutral' | 'brand' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

/** Status tones used by Banner/Toast/ProgressBar. */
export type StatusTone = 'info' | 'success' | 'warning' | 'danger';

export type ControlSize = 'sm' | 'md';

export type Density = 'compact' | 'comfortable';

export type Align = 'left' | 'right' | 'center';

/** Spacing scale steps (→ var(--space-N)). */
export type Space = 0 | 0.5 | 1 | 1.5 | 2 | 2.5 | 3 | 4 | 5 | 6 | 8 | 10 | 12 | 16;

export function spaceVar(s: Space): string {
  return `var(--space-${String(s).replace('.', '-')})`;
}
