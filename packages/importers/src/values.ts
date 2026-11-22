import { isCurrencyCode, parseAmount } from '@pq/core';

export type DateOrder = 'dmy' | 'mdy';

const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/;
const SLASHED = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})(?:[ ,T].*)?$/;

function valid(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Order of day and month for a whole column: a first part above 12 means day first, a
 * second part above 12 means month first. Ambiguous columns use the fallback.
 */
export function detectDateOrder(values: string[], fallback: DateOrder = 'dmy'): DateOrder {
  for (const v of values) {
    const m = SLASHED.exec(v.trim());
    if (!m) continue;
    if (Number(m[1]) > 12) return 'dmy';
    if (Number(m[2]) > 12) return 'mdy';
  }
  return fallback;
}

/** A calendar date as YYYY-MM-DD, or null. Accepts ISO (with time), D.M.Y, D/M/Y or M/D/Y. */
export function parseDate(input: string, order: DateOrder = 'dmy'): string | null {
  const s = input.trim();
  let m = ISO.exec(s);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
  m = SLASHED.exec(s);
  if (m) {
    let y = Number(m[3]);
    if (m[3]!.length === 2) y += y < 70 ? 2000 : 1900;
    const [a, b] = [Number(m[1]), Number(m[2])];
    return order === 'dmy' ? valid(y, b, a) : valid(y, a, b);
  }
  return null;
}

const SYMBOLS: [RegExp, string][] = [
  [/€/, 'EUR'],
  [/£/, 'GBP'],
  [/[¥￥]|元|RMB/i, 'CNY'],
  [/US\$|\$/, 'USD'],
  [/CHF|Fr\./, 'CHF'],
];

/** A currency named inside an amount ("12,99 €", "EUR 12.99", "¥35.00"), or null. */
export function currencyIn(input: string): string | null {
  const code = /\b([A-Z]{3})\b/.exec(input);
  if (code && isCurrencyCode(code[1]!) && code[1] !== 'RMB') return code[1]!;
  for (const [re, cur] of SYMBOLS) if (re.test(input)) return cur;
  return null;
}

/**
 * A money amount in minor units, tolerating currency codes, symbols and spaces.
 * Negative amounts (refunds) and placeholders like "Not Available" give null.
 */
export function parseMoney(input: string, currency: string): number | null {
  const s = input
    .trim()
    .replace(/^'+|'+$/g, '')
    .replace(/\b[A-Z]{3}\b|RMB|US\$|[€£¥￥$元]|Fr\./g, '')
    .trim();
  if (!s || s.startsWith('-') || s.startsWith('(')) return null;
  return parseAmount(s, currency);
}

/** A positive quantity (whole or decimal); empty means 1; anything else null. */
export function parseQuantity(input: string | undefined): number | null {
  const s = (input ?? '').trim().replace(',', '.');
  if (s === '') return 1;
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && n < 1e6 ? n : null;
}
