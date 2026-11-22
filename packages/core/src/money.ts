// Amounts are stored as integers in the currency's minor unit (ISO 4217 exponent).
const EXPONENT: Record<string, number> = {
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
};

export function currencyExponent(currency: string): number {
  return EXPONENT[currency.toUpperCase()] ?? 2;
}

export function isCurrencyCode(v: string): boolean {
  return /^[A-Z]{3}$/.test(v);
}

/**
 * Parses a user-typed amount into minor units. Rules:
 * - with both "," and "." the last one is the decimal separator ("1.234,50", "1,234.50");
 * - a single separator type used more than once is a thousands separator ("1.234.567");
 * - a single separator followed by exactly three digits is a thousands separator ("1.234")
 *   unless the currency itself has three decimals;
 * - otherwise it is the decimal separator ("12,99", "12.5").
 * Returns null for anything else (negative, letters, more decimals than the currency has).
 */
export function parseAmount(input: string, currency: string): number | null {
  const s = input.trim().replace(/[\s\u00a0']/g, '').replace(/^[€$£¥]|[€$£¥]$/g, '');
  if (!/^\d[\d.,]*$/.test(s) || /[.,]$/.test(s)) return null;
  const exp = currencyExponent(currency);
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  let decimalSep: string | null = null;
  if (hasComma && hasDot) {
    decimalSep = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
  } else if (hasComma || hasDot) {
    const sep = hasComma ? ',' : '.';
    const parts = s.split(sep);
    const tail = parts[parts.length - 1]!;
    const thousands = parts.length > 2 || (tail.length === 3 && exp !== 3);
    decimalSep = thousands ? null : sep;
  }
  let intPart = s;
  let frac = '';
  if (decimalSep) {
    const i = s.lastIndexOf(decimalSep);
    intPart = s.slice(0, i);
    frac = s.slice(i + 1);
  }
  // Whatever separators remain in the integer part are thousands separators: groups of exactly three.
  const groups = intPart.split(/[.,]/);
  if (groups.length > 1 && (groups[0]!.length > 3 || groups.slice(1).some((g) => g.length !== 3))) return null;
  intPart = groups.join('');
  if (intPart === '' || frac.length > exp) return null;
  const minor = Number(intPart) * 10 ** exp + Number(frac.padEnd(exp, '0') || '0');
  return Number.isSafeInteger(minor) ? minor : null;
}

export function formatAmount(minor: number, currency: string, locale = 'en-GB'): string {
  const exp = currencyExponent(currency);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: exp,
    maximumFractionDigits: exp,
  }).format(minor / 10 ** exp);
}
