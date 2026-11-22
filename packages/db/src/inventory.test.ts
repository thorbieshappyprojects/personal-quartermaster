import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCategory,
  createItem,
  createLocation,
  createMember,
  deleteCategory,
  deleteItem,
  deleteLocation,
  getItem,
  initHousehold,
  listCategories,
  listEvents,
  listItems,
  listLocations,
  migrate,
  moveItems,
  sourceMigrationsDir,
  updateItem,
  updateLocation,
  type Actor,
  type Pool,
} from './index';
import { createTestDatabase } from './testing';

describe('inventory queries', () => {
  let pool: Pool;
  let drop: () => Promise<void>;
  let actor: Actor;
  let other: Actor;
  let flat: string, kitchen: string, drawer: string, cellar: string;

  beforeAll(async () => {
    ({ pool, drop } = await createTestDatabase());
    await migrate(pool, sourceMigrationsDir);
    const { household, owner } = await initHousehold(pool, { name: 'T', ownerEmail: 'o@example.test', ownerName: 'O' });
    actor = { householdId: household.id, memberId: owner.id };
    const m = await createMember(pool, household.id, { email: 'm@example.test', displayName: 'M', role: 'member' });
    other = { householdId: household.id, memberId: m.id };
    flat = (await createLocation(pool, actor, { parentId: null, kind: 'site', name: 'Flat' })).id;
    kitchen = (await createLocation(pool, actor, { parentId: flat, kind: 'room', name: 'Kitchen' })).id;
    drawer = (await createLocation(pool, actor, { parentId: kitchen, kind: 'spot', name: 'Drawer 2' })).id;
    cellar = (await createLocation(pool, actor, { parentId: flat, kind: 'room', name: 'Cellar' })).id;
  });
  afterAll(async () => drop());

  it('validates the location tree and records events', async () => {
    await expect(createLocation(pool, actor, { parentId: drawer, kind: 'room', name: 'X' })).rejects.toThrow(/cannot be placed/);
    await expect(createLocation(pool, actor, { parentId: flat, kind: 'room', name: 'kitchen' })).rejects.toThrow(/sibling/);
    await expect(updateLocation(pool, actor, kitchen, { parentId: drawer })).rejects.toThrow();
    const shelf = await createLocation(pool, actor, { parentId: cellar, kind: 'spot', name: 'Shelf' });
    await updateLocation(pool, actor, shelf.id, { name: 'Shelf 2' });
    const ev = await listEvents(pool, actor.householdId, actor.memberId, { entity: 'location', entityId: shelf.id });
    expect(ev.map((e) => e.type)).toEqual(['location.updated', 'location.created']);
    expect(ev[0]!.before).toEqual({ name: 'Shelf' });
    expect(ev[0]!.actor_name).toBe('O');
  });

  it('creates items with paths, default kind from category and a creation event', async () => {
    const cats = await listCategories(pool, actor.householdId, actor.memberId);
    const batteries = cats.find((c) => c.name === 'Batteries')!;
    const item = await createItem(pool, actor, {
      name: 'AA batteries',
      categoryId: batteries.id,
      locationId: drawer,
      quantity: 6,
      unit: 'pcs',
      tags: ['aa', 'aa', ' '],
      priceAmountMinor: 599,
      priceCurrency: 'EUR',
      acquiredAt: '2026-03-01',
    });
    expect(item).toMatchObject({
      kind: 'supply',
      tags: ['aa'],
      location_path: ['Flat', 'Kitchen', 'Drawer 2'],
      category_path: ['Household supplies', 'Batteries'],
      quantity: 6,
      price_amount_minor: 599,
    });
    const ev = await listEvents(pool, actor.householdId, actor.memberId, { entityId: item.id });
    expect(ev[0]).toMatchObject({ type: 'item.created', after: { name: 'AA batteries', location_id: drawer } });
    await expect(createItem(pool, actor, { name: 'X', priceAmountMinor: 5 })).rejects.toThrow(/both an amount and a currency/);
    await expect(createItem(pool, actor, { name: 'X', locationId: '00000000-0000-4000-8000-000000000000' })).rejects.toThrow(/location not found/);
  });

  it('searches by prefix, fuzzy spelling, alias, tag, brand and category', async () => {
    const tools = (await listCategories(pool, actor.householdId, actor.memberId)).find((c) => c.name === 'Power tools')!;
    await createItem(pool, actor, { name: 'Kreissäge', aliases: ['circular saw'], attributes: { brand: 'Bosch' }, categoryId: tools.id, locationId: cellar });
    await createItem(pool, actor, { name: 'Camping stove', tags: ['outdoor'], locationId: cellar });
    const names = async (q: string) => (await listItems(pool, actor.householdId, actor.memberId, { q })).items.map((i) => i.name);
    expect(await names('batt')).toEqual(['AA batteries']);
    expect(await names('kreisage')).toEqual(['Kreissäge']);
    expect(await names('KREISSÄGE')).toEqual(['Kreissäge']);
    expect(await names('circular')).toEqual(['Kreissäge']);
    expect(await names('bosch')).toEqual(['Kreissäge']);
    expect(await names('outdoor')).toEqual(['Camping stove']);
    expect(await names('power tools')).toEqual(['Kreissäge']);
    expect(await names('tools')).toEqual(['Kreissäge']); // "Tools" includes its subcategories
    expect(await names('zzzz')).toEqual([]);
  });

  it('filters by location subtree, state and kind, and pages', async () => {
    const inFlat = await listItems(pool, actor.householdId, actor.memberId, { locationId: flat });
    expect(inFlat.total).toBe(3);
    const inKitchen = await listItems(pool, actor.householdId, actor.memberId, { locationId: kitchen });
    expect(inKitchen.items.map((i) => i.name)).toEqual(['AA batteries']);
    const supplies = await listItems(pool, actor.householdId, actor.memberId, { kind: 'supply' });
    expect(supplies.total).toBe(1);
    const page = await listItems(pool, actor.householdId, actor.memberId, { limit: 1, offset: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  it('moves items in bulk with one event per moved item', async () => {
    const all = (await listItems(pool, actor.householdId, actor.memberId, {})).items;
    const moved = await moveItems(pool, actor, all.map((i) => i.id), cellar);
    expect(moved).toBe(1); // only the batteries were elsewhere
    const bat = all.find((i) => i.name === 'AA batteries')!;
    const ev = await listEvents(pool, actor.householdId, actor.memberId, { entityId: bat.id });
    expect(ev[0]).toMatchObject({ type: 'item.moved', before: { location_id: drawer }, after: { location_id: cellar } });
  });

  it('records only changed fields on update and names the event by what changed', async () => {
    const [bat] = (await listItems(pool, actor.householdId, actor.memberId, { q: 'batteries' })).items;
    await updateItem(pool, actor, bat!.id, { state: 'consumed' });
    await updateItem(pool, actor, bat!.id, { quantity: 4, notes: 'half used' });
    await updateItem(pool, actor, bat!.id, { quantity: 4 }); // no change, no event
    const ev = await listEvents(pool, actor.householdId, actor.memberId, { entityId: bat!.id });
    expect(ev.map((e) => e.type)).toEqual(['item.updated', 'item.state_changed', 'item.moved', 'item.created']);
    expect(ev[0]!.before).toEqual({ quantity: 6, notes: null });
    // Items no longer in the house sort after the ones that are.
    const r = await listItems(pool, actor.householdId, actor.memberId, {});
    expect(r.items.at(-1)!.name).toBe('AA batteries');
  });

  it('hides private items from other members, including their events', async () => {
    const gift = await createItem(pool, actor, { name: 'Secret gift', privateTo: actor.memberId });
    expect((await listItems(pool, other.householdId, other.memberId, { q: 'gift' })).total).toBe(0);
    await expect(getItem(pool, other.householdId, other.memberId, gift.id)).rejects.toThrow(/not found/);
    await expect(updateItem(pool, other, gift.id, { name: 'x' })).rejects.toThrow(/not found/);
    expect(await listEvents(pool, other.householdId, other.memberId, { entityId: gift.id })).toHaveLength(0);
    expect(await listEvents(pool, actor.householdId, actor.memberId, { entityId: gift.id })).toHaveLength(1);
    const locs = await listLocations(pool, other.householdId, other.memberId);
    expect(locs.find((l) => l.id === cellar)!.item_count).toBe(2);
  });

  it('protects locations and categories that are in use; deleting an item keeps its history', async () => {
    await expect(deleteLocation(pool, actor, cellar)).rejects.toThrow(/contains other locations|still has items/);
    await expect(deleteLocation(pool, actor, kitchen)).rejects.toThrow(/contains other locations/);
    await deleteLocation(pool, actor, drawer);
    const custom = await createCategory(pool, actor, { parentId: null, name: 'Board games' });
    await deleteCategory(pool, actor, custom.id);
    const tools = (await listCategories(pool, actor.householdId, actor.memberId)).find((c) => c.name === 'Power tools')!;
    await expect(deleteCategory(pool, actor, tools.id)).rejects.toThrow(/still used/);
    const [stove] = (await listItems(pool, actor.householdId, actor.memberId, { q: 'stove' })).items;
    await deleteItem(pool, actor, stove!.id);
    const ev = await listEvents(pool, actor.householdId, actor.memberId, { entityId: stove!.id });
    expect(ev[0]).toMatchObject({ type: 'item.deleted', before: { name: 'Camping stove' } });
  });
});
