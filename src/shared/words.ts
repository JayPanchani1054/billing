/**
 * Amounts in words for invoices and cheques, Indian numbering system (Crore, Lakh, Thousand, Hundred).
 *
 *   amountInWords(12345678) → 'Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only'
 *   numberToWordsIndian(10000000) → 'One Crore'
 *
 * Works on integer paise only (no floating-point division), so the paise part is always exact.
 */
import type { Paise } from './money.ts';

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
] as const;
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'] as const;

/** 0–99 → words ('' for 0). */
function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  const t = TENS[Math.floor(n / 10)];
  const o = n % 10;
  return o ? `${t} ${ONES[o]}` : t;
}

/** 0–999 → words ('' for 0). */
function threeDigits(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (rest) parts.push(twoDigits(rest));
  return parts.join(' ');
}

/** Positive safe integer → Indian-system words ('' for 0). Crores above 99 recurse ('One Lakh Crore'). */
function indianWords(n: number): string {
  if (n === 0) return '';
  const parts: string[] = [];
  const crore = Math.floor(n / 1e7);
  let rest = n % 1e7;
  if (crore) parts.push(`${indianWords(crore)} Crore`);
  const lakh = Math.floor(rest / 1e5);
  rest %= 1e5;
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  const thousand = Math.floor(rest / 1e3);
  rest %= 1e3;
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (rest) parts.push(threeDigits(rest));
  return parts.join(' ');
}

/** Positive safe integer → international-system words (Thousand, Million, Billion, Trillion). */
function internationalWords(n: number): string {
  if (n === 0) return '';
  const scales = ['', 'Thousand', 'Million', 'Billion', 'Trillion', 'Quadrillion'];
  const parts: string[] = [];
  let i = 0;
  while (n > 0) {
    const chunk = n % 1000;
    if (chunk) parts.unshift(scales[i] ? `${threeDigits(chunk)} ${scales[i]}` : threeDigits(chunk));
    n = Math.floor(n / 1000);
    i++;
  }
  return parts.join(' ');
}

function assertSafeInteger(n: number, what: string): void {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${what} must be a safe integer: ${n}`);
}

/** Integer → words in the Indian system: 123456 → 'One Lakh Twenty Three Thousand Four Hundred Fifty Six'. */
export function numberToWordsIndian(n: number): string {
  assertSafeInteger(n, 'Number');
  if (n === 0) return 'Zero';
  return n < 0 ? `Minus ${indianWords(-n)}` : indianWords(n);
}

/** Integer → words in the international system: 1234567 → 'One Million Two Hundred Thirty Four Thousand …'. */
export function numberToWordsInternational(n: number): string {
  assertSafeInteger(n, 'Number');
  if (n === 0) return 'Zero';
  return n < 0 ? `Minus ${internationalWords(-n)}` : internationalWords(n);
}

const DIGIT_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'] as const;

export interface AmountInWordsOptions {
  /** 'INR' (default): 'Rupees … and … Paise Only'. 'none': plain number words with 'Point' decimals. */
  currency?: 'INR' | 'none';
  /** 'indian' (default): Crore/Lakh. 'international': Million/Billion. */
  style?: 'indian' | 'international';
}

/**
 * Paise → amount in words.
 *   0          → 'Rupees Zero Only'
 *   1          → 'One Paise Only'
 *   100        → 'Rupees One Only'
 *   12345678   → 'Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only'
 *   -5000      → 'Minus Rupees Fifty Only'
 *   currency 'none': 12345678 → 'One Lakh Twenty Three Thousand Four Hundred Fifty Six Point Seven Eight'
 */
export function amountInWords(paise: Paise, opts: AmountInWordsOptions = {}): string {
  assertSafeInteger(paise, 'Amount in paise');
  const words = opts.style === 'international' ? internationalWords : indianWords;
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const fraction = abs % 100;
  const minus = negative ? 'Minus ' : '';

  if (opts.currency === 'none') {
    const whole = rupees === 0 ? 'Zero' : words(rupees);
    const dec = fraction === 0 ? '' : ` Point ${DIGIT_WORDS[Math.floor(fraction / 10)]}${fraction % 10 ? ` ${DIGIT_WORDS[fraction % 10]}` : ''}`;
    return `${minus}${whole}${dec}`;
  }

  if (rupees === 0 && fraction === 0) return 'Rupees Zero Only';
  if (rupees === 0) return `${minus}${twoDigits(fraction)} Paise Only`;
  const paisePart = fraction ? ` and ${twoDigits(fraction)} Paise` : '';
  return `${minus}Rupees ${words(rupees)}${paisePart} Only`;
}
