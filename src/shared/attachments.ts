/**
 * File attachments (dataplus): which files may be attached, how big, and how they are named.
 * Shared by the core (checks before storing), Electron main (checks again before a copy is opened in
 * another program) and the renderer (file-dialog filters, early messages).
 *
 * Only documents and images an accountant attaches as evidence are allowed (purchase bills, delivery
 * challans, bank advices, agreements, photos): never programs, scripts, shortcuts, HTML or archives —
 * a file opened from the books must not be able to run code. The core also checks the file's first
 * bytes (a renamed .exe is refused).
 */

export type AttachmentEntityType = 'voucher' | 'ledger' | 'stock_item';
export const ATTACHMENT_ENTITY_TYPES: readonly AttachmentEntityType[] = ['voucher', 'ledger', 'stock_item'];

/** Largest file that can be attached (25 MB — a multi-page scanned bill at 300 dpi fits easily). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Most files on one voucher / master. */
export const MAX_ATTACHMENTS_PER_ENTITY = 50;
export const MAX_ATTACHMENT_NAME = 200;

/** How the core recognises the content (first bytes) of each kind. */
export type AttachmentSignature = 'pdf' | 'png' | 'jpeg' | 'gif' | 'webp' | 'tiff' | 'bmp' | 'zip_office' | 'ole_office' | 'text';

export interface AttachmentType {
  ext: string;
  mime: string;
  label: string;
  signature: AttachmentSignature;
}

export const ATTACHMENT_TYPES: readonly AttachmentType[] = [
  { ext: 'pdf', mime: 'application/pdf', label: 'PDF document', signature: 'pdf' },
  { ext: 'png', mime: 'image/png', label: 'PNG image', signature: 'png' },
  { ext: 'jpg', mime: 'image/jpeg', label: 'JPEG image', signature: 'jpeg' },
  { ext: 'jpeg', mime: 'image/jpeg', label: 'JPEG image', signature: 'jpeg' },
  { ext: 'gif', mime: 'image/gif', label: 'GIF image', signature: 'gif' },
  { ext: 'webp', mime: 'image/webp', label: 'WebP image', signature: 'webp' },
  { ext: 'tif', mime: 'image/tiff', label: 'TIFF image', signature: 'tiff' },
  { ext: 'tiff', mime: 'image/tiff', label: 'TIFF image', signature: 'tiff' },
  { ext: 'bmp', mime: 'image/bmp', label: 'Bitmap image', signature: 'bmp' },
  { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel workbook', signature: 'zip_office' },
  { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word document', signature: 'zip_office' },
  { ext: 'odt', mime: 'application/vnd.oasis.opendocument.text', label: 'OpenDocument text', signature: 'zip_office' },
  { ext: 'ods', mime: 'application/vnd.oasis.opendocument.spreadsheet', label: 'OpenDocument spreadsheet', signature: 'zip_office' },
  { ext: 'xls', mime: 'application/vnd.ms-excel', label: 'Excel 97-2003 workbook', signature: 'ole_office' },
  { ext: 'doc', mime: 'application/msword', label: 'Word 97-2003 document', signature: 'ole_office' },
  { ext: 'csv', mime: 'text/csv', label: 'CSV file', signature: 'text' },
  { ext: 'txt', mime: 'text/plain', label: 'Text file', signature: 'text' },
  { ext: 'json', mime: 'application/json', label: 'JSON file (e.g. e-invoice)', signature: 'text' },
  { ext: 'xml', mime: 'application/xml', label: 'XML file', signature: 'text' },
];

const BY_EXT = new Map(ATTACHMENT_TYPES.map((t) => [t.ext, t] as const));

/** Lower-case extension of a file name ('' when none). */
export function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** The allowed type of a file name, or null (unknown / not allowed). */
export function attachmentTypeOf(name: string): AttachmentType | null {
  return BY_EXT.get(fileExtension(name)) ?? null;
}

/** Plain-English list of the allowed kinds for messages. */
export const ALLOWED_ATTACHMENTS_TEXT = 'PDF, images (JPG, PNG, GIF, WebP, TIFF, BMP), Excel / Word / OpenDocument files, CSV, TXT, JSON and XML';

/** File-dialog filters for picking an attachment. */
export const ATTACHMENT_FILE_FILTERS: ReadonlyArray<{ name: string; extensions: string[] }> = [
  { name: 'Documents and images', extensions: ATTACHMENT_TYPES.map((t) => t.ext) },
  { name: 'PDF', extensions: ['pdf'] },
  { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'tif', 'tiff', 'bmp'] },
];

/**
 * A file name safe to show and to use for a temporary copy: no folders, no control or reserved
 * characters, at most MAX_ATTACHMENT_NAME characters, extension kept.
 */
export function cleanAttachmentName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (base.length <= MAX_ATTACHMENT_NAME) return base;
  const ext = fileExtension(base);
  const keep = MAX_ATTACHMENT_NAME - (ext ? ext.length + 1 : 0);
  return ext ? `${base.slice(0, keep)}.${ext}` : base.slice(0, MAX_ATTACHMENT_NAME);
}

/** '1.2 MB', '840 KB', '312 bytes' */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} byte${bytes === 1 ? '' : 's'}`;
}
