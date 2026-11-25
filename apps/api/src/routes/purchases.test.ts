import { readFileSync } from 'node:fs';
import yazl from 'yazl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from '../testing';

const amazonCsv = readFileSync(new URL('../../../../packages/importers/fixtures/amazon-order-history.csv', import.meta.url));

function form(file: { name: string; data: Buffer }, fields: Record<string, string> = {}) {
  const b = '----pqtest' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  parts.push(file.data, Buffer.from(`\r\n--${b}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}

function zip(entries: Record<string, Buffer>): Promise<Buffer> {
  const z = new yazl.ZipFile();
  for (const [name, data] of Object.entries(entries)) z.addBuffer(data, name);
  z.end();
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    z.outputStream.on('data', (c: Buffer) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
  });
}

describe('imports, possession check and spending', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());

  const post = (url: string, f: ReturnType<typeof form>) => t.app.inject({ method: 'POST', url, payload: f.payload, headers: f.headers });

  it('previews an Amazon zip without saving anything', async () => {
    const data = await zip({ 'Retail.OrderHistory.1/Retail.OrderHistory.1.csv': amazonCsv, 'Other/Something.csv': Buffer.from('a,b\n1,2') });
    const res = await post('/api/v1/imports/preview', form({ name: 'Your Orders.zip', data }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      format: 'amazon_order_history', files: ['Retail.OrderHistory.1/Retail.OrderHistory.1.csv'], line_count: 5, purchase_count: 3, error_count: 0,
      currencies: ['EUR', 'USD'],
    });
    expect(JSON.stringify(res.json())).not.toMatch(/Teststr|Visa/);
    const lines = await t.app.inject({ url: '/api/v1/possession?status=all' });
    expect(lines.json().total).toBe(0);
  });

  it('imports twice without duplicates and fetches rates for foreign currencies', async () => {
    const first = await post('/api/v1/imports', form({ name: 'Retail.OrderHistory.1.csv', data: amazonCsv }));
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ source: 'amazon_export', lines_added: 5, lines_auto_closed: 1 });
    const again = await post('/api/v1/imports', form({ name: 'Retail.OrderHistory.1.csv', data: amazonCsv }));
    expect(again.json()).toMatchObject({ lines_added: 0, lines_existing: 5 });
    await new Promise((r) => setTimeout(r, 50)); // the rate refresh runs in the background
    const q = (await t.app.inject({ url: '/api/v1/possession' })).json();
    expect(q.total).toBe(4);
    expect(q.lines[0]).toMatchObject({ title: 'Cordless drill, 18 V, with "two" batteries', amount_eur_minor: 12999, url: 'https://www.amazon.de/dp/B000TEST01' });
    expect(q.lines.find((l: { currency: string }) => l.currency === 'USD').amount_eur_minor).toBe(1960); // 24.50 / 1.25
    const runs = (await t.app.inject({ url: '/api/v1/imports' })).json();
    expect(runs).toHaveLength(2);
  });

  it('imports a generic CSV with a mapping and defaults', async () => {
    const csv = Buffer.from('when;what;cost\n01.06.2020;Garden chair;39,00\n01.06.2020;Plant pot;-4');
    const res = await post('/api/v1/imports', form({ name: 'shop.csv', data: csv }, {
      mapping: JSON.stringify({ date: 'when', title: 'what', amount: 'cost' }), default_currency: 'EUR', default_merchant: 'Example Garden',
    }));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ source: 'csv', lines_added: 2 });
    const bad = await post('/api/v1/imports', form({ name: 'x.csv', data: csv }, { mapping: '{"nope":"when"}' }));
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/unknown mapping field/);
  });

  it('triages: have it, used up, gone with reason, undo, bulk', async () => {
    const q = (await t.app.inject({ url: '/api/v1/possession?q=drill' })).json();
    const drill = q.lines[0];
    const owned = await t.app.inject({ method: 'POST', url: `/api/v1/possession/${drill.id}`, payload: { status: 'owned' } });
    expect(owned.json()).toMatchObject({ status: 'owned', item_name: 'Cordless drill, 18 V, with "two" batteries' });
    const item = (await t.app.inject({ url: `/api/v1/items/${owned.json().item_id}` })).json();
    expect(item).toMatchObject({ price_amount_minor: 12999, price_currency: 'EUR', acquired_at: '2019-03-12' });

    const batteries = (await t.app.inject({ url: '/api/v1/possession?q=batteries' })).json().lines;
    for (const b of batteries) {
      const r = await t.app.inject({ method: 'POST', url: `/api/v1/possession/${b.id}`, payload: { status: 'gone', gone_reason: 'consumed' } });
      expect(r.json()).toMatchObject({ status: 'gone', reason: 'consumed' });
    }
    const pack = (await t.app.inject({ url: '/api/v1/possession?q=backpack' })).json().lines[0];
    await t.app.inject({ method: 'POST', url: `/api/v1/possession/${pack.id}`, payload: { status: 'gone' } });
    const withReason = await t.app.inject({ method: 'POST', url: `/api/v1/possession/${pack.id}`, payload: { status: 'gone', gone_reason: 'sold' } });
    expect(withReason.json().reason).toBe('sold');
    const conflict = await t.app.inject({ method: 'POST', url: `/api/v1/possession/${pack.id}`, payload: { status: 'owned' } });
    expect(conflict.statusCode).toBe(409);
    const undo = await t.app.inject({ method: 'POST', url: `/api/v1/possession/${pack.id}/reset` });
    expect(undo.json().status).toBe('pending');
    await t.app.inject({ method: 'POST', url: `/api/v1/possession/${pack.id}`, payload: { status: 'gone', gone_reason: 'given_away' } });

    const bulk = await t.app.inject({ method: 'POST', url: '/api/v1/possession/bulk', payload: { merchant: 'Example Garden', status: 'ignored' } });
    expect(bulk.json()).toEqual({ updated: 2 });
    expect((await t.app.inject({ url: '/api/v1/possession' })).json().total).toBe(0);
  });

  it('reports what was spent on things no longer owned, apart from consumables', async () => {
    // The drill is sold later from the item screen: the report follows.
    const drill = (await t.app.inject({ url: '/api/v1/possession?status=owned' })).json().lines[0];
    await t.app.inject({ method: 'POST', url: `/api/v1/items/${drill.item_id}/state`, payload: { state: 'sold' } });
    const r = (await t.app.inject({ url: '/api/v1/reports/spending' })).json();
    expect(r.totals.gone).toEqual({ count: 2, eur_minor: 12999 + 1960 });
    expect(r.totals.used_up).toEqual({ count: 2, eur_minor: 1898 + 949 });
    expect(r.totals.owned.count).toBe(0);
    expect(r.coverage).toBe(1);
    expect(r.by_year.map((y: { year: number }) => y.year)).toEqual([2023, 2021, 2020, 2019]);
    expect(r.top_gone.map((l: { reason: string }) => l.reason)).toEqual(['sold', 'given_away']);
    expect(r.fx).toEqual({ latest_day: '2020-01-02', currencies: 1 });
    const facets = (await t.app.inject({ url: '/api/v1/possession/facets' })).json();
    expect(facets.merchants).toEqual(['Amazon.com', 'Amazon.de', 'Example Garden']);
  });

  it('lists likely consumables from a date on, takes "not a consumable", marks selected lines', async () => {
    const csv = Buffer.from('Date,Title,Price,Currency,Shop\n2025-02-01,Espresso beans 1 kg,19.90,EUR,Example Roastery\n2025-02-01,Dish soap 3x,6.00,EUR,Example Roastery\n2025-02-01,Toothpaste 75ml,3.00,EUR,Example Roastery\n2025-02-01,Coffee grinder,89.00,EUR,Example Roastery\n');
    expect((await post('/api/v1/imports', form({ name: 'roastery.csv', data: csv }))).statusCode).toBe(201);
    const list = async () => (await t.app.inject({ url: '/api/v1/possession?suggested=consumable&from_date=2025-01-01&sort=date' })).json();
    let page = await list();
    expect(page.lines.map((l: { title: string }) => l.title).sort()).toEqual(['Espresso beans 1 kg', 'Toothpaste 75ml']);
    const tooth = page.lines.find((l: { title: string }) => l.title.startsWith('Tooth'));
    expect(tooth.suggested_kind).toBe('supplies');
    const rej = await t.app.inject({ method: 'POST', url: `/api/v1/possession/${tooth.id}/suggestion`, payload: { rejected: true } });
    expect(rej.json().suggestion_rejected).toBe(true);
    page = await list();
    expect(page.total).toBe(1);
    const bulk = await t.app.inject({ method: 'POST', url: '/api/v1/possession/bulk', payload: { ids: [page.lines[0].id], status: 'gone', gone_reason: 'consumed' } });
    expect(bulk.json()).toEqual({ updated: 1 });
    expect((await list()).total).toBe(0);
  });
});
