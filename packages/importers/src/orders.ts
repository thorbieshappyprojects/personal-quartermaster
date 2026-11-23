import { createHash } from 'node:crypto';
import { isCurrencyCode, normaliseText } from '@pq/core';
import { parseCsv } from './csv';
import { currencyIn, detectDateOrder, parseDate, parseMoney, parseQuantity, type DateOrder } from './values';

/**
 * The importers' internal format: purchases with lines. Every input (Amazon export, generic
 * CSV, later Taobao and e-mail) is turned into this; nothing here creates inventory items.
 */
export type PurchaseSource = 'amazon_export' | 'taobao' | 'email' | 'photo' | 'csv' | 'manual';

/** Lines a rule closes on import: they stay in the history but never reach the check. */
export type AutoClose =
  | { possession: 'ignored'; rule: 'cancelled' | 'not_goods' }
  | { possession: 'gone'; reason: 'returned'; rule: 'returned' };

export interface ParsedLine {
  row: number; // 1-based data row in the file (header = row 0)
  title: string;
  titleTranslated: string | null;
  quantity: number;
  unitPriceMinor: number | null;
  amountMinor: number | null; // what the line cost in total (quantity × unit, or the "total" column)
  currency: string | null;
  externalProductId: string | null;
  url: string | null;
  autoClose: AutoClose | null;
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
  /** The key comes from a real order number (the same order in any file), not from shop and date. */
  orderKeyed: boolean;
  lines: ParsedLine[];
}

export interface RowError {
  row: number;
  message: string;
}

export const FIELDS = [
  'date', 'title', 'title_translated', 'variant', 'amount', 'unit_price', 'currency', 'quantity', 'merchant', 'order_id',
  'product_id', 'url', 'status', 'category',
] as const;
export type Field = (typeof FIELDS)[number];
/** Which header holds which field. Only `title` is required. */
export type Mapping = Partial<Record<Field, string>>;

export type Format = 'amazon_order_history' | 'amazon_order_pages' | 'taobao_orders' | 'generic';

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
  title: ['Product Name', 'Item Title', 'Title', 'Item', 'Product', 'Artikel', 'Artikelname', 'Bezeichnung', 'Produkt', 'Name', 'Description', 'Beschreibung', 'Item Title CN', '商品名称', '宝贝名称', '商品标题'],
  title_translated: ['Item Title EN', 'Title EN', 'Title (English)', 'Translation'],
  variant: ['Variant EN', 'Variant', 'Variante', 'Option', '颜色分类', '商品属性'],
  amount: ['Total Owed', 'Item Total', 'Line Total', 'Total', 'Amount', 'Price Paid', 'Betrag', 'Gesamt', 'Gesamtpreis', 'Summe', '实付款', '实付金额', '金额'],
  unit_price: ['Unit Price', 'Purchase Price Per Unit', 'Unit Price CNY', 'Unit Price EUR', 'Unit Price USD', 'Price', 'Preis', 'Einzelpreis', 'Stückpreis', '单价', '价格'],
  currency: ['Currency', 'Währung', 'Waehrung', '币种'],
  quantity: ['Quantity', 'Qty', 'Menge', 'Anzahl', '数量'],
  merchant: ['Website', 'Merchant', 'Shop', 'Store', 'Seller', 'Händler', 'Haendler', 'Verkäufer', '店铺名称', '店铺', '卖家'],
  order_id: ['Order ID', 'Order Number', 'Order No', 'Bestellnummer', 'Auftragsnummer', '订单号', '订单编号'],
  product_id: ['ASIN', 'ASIN/ISBN', 'SKU', 'Product ID', 'Artikelnummer', '商品ID'],
  url: ['URL', 'Product URL', 'Link', '商品链接'],
  status: ['Order Status', 'Status EN', 'Shipment Status', 'Status', '订单状态', '交易状态'],
  category: ['Order Type', 'Category', 'Type', 'Kategorie', 'Art'],
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

interface Layout {
  format: Format;
  source: PurchaseSource;
  /** Normalised headers that must all be present. */
  needs: string[];
  mapping: Mapping;
  defaults?: Pick<ParseOptions, 'defaultCurrency' | 'defaultMerchant'>;
}

/**
 * Layouts recognised by their headers. Everything else is "generic" with a guessed mapping.
 * - Amazon's privacy export (Retail.OrderHistory.*.csv).
 * - Order lists scraped from Amazon's order pages (one row per item, with ASIN and order_type).
 * - Taobao order lists with original and English titles, amounts in CNY.
 */
const LAYOUTS: Layout[] = [
  {
    format: 'amazon_order_history', source: 'amazon_export', needs: ['orderid', 'asin', 'productname', 'website'],
    mapping: {
      date: 'Order Date', title: 'Product Name', amount: 'Total Owed', unit_price: 'Unit Price', currency: 'Currency',
      quantity: 'Quantity', merchant: 'Website', order_id: 'Order ID', product_id: 'ASIN', status: 'Order Status',
    },
  },
  {
    format: 'amazon_order_pages', source: 'amazon_export', needs: ['orderid', 'asin', 'itemtitle', 'ordertype'],
    mapping: {
      date: 'order_date', title: 'item_title', unit_price: 'unit_price', currency: 'currency', quantity: 'quantity',
      order_id: 'order_id', product_id: 'asin', url: 'product_url', status: 'shipment_status', category: 'order_type',
    },
    defaults: { defaultMerchant: 'Amazon' },
  },
  {
    format: 'taobao_orders', source: 'taobao', needs: ['orderno', 'itemtitlecn', 'unitpricecny'],
    mapping: {
      date: 'order_date', title: 'item_title_cn', title_translated: 'item_title_en', variant: 'variant_en', unit_price: 'unit_price_cny',
      quantity: 'quantity', merchant: 'shop', order_id: 'order_no', status: 'status_en',
    },
    defaults: { defaultCurrency: 'CNY', defaultMerchant: 'Taobao' },
  },
];

