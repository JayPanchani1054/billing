/**
 * Entry point for portal files: sniffs the bytes (JSON, ZIP of JSON parts, .xlsx), checks that the file
 * is the return the user chose, and hands it to the right parser.
 *
 *   parsePortalFile(bytes, 'gstr2b') → ParsedPortalFile   (throws FileFormatError / VALIDATION)
 *
 * Supported: GSTR-2B JSON (portal, incl. the multi-part ZIP the portal gives for large returns),
 * GSTR-2B / GSTR-2A Excel, GSTR-2A JSON, GSTR-1 JSON (portal download or Bahi's own export).
 */
import { normalizeGstin } from '../../../shared/gst/index.ts';
import type { ReconSource } from '../../../shared/types/gstrecon.ts';
import { validation } from '../../lib/errors.ts';
import { decodeText, FileFormatError } from '../../lib/text.ts';
import { readZip } from '../../lib/zip.ts';
import { bump, KIND_LABELS, type ParsedPortalFile } from './portal-common.ts';
import { detectJsonKind, parseGstr1Json, parseGstr2aJson, parseGstr2bJson, type DetectedKind } from './portal-json.ts';
import { parsePortalXlsx } from './portal-xlsx.ts';

export type { ParsedPortalDoc, ParsedPortalFile } from './portal-common.ts';

const startsWith = (b: Uint8Array, sig: readonly number[]): boolean => sig.every((x, i) => b[i] === x);
const ZIP_SIG = [0x50, 0x4b, 0x03, 0x04];
const CFB_SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function parseJsonText(text: string, label: string): unknown {
  const t = text.trim();
  if (t === '') throw new FileFormatError(label, 'The file is empty');
  if (t.startsWith('<')) {
    throw new FileFormatError(label, 'This is a web page (HTML/XML), not a GST portal file. Download the JSON or Excel file again from the GST portal.');
  }
  try {
    return JSON.parse(t);
  } catch (err) {
    const why = err instanceof Error ? err.message.replace(/^JSON\.parse:\s*/, '') : 'invalid JSON';
    throw new FileFormatError(label, `The file is not valid JSON (${why.slice(0, 120)}). It may be incomplete; download it again from the GST portal.`);
  }
}

function describe(kind: DetectedKind): string {
  if (kind === 'gstr2a_or_gstr1') return 'a GSTR-2A or GSTR-1 file';
  if (kind === 'unknown') return 'not a GST return file';
  return `a ${KIND_LABELS[kind]} file`;
}

/** Refuse a file that is not the return the user chose (clear, actionable message on `source`). */
export function assertKind(requested: ReconSource, detected: DetectedKind): void {
  if (detected === requested) return;
  if (detected === 'gstr2a_or_gstr1' && requested !== 'gstr2b') return;
  if (detected === 'unknown') {
    throw new FileFormatError(
      `${KIND_LABELS[requested]} JSON`,
      `This JSON file is not a ${KIND_LABELS[requested]} download: it has none of the b2b / cdnr / docdata sections.`,
    );
  }
  const hint =
    detected === 'gstr2a_or_gstr1'
      ? `It has no "docdata" section, so it looks like a GSTR-2A or GSTR-1 file. Download GSTR-2B (JSON) from the GST portal, or choose the matching source.`
      : `Choose "${KIND_LABELS[detected]}" as the source, or download ${KIND_LABELS[requested]} from the GST portal.`;
  throw validation([{ path: 'source', message: `This is ${describe(detected)}, not ${KIND_LABELS[requested]}. ${hint}` }]);
}

function parseJsonValue(json: unknown, source: ReconSource): ParsedPortalFile {
  assertKind(source, detectJsonKind(json));
  if (source === 'gstr2b') return parseGstr2bJson(json);
  if (source === 'gstr2a') return parseGstr2aJson(json);
  return parseGstr1Json(json);
}

function mergeParts(parts: ParsedPortalFile[], source: ReconSource): ParsedPortalFile {
  const label = `${KIND_LABELS[source]} ZIP`;
  const gstins = [...new Set(parts.map((p) => p.gstin).filter((g): g is string => g !== null))];
  const periods = [...new Set(parts.map((p) => p.period).filter((p): p is string => p !== null))];
  if (gstins.length > 1) throw new FileFormatError(label, `The ZIP file mixes returns of different GSTINs (${gstins.join(', ')}). Import one GSTIN at a time.`);
  if (periods.length > 1) throw new FileFormatError(label, `The ZIP file mixes returns of different periods (${periods.join(', ')}). Import one period at a time.`);
  const sections: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  for (const p of parts) {
    for (const [k, n] of Object.entries(p.sections)) bump(sections, k, n);
    for (const [k, n] of Object.entries(p.skipped)) bump(skipped, k, n);
  }
  const docs = parts.flatMap((p) => p.docs);
  const warnings = [...new Set(parts.flatMap((p) => p.warnings).filter((w) => !(docs.length > 0 && w.startsWith('The file has no documents'))))];
  return {
    kind: source,
    format: 'zip',
    gstin: gstins[0] ?? null,
    period: periods[0] ?? null,
    generatedOn: parts.map((p) => p.generatedOn).find((g) => g !== null) ?? null,
    docs,
    sections,
    skipped,
    warnings,
  };
}

/** Parse a portal file of the chosen source. */
export function parsePortalFile(bytes: Uint8Array, source: ReconSource): ParsedPortalFile {
  const label = `${KIND_LABELS[source]} file`;
  if (bytes.byteLength === 0) throw new FileFormatError(label, 'The file is empty');
  if (startsWith(bytes, CFB_SIG)) {
    throw new FileFormatError(
      label,
      'This is an old Excel 97-2003 (.xls) file. Open it in Excel and save it as an Excel Workbook (.xlsx), or download the JSON file from the GST portal.',
    );
  }
  if (startsWith(bytes, ZIP_SIG)) {
    const zip = readZip(bytes);
    if (zip.has('xl/workbook.xml') || zip.has('[Content_Types].xml')) {
      if (source === 'gstr1') {
        throw validation([{ path: 'file', message: 'GSTR-1 is reconciled from its JSON file. Download the GSTR-1 JSON from the GST portal (or export it from Bahi) and import that.' }]);
      }
      return parsePortalXlsx(bytes, source);
    }
    const jsonNames = zip.list().filter((n) => /\.json$/i.test(n) && !/(^|\/)__MACOSX\//.test(n)).sort();
    if (jsonNames.length === 0) throw new FileFormatError(`${KIND_LABELS[source]} ZIP`, 'The ZIP file contains no JSON or Excel file from the GST portal.');
    const parts = jsonNames.map((n) => parseJsonValue(parseJsonText(decodeText(zip.read(n)).text, `${KIND_LABELS[source]} JSON (${n})`), source));
    return mergeParts(parts, source);
  }
  const json = parseJsonText(decodeText(bytes).text, `${KIND_LABELS[source]} JSON`);
  return parseJsonValue(json, source);
}

/** GSTIN equality ignoring case/spaces. */
export function sameGstin(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeGstin(a) === normalizeGstin(b);
}
