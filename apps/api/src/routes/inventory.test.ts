import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestContext } from '../testing';

describe('inventory API', () => {
  let t: TestContext;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());

  const req = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
    const res = await t.app.inject({ method, url, payload: payload as object });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };

  it('builds a location tree', async () => {
    const flat = await req('POST', '/api/v1/locations', { kind: 'site', name: 'Flat' });
    expect(flat.status).toBe(201);
    ids.flat = flat.body.id;
    ids.hall = (await req('POST', '/api/v1/locations', { parent_id: ids.flat, kind: 'room', name: 'Hall' })).body.id;
    ids.cellar = (await req('POST', '/api/v1/locations', { parent_id: ids.flat, kind: 'room', name: 'Cellar' })).body.id;
    ids.shelf = (await req('POST', '/api/v1/locations', { parent_id: ids.cellar, kind: 'spot', name: 'Shelf 2' })).body.id;
    const bad = await req('POST', '/api/v1/locations', { parent_id: ids.shelf, kind: 'room', name: 'Nope' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid');
    const dup = await req('POST', '/api/v1/locations', { parent_id: ids.flat, kind: 'room', name: 'hall' });
    expect(dup.status).toBe(409);
    const list = await req('GET', '/api/v1/locations');
    expect(list.body).toHaveLength(4);
  });

  it('creates, reads and updates an item', async () => {
    const cats = (await req('GET', '/api/v1/categories')).body as { id: string; name: string }[];
    ids.camping = cats.find((c) => c.name === 'Camping')!.id;
    const created = await req('POST', '/api/v1/items', {
      name: 'Camping stove',
      category_id: ids.camping,
      location_id: ids.hall,
      price_amount_minor: 4999,
      price_currency: 'EUR',
      acquired_at: '2025-06-01',
      attributes: { brand: 'Primus' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ kind: 'durable', location_path: ['Flat', 'Hall'], category_path: ['Sport & outdoor', 'Camping'], photos: [] });
    ids.stove = created.body.id;
    const patched = await req('PATCH', `/api/v1/items/${ids.stove}`, { notes: 'needs a new gas cartridge', tags: ['gas'] });
    expect(patched.body).toMatchObject({ notes: 'needs a new gas cartridge', tags: ['gas'] });
    expect((await req('GET', `/api/v1/items/${ids.stove}`)).body.name).toBe('Camping stove');
  });

  it('validates input at the edge', async () => {
    expect((await req('POST', '/api/v1/items', { name: '' })).status).toBe(400);
    expect((await req('POST', '/api/v1/items', { name: 'X', price_currency: 'eur', price_amount_minor: 1 })).status).toBe(400);
    expect((await req('POST', '/api/v1/items', { name: 'X', purchase_url: 'javascript:alert(1)' })).status).toBe(400);
    expect((await req('POST', '/api/v1/items', { name: 'X', price_amount_minor: 100 })).status).toBe(400);
    expect((await req('POST', '/api/v1/items', { name: 'X', unknown_field: 1 })).status).toBe(400);
    expect((await req('GET', '/api/v1/items/not-a-uuid')).status).toBe(400);
    expect((await req('GET', '/api/v1/items/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('answers "do we have X?" in one sentence', async () => {
    const yes = await req('GET', '/api/v1/find?q=' + encodeURIComponent('Do we have a camping stove?'));
    expect(yes.body.terms).toBe('camping stove');
    expect(yes.body.answer).toBe('Yes: Camping stove (Flat › Hall). Last acquired 2025-06-01.');
    expect(yes.body.items).toHaveLength(1);
    const no = await req('GET', '/api/v1/find?q=' + encodeURIComponent('do we have a kayak?'));
    expect(no.body.answer).toBe('Nothing found for "kayak".');
  });

  it('moves items singly and in bulk, and changes state', async () => {
    const moved = await req('POST', `/api/v1/items/${ids.stove}/move`, { location_id: ids.shelf });
    expect(moved.body.location_path).toEqual(['Flat', 'Cellar', 'Shelf 2']);
    const second = await req('POST', '/api/v1/items', { name: 'Tent', location_id: ids.hall });
    const bulk = await req('POST', '/api/v1/items/move', { item_ids: [ids.stove, second.body.id], location_id: ids.hall });
    expect(bulk.body).toEqual({ moved: 1 }); // the tent was already in the hall
    const sold = await req('POST', `/api/v1/items/${second.body.id}/state`, { state: 'sold' });
    expect(sold.body.state).toBe('sold');
    const active = await req('GET', `/api/v1/items?location_id=${ids.flat}&state=active`);
    expect(active.body.items.map((i: { name: string }) => i.name)).toEqual(['Camping stove']);
    const hall = await req('GET', `/api/v1/items?location_id=${ids.hall}`);
    expect(hall.body.total).toBe(2);
  });

  it('exposes the history of an item', async () => {
    const ev = await req('GET', `/api/v1/events?entity=item&entity_id=${ids.stove}`);
    expect(ev.body.map((e: { type: string }) => e.type)).toEqual(['item.moved', 'item.moved', 'item.updated', 'item.created']);
    expect(ev.body[0].actor_name).toBe('Owner');
  });

  it('refuses to delete places that are in use', async () => {
    expect((await req('DELETE', `/api/v1/locations/${ids.hall}`)).status).toBe(409);
    expect((await req('DELETE', `/api/v1/categories/${ids.camping}`)).status).toBe(409);
    expect((await req('DELETE', `/api/v1/locations/${ids.shelf}`)).status).toBe(204);
    expect((await req('DELETE', `/api/v1/items/${ids.stove}`)).status).toBe(204);
    expect((await req('GET', `/api/v1/items/${ids.stove}`)).status).toBe(404);
  });

  it('documents the routes in OpenAPI', async () => {
    const doc = (await req('GET', '/api/v1/openapi.json')).body;
    for (const p of ['/api/v1/items', '/api/v1/items/{id}/move', '/api/v1/find', '/api/v1/locations', '/api/v1/events']) {
      expect(doc.paths[p], p).toBeDefined();
    }
  });
});