export function detectFormat(headers: string[]): Format {
  return detectLayout(headers)?.format ?? 'generic';
}

function detectLayout(headers: string[]): Layout | null {
  const n = new Set(headers.map(norm));
  return LAYOUTS.find((l) => l.needs.every((h) => n.has(h))) ?? null;
}

/** A currency named in a header such as "unit_price_cny" or "Preis (EUR)". */
function currencyFromHeader(h: string | undefined): string | null {
  const m = h && /(?:^|[\s_(-])([A-Za-z]{3})\)?$/.exec(h.trim());
  const c = m?.[1]?.toUpperCase();
  return c && ['EUR', 'USD', 'CNY', 'GBP', 'CHF', 'JPY', 'RMB'].includes(c) ? (c === 'RMB' ? 'CNY' : c) : null;
}

// Status and category rules, anchored so "partial refund processed" or "one item cancelled" do not close a line.
const CANCELLED = /^\s*(cancel+ed|storniert|abgebrochen|closed \(cancel|交易关闭)/i;
const RETURNED = /(^|;\s*)(refunded|erstattet|rücksendung abgeschlossen|returned|zurückgesendet)\b/i;
const NOT_GOODS_STATUS = /top-?up|充值/i;
const NOT_GOODS_CATEGORY = /digital|app ?store|subscription|abo\b|lottery|lotto|ticket|travel|reise|utility|money sent|donation|spende|contract|vertrag|top-?up/i;

export function autoCloseFor(status: string, category: string): AutoClose | null {
  if (category && NOT_GOODS_CATEGORY.test(category)) return { possession: 'ignored', rule: 'not_goods' };
  if (status && NOT_GOODS_STATUS.test(status)) return { possession: 'ignored', rule: 'not_goods' };
  if (status && CANCELLED.test(status)) return { possession: 'ignored', rule: 'cancelled' };
  if (status && RETURNED.test(status)) return { possession: 'gone', reason: 'returned', rule: 'returned' };
  return null;
}

/** Order numbers this long are taken as unique across shops and files. */
const orderKey = (id: string) => {
  const n = id.toLowerCase().replace(/[^a-z0-9]/g, '');
  return n.length >= 6 ? n : null;
};

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 40);

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
  const layout = detectLayout(headers);
  const format = layout?.format ?? 'generic';
  const source: PurchaseSource = layout?.source ?? 'csv';
  const mapping: Mapping = opts.mapping ?? (layout ? resolve(headers, layout.mapping) : guessMapping(headers));
  opts = { ...layout?.defaults, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined && v !== '')) };
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
  const headerCurrency = currencyFromHeader(mapping.amount) ?? currencyFromHeader(mapping.unit_price);
  const defaultCurrency = headerCurrency ?? (opts.defaultCurrency && isCurrencyCode(opts.defaultCurrency) ? opts.defaultCurrency : null);
  const purchases = new Map<string, ParsedPurchase>();
  const seen = new Map<string, number>(); // per purchase + product: occurrences so far

  rows.forEach((r, n) => {
    const row = n + 1;
    const variant = get(r, 'variant').replace(/\s+/g, ' ');
    const withVariant = (t: string) => (t && variant ? `${t} · ${variant}` : t);
    const title = withVariant(get(r, 'title').replace(/\s+/g, ' '));
    const translated = withVariant(get(r, 'title_translated').replace(/\s+/g, ' ')) || null;
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
    const autoClose = autoCloseFor(get(r, 'status'), get(r, 'category'));
    const raw = rawAmount || rawUnit;
    if (raw && amount === null && !autoClose && !/not available|n\/a|^-+$/i.test(raw)) {
      errors.push({
        row,
        message: !currency
          ? 'price without a currency (set a default currency)'
          : /^\s*[-(]/.test(raw)
            ? 'negative amount (refund or credit): imported without a price'
            : `price not understood: "${raw.slice(0, 30)}"`,
      });
    }

    const merchant = get(r, 'merchant') || opts.defaultMerchant?.trim() || null;
    const orderId = get(r, 'order_id') || null;
    const productId = get(r, 'product_id') || null;
    // Purchases with a real order number get the same key from every file and source, so the
    // same order exported twice (privacy export and order pages, shop mail and PayPal) is one purchase.
    const oKey = orderId ? orderKey(orderId) : null;
    const pKey = hash(oKey ? `order|${oKey}` : [source, (merchant ?? '').toLowerCase(), orderId ? `id:${orderId}` : `date:${orderedAt ?? ''}`].join('|'));
    let p = purchases.get(pKey);
    if (!p) {
      p = { source, merchant, externalOrderId: orderId, orderedAt, currency, totalMinor: null, dedupeKey: pKey, orderKeyed: !!oKey, lines: [] };
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
      titleTranslated: translated ? translated.slice(0, 1000) : null,
      quantity,
      unitPriceMinor: unit,
      amountMinor: amount,
      currency: amount !== null ? currency : null,
      externalProductId: productId,
      url: url && /^https?:\/\//i.test(url) ? url.slice(0, 2000) : null,
      autoClose,
      dedupeKey: hash(`${base}|${occurrence}`),
    });
  });

  for (const p of purchases.values()) {
    const priced = p.lines.filter((l) => l.amountMinor !== null && l.autoClose?.rule !== 'cancelled');
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
