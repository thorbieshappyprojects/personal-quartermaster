import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bulkDecide,
  decideLine,
  getItem,
  importPurchases,
  initHousehold,
  listLines,
  migrate,
  resetLine,
  sourceMigrationsDir,
  spendingReport,
  updateItem,
  upsertFxRates,
  type Actor,
  type Pool,
  type PurchaseImport,
} from './index';
import { createTestDatabase } from './testing';

const line = (key: string, title: string, amount: number | null, currency = 'EUR', extra: Partial<PurchaseImport['lines'][number]> = {}) => ({
  title, quantity: 1, unitPriceMinor: amount, amountMinor: amount, currency: amount === null ? null : currency,
  externalProductId: null, url: null, cancelled: false, dedupeKey: key, ...extra,
});

const purchases: PurchaseImport[] = [
  {
    source: 'csv', merchant: 'Example Shop', externalOrderId: 'A1', orderedAt: '2019-05-01', currency: 'EUR', totalMinor: 25000, dedupeKey: 'p1',
    lines: [line('l1', 'Cordless drill, 18 V, two batteries, case and a very long description that goes on and on', 15000), line('l2', 'Coffee beans 1 kg', 1500), line('l3', 'Winter jacket', 8500)],
  },
  {
    source: 'csv', merchant: 'Example Shop', externalOrderId: 'A2', orderedAt: '2022-02-02', currency: 'USD', totalMinor: 11000, dedupeKey: 'p2',
    lines: [line('l4', 'Tent', 11000, 'USD'), line('l5', 'Espresso machine', null, 'EUR', { cancelled: true })],
  },
];

describe('purchases and the possession check', () => {
  let pool: Pool;
  let drop: () => Promise<void>;
  let actor: Actor;

  beforeAll(async () => {
    ({ pool, drop } = await createTestDatabase());
    await migrate(pool, sourceMigrationsDir);
    const r = await initHousehold(pool, { name: 'Test', ownerEmail: 'owner@example.test', ownerName: 'Owner' });
    actor = { householdId: r.household.id, memberId: r.owner.id };
  });
  afterAll(async () => drop());

  const run = { source: 'csv', format: 'generic', filename: 'orders.csv', sha256: 'x', rowsRead: 5, errors: [] };

  it('imports idempotently and closes cancelled lines by rule', async () => {
    const first = await importPurchases(pool, actor, run, purchases);
    expect(first).toMatchObject({ purchases_added: 2, lines_added: 5, lines_existing: 0, lines_auto_closed: 1 });
    const again = await importPurchases(pool, actor, run, purchases);
    expect(again).toMatchObject({ purchases_added: 0, lines_added: 0, lines_existing: 5 });
    const pending = await listLines(pool, actor.householdId, actor.memberId, {});
    expect(pending.total).toBe(4);
  });

  it('queues the most expensive first; foreign amounts convert once rates exist', async () => {
    let q = await listLines(pool, actor.householdId, actor.memberId, {});
    expect(q.lines.map((l) => l.title.slice(0, 5))).toEqual(['Cordl', 'Tent', 'Winte', 'Coffe']);
    expect(q.lines[1]!.amount_eur_minor).toBeNull();
    await upsertFxRates(pool, [{ currency: 'USD', day: '2022-02-01', perEur: 1.1 }, { currency: 'USD', day: '2022-03-01', perEur: 2 }]);
    q = await listLines(pool, actor.householdId, actor.memberId, {});
    expect(q.lines[1]).toMatchObject({ title: 'Tent', amount_eur_minor: 10000 }); // rate of the last day before the order
    expect((await listLines(pool, actor.householdId, actor.memberId, { q: 'jacket' })).total).toBe(1);
    expect((await listLines(pool, actor.householdId, actor.memberId, { year: 2019, maxEur: 2000 })).lines.map((l) => l.title)).toEqual(['Coffee beans 1 kg']);
  });

  it('"have it" creates an item; undo removes it while untouched', async () => {
    const q = await listLines(pool, actor.householdId, actor.memberId, {});
    const drill = q.lines[0]!;
    const owned = await decideLine(pool, actor, drill.id, { status: 'owned' });
    expect(owned.status).toBe('owned');
    const item = await getItem(pool, actor.householdId, actor.memberId, owned.item_id!);
    expect(item).toMatchObject({ name: 'Cordless drill, 18 V, two batteries', price_amount_minor: 15000, acquired_at: '2019-05-01' });
    await expect(decideLine(pool, actor, drill.id, { status: 'gone' })).rejects.toThrow(/undo/);
    const reset = await resetLine(pool, actor, drill.id);
    expect(reset).toMatchObject({ status: 'pending', item_id: null });
    await expect(getItem(pool, actor.householdId, actor.memberId, item.id)).rejects.toThrow(/not found/);
  });

  it('keeps an item that was changed since, and follows its later state', async () => {
    const drill = (await listLines(pool, actor.householdId, actor.memberId, {})).lines[0]!;
    const owned = await decideLine(pool, actor, drill.id, { status: 'owned' });
    await updateItem(pool, actor, owned.item_id!, { state: 'sold' });
    await expect(resetLine(pool, actor, drill.id)).rejects.toThrow(/changed since/);
    const after = (await listLines(pool, actor.householdId, actor.memberId, { status: 'gone' })).lines;
    expect(after).toMatchObject([{ id: drill.id, possession: 'owned', status: 'gone', reason: 'sold' }]);
  });

  it('records gone with a reason, used up and ignore; bulk marks the rest', async () => {
    const q = (await listLines(pool, actor.householdId, actor.memberId, {})).lines;
    const tent = q.find((l) => l.title === 'Tent')!;
    await decideLine(pool, actor, tent.id, { status: 'gone' });
    expect((await decideLine(pool, actor, tent.id, { status: 'gone', goneReason: 'given_away' })).reason).toBe('given_away');
    const n = await bulkDecide(pool, actor, { maxEur: 2000 }, { status: 'gone', goneReason: 'consumed' });
    expect(n).toBe(1);
    const events = await pool.query("SELECT count(*)::int AS n FROM event WHERE entity = 'purchase_line'");
    expect(events.rows[0].n).toBeGreaterThanOrEqual(6);
  });

  it('reports spend, with consumables apart from things that are gone', async () => {
    const r = await spendingReport(pool, actor.householdId, actor.memberId);
    expect(r.totals.gone).toEqual({ count: 2, eur_minor: 15000 + 10000 });
    expect(r.totals.used_up).toEqual({ count: 1, eur_minor: 1500 });
    expect(r.totals.pending).toEqual({ count: 1, eur_minor: 8500 });
    expect(r.totals.ignored.count).toBe(1);
    expect(r.coverage).toBeCloseTo(1 - 8500 / 35000);
    expect(r.by_year.map((y) => [y.year, y.gone, y.used_up, y.pending])).toEqual([[2022, 10000, 0, 0], [2019, 15000, 1500, 8500]]);
    expect(r.top_gone.map((l) => l.reason)).toEqual(['sold', 'given_away']);
    expect(r.unconverted.count).toBe(0);
  });
});
