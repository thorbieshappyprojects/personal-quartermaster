import { createHash } from 'node:crypto';
import { isCurrencyCode, normaliseText } from '@pq/core';
import { parseCsv } from './csv';
import { currencyIn, detectDateOrder, parseDate, parseMoney, parseQuantity, type DateOrder } from './values';

/**
 * The importers' internal format: purchases with lines. Every input (Amazon export, generic
 * CSV, later Taobao and e-mail) is turned into this; nothing here creates inventory items.
 */
export type PurchaseSource = 'amazon_export' | 'taobao' | 'email' | 'photo' | 'csv' | 'manual';

export interface ParsedLine {
  row: number; // 1-based data row in the file (header = row 0)
  title: string;
  quantity: number;
  unitPriceMinor: number | null;
  amountMinor: number | null; // what the line cost in total (quantity × unit, or the "total" column)
  currency: string | null;
  externalProductId: string | null;
  url: string | null;
  cancelled: boolean;
  dedupeKey: string;
}

export interface ParsedPurchase {
  source: PurchaseSource;
  merchant: string | null;
  externalOrderId: string | null;
  orderedAt: string | null; // YYYY-MM-DD
  currency: string | null;
  totalMinor: number | null;
  dedupeKey: string;
  lines: ParsedLine[];
}

export interface RowError {
  row: number;
  message: string;
}

export const FIELDS = ['date', 'title', 'amount', 'unit_price', 'currency', 'quantity', 'merchant', 'order_id', 'product_id', 'url', 'status'] as const;
export type Field = (typeof FIELDS)[number];
/** Which header holds which field. Only `title` is required. */
export type Mapping = Partial<Record<Field, string>>;

export type Format = 'amazon_order_history' | 'generic';

export interface ParseOptions {
  mapping?: Mapping;          // default: detected from the headers
  defaultCurrency?: string;   // for files without a currency column or symbol
  defaultMerchant?: string;   // for files without a shop column
  dateOrder?: DateOrder;      // default: detected from the date column, else day first
}

export interface ParseResult {
  format: Format;
  source: PurchaseSource;
  headers: string[];
  mapping: Mapping;
  rowCount: number;
  purchases: ParsedPurchase[];
  lineCount: number;
  errors: RowError[];
}

