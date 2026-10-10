/**
 * Names fixed by the XML interchange format that the XML data import / export reads and writes.
 *
 * The format (the "Import Data" envelope used by conventional Indian accounting software) defines a
 * few element and namespace names that the importer must recognise and the exporter must write
 * exactly as below. They live here, and only here; every other module, test and fixture uses these
 * constants.
 *
 *   ENVELOPE › HEADER › <REQUEST_TAG>Import Data</REQUEST_TAG>
 *            › BODY › IMPORTDATA › REQUESTDESC … › REQUESTDATA › <MESSAGE_TAG xmlns:UDF="<UDF_NAMESPACE>">*
 */

/** Element names fixed by the XML interchange format. */
export const MESSAGE_TAG = 'TALLYMESSAGE';
export const REQUEST_TAG = 'TALLYREQUEST';
/** Namespace URI bound to the `UDF` prefix on every message element (fixed by the format). */
export const UDF_NAMESPACE = 'TallyUDF';

/** Opening / closing message element as files written by other programs spell it (fixtures, tests). */
export const MESSAGE_OPEN = `<${MESSAGE_TAG} xmlns:UDF="${UDF_NAMESPACE}">`;
export const MESSAGE_CLOSE = `</${MESSAGE_TAG}>`;

/**
 * Formats written by builds before the rename: the values those builds stored in vouchers.meta of
 * imported vouchers. Only ever READ (re-import duplicate detection and update); new data is written
 * with the names in xmlImport.ts. Re-exported by src/core/lib/legacyNames.ts.
 */
export const LEGACY_IMPORT_SOURCE = 'tally';
/** Key of the per-voucher interchange details inside vouchers.meta (`meta.<key>.guid`). */
export const LEGACY_IMPORT_META_KEY = 'tally';
