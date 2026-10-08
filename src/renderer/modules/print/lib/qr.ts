/**
 * QR images for printed documents, as PNG data URLs (self-contained, allowed by the print CSP).
 *  - UPI: the upi://pay link from the print data (amount and invoice number pre-filled).
 *  - E-invoice: the signed QR string returned by the IRP, printed as is (Rule 48(4)).
 */
import QRCode from 'qrcode';
import type { PrintVoucherData } from '../../../../shared/types/print.ts';

export interface DocumentQrs {
  upi: string | null;
  einvoice: string | null;
}

export const NO_QRS: DocumentQrs = { upi: null, einvoice: null };

async function toDataUrl(text: string, width: number, level: 'L' | 'M'): Promise<string | null> {
  try {
    return await QRCode.toDataURL(text, { errorCorrectionLevel: level, margin: 1, width, type: 'image/png' });
  } catch {
    return null; // a string too long for a QR code: print without the image
  }
}

/** Both QR images of a document (null when not applicable or when the text cannot be encoded). */
export async function documentQrs(doc: Pick<PrintVoucherData, 'upi' | 'einvoice' | 'status'>): Promise<DocumentQrs> {
  const [upi, einvoice] = await Promise.all([
    doc.upi && !doc.status.cancelled ? toDataUrl(doc.upi.uri, 240, 'M') : Promise.resolve(null),
    doc.einvoice?.signedQr ? toDataUrl(doc.einvoice.signedQr, 360, 'L') : Promise.resolve(null),
  ]);
  return { upi, einvoice };
}