const norm = (h: string) => h.trim().toLowerCase().replace(/[\s_\-./()#:]+/g, '');

// Header names seen in the wild, best first. English, German and Chinese (Taobao tools).
const SYNONYMS: Record<Field, string[]> = {
  date: ['Order Date', 'Bestelldatum', 'Purchase Date', 'Kaufdatum', 'Date', 'Datum', '下单时间', '成交时间', '订单创建时间'],
  title: ['Product Name', 'Title', 'Item', 'Product', 'Artikel', 'Artikelname', 'Bezeichnung', 'Produkt', 'Name', 'Description', 'Beschreibung', '商品名称', '宝贝名称', '商品标题'],
  amount: ['Total Owed', 'Item Total', 'Total', 'Amount', 'Price Paid', 'Betrag', 'Gesamt', 'Gesamtpreis', 'Summe', '实付款', '实付金额', '金额'],
  unit_price: ['Unit Price', 'Purchase Price Per Unit', 'Price', 'Preis', 'Einzelpreis', 'Stückpreis', '单价', '价格'],
  currency: ['Currency', 'Währung', 'Waehrung', '币种'],
  quantity: ['Quantity', 'Qty', 'Menge', 'Anzahl', '数量'],
  merchant: ['Website', 'Merchant', 'Shop', 'Store', 'Seller', 'Händler', 'Haendler', 'Verkäufer', '店铺名称', '店铺', '卖家'],
  order_id: ['Order ID', 'Order Number', 'Bestellnummer', 'Auftragsnummer', '订单号', '订单编号'],
  product_id: ['ASIN', 'ASIN/ISBN', 'SKU', 'Product ID', 'Artikelnummer', '商品ID'],
  url: ['URL', 'Link', 'Product URL', '商品链接'],
  status: ['Order Status', 'Status', '订单状态', '交易状态'],
};

/** Maps headers to fields by exact (normalised) name; each header is used once. */
export function guessMapping(headers: string[]): Mapping {
  const byNorm = new Map(headers.map((h) => [norm(h), h]));
  const used = new Set<string>();
  const out: Mapping = {};
  for (const f of FIELDS) {
    for (const s of SYNONYMS[f]) {
      const h = byNorm.get(norm(s));
      if (h && !used.has(h)) {
        out[f] = h;
        used.add(h);
        break;
      }
    }
  }
  return out;
}

export function detectFormat(headers: string[]): Format {
  const n = new Set(headers.map(norm));
  return n.has('orderid') && n.has('asin') && n.has('productname') && n.has('website') ? 'amazon_order_history' : 'generic';
}

const AMAZON_MAPPING: Mapping = {
  date: 'Order Date', title: 'Product Name', amount: 'Total Owed', unit_price: 'Unit Price', currency: 'Currency',
  quantity: 'Quantity', merchant: 'Website', order_id: 'Order ID', product_id: 'ASIN', status: 'Order Status',
};

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 40);
const CANCELLED = /cancel|storn|abgebrochen|取消|关闭/i;

function amazonUrl(merchant: string | null, productId: string | null): string | null {
  if (!merchant || !productId || !/^[A-Z0-9]{10}$/.test(productId)) return null;
  const host = merchant.trim().toLowerCase();
  return /^amazon\.[a-z.]{2,6}$/.test(host) ? `https://www.${host}/dp/${productId}` : null;
}

/**
 * Parses a CSV order list. Rows without a title are reported and skipped. Lines are grouped
 * into purchases by order id, or by shop and date when there is no order id. Dedupe keys
 * are stable across re-imports of the same or an overlapping file.
 */
export function parseOrders(text: string, opts: ParseOptions = {}): ParseResult {
  const table = parseCsv(text);
  const headers = (table[0] ?? []).map((h) => h.trim());
  const format = detectFormat(headers);
  const source: PurchaseSource = format === 'amazon_order_history' ? 'amazon_export' : 'csv';
  const mapping: Mapping = opts.mapping ?? (format === 'amazon_order_history' ? resolve(headers, AMAZON_MAPPING) : guessMapping(headers));
  const errors: RowError[] = [];
  const result: ParseResult = { format, source, headers, mapping, rowCount: Math.max(table.length - 1, 0), purchases: [], lineCount: 0, errors };
  if (!mapping.title) {
    errors.push({ row: 0, message: 'no column for the product title is mapped' });
    return result;
  }
  const idx = Object.fromEntries(FIELDS.map((f) => [f, mapping[f] ? headers.indexOf(mapping[f]!) : -1])) as Record<Field, number>;
  for (const f of FIELDS) if (mapping[f] && idx[f] < 0) errors.push({ row: 0, message: `mapped column "${mapping[f]}" is not in the file` });
  if (errors.length) return result;

  const get = (r: string[], f: Field) => (idx[f] >= 0 ? (r[idx[f]] ?? '').trim() : '');
  const rows = table.slice(1);
  const dateOrder = opts.dateOrder ?? detectDateOrder(rows.map((r) => get(r, 'date')).filter(Boolean));
  const defaultCurrency = opts.defaultCurrency && isCurrencyCode(opts.defaultCurrency) ? opts.defaultCurrency : null;
  const purchases = new Map<string, ParsedPurchase>();
  const seen = new Map<string, number>(); // per purchase + product: occurrences so far

  rows.forEach((r, n) => {
    const row = n + 1;
    const title = get(r, 'title').replace(/\s+/g, ' ');
    if (!title) {
      errors.push({ row, message: 'no title' });
      return;
    }
    const rawDate = get(r, 'date');
    const orderedAt = rawDate ? parseDate(rawDate, dateOrder) : null;
    if (rawDate && !orderedAt) errors.push({ row, message: `date not understood: "${rawDate.slice(0, 40)}" (imported without a date)` });

    const rawAmount = get(r, 'amount');
    const rawUnit = get(r, 'unit_price');
    const curCol = get(r, 'currency').toUpperCase();
    const currency = (isCurrencyCode(curCol) ? curCol : null) ?? currencyIn(rawAmount) ?? currencyIn(rawUnit) ?? defaultCurrency;
    const quantity = parseQuantity(get(r, 'quantity'));
    if (quantity === null) {
      errors.push({ row, message: `quantity not understood: "${get(r, 'quantity').slice(0, 20)}"` });
      return;
    }
    let amount = currency && rawAmount ? parseMoney(rawAmount, currency) : null;
    let unit = currency && rawUnit ? parseMoney(rawUnit, currency) : null;
    if (amount === null && unit !== null) amount = Math.round(unit * quantity);
    if (unit === null && amount !== null) unit = Math.round(amount / quantity);
    if ((rawAmount || rawUnit) && amount === null && !/not available|n\/a|^-+$/i.test(rawAmount || rawUnit)) {
      errors.push({ row, message: currency ? `price not understood: "${(rawAmount || rawUnit).slice(0, 30)}"` : 'price without a currency (set a default currency)' });
    }

    const merchant = get(r, 'merchant') || opts.defaultMerchant?.trim() || null;
    const orderId = get(r, 'order_id') || null;
    const productId = get(r, 'product_id') || null;
    const pKey = hash([source, (merchant ?? '').toLowerCase(), orderId ? `id:${orderId}` : `date:${orderedAt ?? ''}`].join('|'));
    let p = purchases.get(pKey);
    if (!p) {
      p = { source, merchant, externalOrderId: orderId, orderedAt, currency, totalMinor: null, dedupeKey: pKey, lines: [] };
      purchases.set(pKey, p);
    }
    if (!p.orderedAt && orderedAt) p.orderedAt = orderedAt;
    const base = `${pKey}|${productId ? `p:${productId}` : `t:${normaliseText(title)}`}`;
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    const url = get(r, 'url') || amazonUrl(merchant, productId);
    p.lines.push({
      row,
      title: title.slice(0, 1000),
      quantity,
      unitPriceMinor: unit,
      amountMinor: amount,
      currency: amount !== null ? currency : null,
      externalProductId: productId,
      url: url && /^https?:\/\//i.test(url) ? url.slice(0, 2000) : null,
      cancelled: CANCELLED.test(get(r, 'status')),
      dedupeKey: hash(`${base}|${occurrence}`),
    });
  });

  for (const p of purchases.values()) {
    const priced = p.lines.filter((l) => l.amountMinor !== null && !l.cancelled);
    const currencies = new Set(priced.map((l) => l.currency));
    if (priced.length && currencies.size === 1) {
      p.currency = priced[0]!.currency;
      p.totalMinor = priced.reduce((s, l) => s + l.amountMinor!, 0);
    }
  }
  result.purchases = [...purchases.values()];
  result.lineCount = result.purchases.reduce((s, p) => s + p.lines.length, 0);
  return result;
}

/** The given mapping with header names as they are spelled in this file. */
function resolve(headers: string[], m: Mapping): Mapping {
  const byNorm = new Map(headers.map((h) => [norm(h), h]));
  const out: Mapping = {};
  for (const f of FIELDS) {
    const h = m[f] && byNorm.get(norm(m[f]!));
    if (h) out[f] = h;
  }
  return out;
}

/** The first rows as objects, for the preview. */
export function sampleRows(text: string, n = 5): string[][] {
  return parseCsv(text).slice(1, n + 1);
}
