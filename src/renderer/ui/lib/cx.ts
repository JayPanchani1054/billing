/** Tiny className joiner: cx('bx-btn', active && 'is-active', undefined) → 'bx-btn is-active'. */
export type ClassValue = string | number | false | null | undefined;

export function cx(...values: ClassValue[]): string {
  let out = '';
  for (const v of values) {
    if (v === false || v === null || v === undefined || v === '' || v === 0) continue;
    out = out ? `${out} ${v}` : String(v);
  }
  return out;
}
