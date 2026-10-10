/**
 * Paper geometry for printing and PDFs — pure (no Electron imports), unit-tested in printPage.test.ts.
 *
 * The renderer names a paper size (bridge.ts `NativePageSize`); main turns it into the options Electron
 * expects, which differ per API:
 *   - webContents.printToPDF: `pageSize` is a named size or `{ width, height }` in INCHES; `landscape`.
 *   - webContents.print:      `pageSize` is a named size or `{ width, height }` in MICRONS; `landscape`.
 * Thermal receipt rolls (80 mm / 58 mm) are continuous paper: the page is the roll width by the height
 * of the receipt (measured by the renderer from the laid-out preview, clamped here), with no margins —
 * the receipt layout carries its own padding.
 */

/** Paper sizes the renderer may ask for (bridge.ts NativeActions print.* / share.*). */
export const NATIVE_PAGE_SIZES = ['A4', 'A5', 'Letter', 'Legal', '80mm', '58mm', 'custom'] as const;
export type NativePageSize = (typeof NATIVE_PAGE_SIZES)[number];

export type NamedPageSize = 'A4' | 'A5' | 'Letter' | 'Legal';

/** Continuous roll widths in millimetres. */
export const ROLL_WIDTH_MM: Readonly<Record<'80mm' | '58mm', number>> = { '80mm': 80, '58mm': 58 };

/** A receipt shorter than this still gets this much paper (and the printer's minimum feed). */
export const ROLL_MIN_HEIGHT_MM = 40;
/** Longest receipt page: ~3 m of roll (PDF viewers handle pages up to 5 m; drivers cut long before). */
export const ROLL_MAX_HEIGHT_MM = 3000;
/** Height used when the renderer did not measure the receipt (an A4's length). */
export const ROLL_DEFAULT_HEIGHT_MM = 297;

/** A custom page (a cheque leaf: 202 × 92 mm) must be at least this and at most this, in mm. */
export const CUSTOM_MIN_MM = 50;
export const CUSTOM_MAX_MM = 400;

/** Resolved page: a named sheet, or a custom size in millimetres (receipt rolls, cheque leaves). */
export type PageSpec =
  | { kind: 'named'; size: NamedPageSize; landscape: boolean }
  | { kind: 'roll'; widthMm: number; heightMm: number }
  | { kind: 'custom'; widthMm: number; heightMm: number };

export function isRollSize(size: NativePageSize): size is '80mm' | '58mm' {
  return size === '80mm' || size === '58mm';
}

/**
 * Validate the renderer's page request (already shape-checked strings/numbers) into a PageSpec.
 * `rollHeightMm` is only used for rolls; it is rounded up to whole millimetres and clamped.
 * Throws a plain Error with a user-readable message for impossible values.
 */
export function resolvePageSpec(
  size: NativePageSize | undefined,
  landscape: boolean | undefined,
  rollHeightMm: number | undefined,
  customMm?: { width: unknown; height: unknown },
): PageSpec {
  const s = size ?? 'A4';
  if (s === 'custom') {
    const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= CUSTOM_MIN_MM && v <= CUSTOM_MAX_MM;
    if (!customMm || !ok(customMm.width) || !ok(customMm.height)) throw new Error(`Invalid paper size: width and height must be ${CUSTOM_MIN_MM}–${CUSTOM_MAX_MM} mm.`);
    return { kind: 'custom', widthMm: Math.round(customMm.width * 10) / 10, heightMm: Math.round(customMm.height * 10) / 10 };
  }
  if (isRollSize(s)) {
    if (rollHeightMm !== undefined && (typeof rollHeightMm !== 'number' || !Number.isFinite(rollHeightMm) || rollHeightMm <= 0)) {
      throw new Error('Invalid receipt length.');
    }
    const h = rollHeightMm === undefined ? ROLL_DEFAULT_HEIGHT_MM : Math.ceil(rollHeightMm);
    return { kind: 'roll', widthMm: ROLL_WIDTH_MM[s], heightMm: Math.min(ROLL_MAX_HEIGHT_MM, Math.max(ROLL_MIN_HEIGHT_MM, h)) };
  }
  return { kind: 'named', size: s, landscape: landscape === true };
}

const MM_PER_INCH = 25.4;

/** Options for webContents.printToPDF (inches for custom sizes). */
export function pdfPageOptions(spec: PageSpec): { pageSize: NamedPageSize | { width: number; height: number }; landscape: boolean } {
  if (spec.kind === 'named') return { pageSize: spec.size, landscape: spec.landscape };
  // Custom sizes are given as the page is fed (portrait): width across, height along the feed.
  const r = (mm: number): number => Math.round((mm / MM_PER_INCH) * 10_000) / 10_000;
  return { pageSize: { width: r(spec.widthMm), height: r(spec.heightMm) }, landscape: false };
}

/** Options for webContents.print (microns for custom sizes). */
export function printPageOptions(spec: PageSpec): { pageSize: NamedPageSize | { width: number; height: number }; landscape: boolean } {
  if (spec.kind === 'named') return { pageSize: spec.size, landscape: spec.landscape };
  return { pageSize: { width: Math.round(spec.widthMm * 1000), height: Math.round(spec.heightMm * 1000) }, landscape: false };
}

/**
 * A roll or a custom page (cheque) is printed edge to edge (the document carries its own padding /
 * positions); sheets keep the requested margins.
 */
export function marginsFor(spec: PageSpec, requested: 'default' | 'none' | 'minimum'): 'default' | 'none' | 'minimum' {
  return spec.kind === 'named' ? requested : 'none';
}

/** Printer names come from the OS list; anything else is refused before reaching Chromium. */
export function validPrinterName(name: unknown): name is string {
  // eslint-disable-next-line no-control-regex
  return typeof name === 'string' && name.length > 0 && name.length <= 256 && !/[\u0000-\u001f\u007f]/.test(name);
}
