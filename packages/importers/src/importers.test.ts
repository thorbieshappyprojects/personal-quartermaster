import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { autoCloseFor, decodeText, detectDateOrder, guessMapping, parseCsv, parseDate, parseMoney, parseOrders } from './index';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

describe('csv', () => {
  it('handles quotes, doubled quotes, newlines, BOM and delimiters', () => {
    expect(parseCsv('﻿a,b\n"x, y","say ""hi"""\r\n"multi\nline",2\n\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['multi\nline', '2'],
    ]);
    expect(parseCsv('a;b\n1,5;2')).toEqual([['a', 'b'], ['1,5', '2']]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('decodes UTF-8 and falls back to Windows-1252', () => {
    expect(decodeText(new Uint8Array([0x4d, 0xc3, 0xbc]))).toBe('Mü');
    expect(decodeText(new Uint8Array([0x4d, 0xfc]))).toBe('Mü');
  });
});

describe('values', () => {
  it('parses dates in the common shapes', () => {
    expect(parseDate('2019-03-12T10:22:33Z')).toBe('2019-03-12');
    expect(parseDate('2021-11-30 18:01:00 UTC')).toBe('2021-11-30');
    expect(parseDate('24.12.2020')).toBe('2020-12-24');
    expect(parseDate('03/04/21', 'mdy')).toBe('2021-03-04');
    expect(parseDate('31.02.2020')).toBeNull();
    expect(parseDate('yesterday')).toBeNull();
    expect(detectDateOrder(['01/02/2020', '12/25/2020'])).toBe('mdy');
    expect(detectDateOrder(['01/02/2020'])).toBe('dmy');
  });
  it('parses money with symbols and codes, refuses refunds', () => {
    expect(parseMoney('89,90 €', 'EUR')).toBe(8990);
    expect(parseMoney('EUR 1.234,50', 'EUR')).toBe(123450);
    expect(parseMoney('¥35.00', 'CNY')).toBe(3500);
    expect(parseMoney('24.5', 'USD')).toBe(2450);
    expect(parseMoney('-5.00', 'EUR')).toBeNull();
    expect(parseMoney('Not Available', 'EUR')).toBeNull();
  });
});

describe('Amazon order history', () => {
  const r = parseOrders(fixture('amazon-order-history.csv'));

  it('is detected and grouped by order', () => {
    expect(r.format).toBe('amazon_order_history');
    expect(r.source).toBe('amazon_export');
    expect(r.purchases).toHaveLength(3);
    expect(r.lineCount).toBe(5);
    expect(r.errors).toEqual([]);
  });

  it('keeps amounts, currency, dates and builds product links', () => {
    const [first, cancelled, us] = r.purchases;
    expect(first!.orderedAt).toBe('2019-03-12');
    expect(first!.merchant).toBe('Amazon.de');
    expect(first!.totalMinor).toBe(12999 + 1898 + 949);
    expect(first!.lines[0]).toMatchObject({
      title: 'Cordless drill, 18 V, with "two" batteries',
      amountMinor: 12999,
      currency: 'EUR',
      externalProductId: 'B000TEST01',
      url: 'https://www.amazon.de/dp/B000TEST01',
    });
    expect(first!.lines[1]).toMatchObject({ quantity: 2, unitPriceMinor: 949, amountMinor: 1898 });
    expect(cancelled!.lines[0]).toMatchObject({ autoClose: { possession: 'ignored', rule: 'cancelled' }, amountMinor: null });
    expect(us!.lines[0]).toMatchObject({ currency: 'USD', amountMinor: 2450 });
  });

  it('gives the same ASIN twice in one order distinct, stable keys', () => {
    const [, b1, b2] = r.purchases[0]!.lines;
    expect(b1!.dedupeKey).not.toBe(b2!.dedupeKey);
    const again = parseOrders(fixture('amazon-order-history.csv'));
    expect(again.purchases.flatMap((p) => p.lines.map((l) => l.dedupeKey))).toEqual(r.purchases.flatMap((p) => p.lines.map((l) => l.dedupeKey)));
  });

  it('never carries addresses or payment details', () => {
    expect(JSON.stringify(r.purchases)).not.toMatch(/Teststr|Visa|Test Person/);
  });
});

describe('generic CSV', () => {
  it('guesses German headers, unit prices and day-first dates', () => {
    const r = parseOrders(fixture('generic-semicolon.csv'));
    expect(r.format).toBe('generic');
    expect(r.mapping).toMatchObject({ date: 'Datum', title: 'Artikel', quantity: 'Menge', unit_price: 'Preis', merchant: 'Shop', order_id: 'Bestellnummer' });
    expect(r.purchases).toHaveLength(3);
    const jacket = r.purchases[0]!;
    expect(jacket.orderedAt).toBe('2020-12-24');
    expect(jacket.lines.map((l) => l.amountMinor)).toEqual([8990, 2500]);
    expect(r.purchases[1]!.lines[0]).toMatchObject({ title: 'Kaffeebohnen 1 kg', quantity: 3, amountMinor: 4497 });
    expect(r.errors).toEqual([{ row: 4, message: 'date not understood: "05.13.2021" (imported without a date)' }]);
  });

  it('uses defaults and an explicit mapping', () => {
    const csv = 'when,what,cost\n2022-05-01,Desk lamp,19.99\n2022-05-01,Bulb,3';
    const r = parseOrders(csv, { mapping: { date: 'when', title: 'what', amount: 'cost' }, defaultCurrency: 'EUR', defaultMerchant: 'Example Store' });
    expect(r.purchases).toHaveLength(1);
    expect(r.purchases[0]).toMatchObject({ merchant: 'Example Store', totalMinor: 2299, currency: 'EUR' });
  });

  it('reports a price without currency and a missing title column', () => {
    expect(parseOrders('Title,Total\nThing,5.00').errors).toEqual([{ row: 1, message: 'price without a currency (set a default currency)' }]);
    expect(parseOrders('foo,bar\n1,2').errors[0]!.message).toMatch(/title/);
    expect(guessMapping(['Order Date', 'Title', 'ASIN/ISBN', 'Purchase Price Per Unit', 'Item Total'])).toMatchObject({
      title: 'Title', product_id: 'ASIN/ISBN', unit_price: 'Purchase Price Per Unit', amount: 'Item Total',
    });
  });
});

describe('known layouts and closing rules', () => {
  it('reads Amazon order-page lists: digital, returned and cancelled lines close themselves', () => {
    const r = parseOrders(fixture('amazon-order-pages.csv'));
    expect(r.format).toBe('amazon_order_pages');
    expect(r.mapping.merchant).toBeUndefined(); // the marketplace seller is not the shop
    const lines = r.purchases.flatMap((p) => p.lines);
    expect(lines.map((l) => [l.title, l.amountMinor, l.autoClose?.rule ?? null])).toEqual([
      ['Bread knife', 4999, null],
      ['Cutting board', 1499, 'returned'],
      ['Some e-book', 999, 'not_goods'],
      ['Kettle', 2999, 'cancelled'],
    ]);
    expect(lines[1]!.autoClose).toEqual({ possession: 'gone', reason: 'returned', rule: 'returned' });
    expect(r.purchases[0]!.merchant).toBe('Amazon');
    expect(JSON.stringify(r.purchases)).not.toMatch(/Teststr|Visa|Test Person/);
  });

  it('reads Taobao lists: original title, English with variant, CNY from the header', () => {
    const r = parseOrders(fixture('taobao-orders.csv'));
    expect(r.format).toBe('taobao_orders');
    expect(r.source).toBe('taobao');
    const [cup, brush] = r.purchases[0]!.lines;
    expect(cup).toMatchObject({ title: '保温杯 · Colour: black', titleTranslated: 'Thermos cup · Colour: black', currency: 'CNY', quantity: 2, amountMinor: 11800 });
    expect(brush!.titleTranslated).toBe('Cup brush');
    expect(r.purchases[1]!.lines[0]!.autoClose?.rule).toBe('cancelled');
    expect(r.purchases[2]!.lines[0]!.autoClose?.rule).toBe('not_goods');
  });

  it('closes only on clear statuses', () => {
    expect(autoCloseFor('Delivered / invoiced (01.02.2025); partial refund processed', '')).toBeNull();
    expect(autoCloseFor('Partial delivery shipped; undeliverable items cancelled', '')).toBeNull();
    expect(autoCloseFor('Delivered; refunded (03.02.2025)', '')?.rule).toBe('returned');
    expect(autoCloseFor('refunded (credit note)', '')?.rule).toBe('returned');
    expect(autoCloseFor('Erstattet', '')?.rule).toBe('returned');
    expect(autoCloseFor('cancelled', '')?.rule).toBe('cancelled');
    expect(autoCloseFor('paid', 'app store')?.rule).toBe('not_goods');
    expect(autoCloseFor('paid', 'paypal money sent')?.rule).toBe('not_goods');
    expect(autoCloseFor('paid', 'paypal receipt')).toBeNull();
    expect(autoCloseFor('paid', 'shop')).toBeNull();
  });

  it('gives the same order the same key in different files and layouts', () => {
    const a = parseOrders('order_number,item,shop,unit_price,currency\nD01-2222222-0000002,E-book (mail),Example Books,9.99,EUR');
    const b = parseOrders(fixture('amazon-order-pages.csv'));
    expect(b.purchases.map((p) => p.dedupeKey)).toContain(a.purchases[0]!.dedupeKey);
    const short = parseOrders('order_number,item,shop\n123,Thing,Shop A\n123,Thing,Shop B');
    expect(short.purchases).toHaveLength(2); // short numbers are not trusted across shops
  });
});
