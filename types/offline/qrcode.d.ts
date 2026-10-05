/** OFFLINE TYPE SHIM — subset of @types/qrcode. */
export type QRCodeErrorCorrectionLevel = 'low' | 'medium' | 'quartile' | 'high' | 'L' | 'M' | 'Q' | 'H';
export interface QRCodeRenderersOptions {
  errorCorrectionLevel?: QRCodeErrorCorrectionLevel;
  margin?: number;
  scale?: number;
  width?: number;
  color?: { dark?: string; light?: string };
  version?: number;
}
export interface QRCodeToStringOptions extends QRCodeRenderersOptions {
  type?: 'svg' | 'utf8' | 'terminal';
}
export interface QRCodeToDataURLOptions extends QRCodeRenderersOptions {
  type?: 'image/png' | 'image/jpeg' | 'image/webp';
}
export function toString(text: string, options?: QRCodeToStringOptions): Promise<string>;
export function toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>;
declare const QRCode: { toString: typeof toString; toDataURL: typeof toDataURL };
export default QRCode;
