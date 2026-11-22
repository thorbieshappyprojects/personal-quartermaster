import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initHousehold, migrate, sourceMigrationsDir, type Pool } from './index';
import { createTestDatabase } from './testing';

describe('inventory schema', () => {
  let pool: Pool;
  let drop: () => Promise<void>;
  let hh: string;
  let owner: string;

  beforeAll(async () => {
    ({ pool, drop } = await createTestDatabase());
    await migrate(pool, sourceMigrationsDir);
    const r = await initHousehold(pool, { name: 'Test', ownerEmail: 'owner@example.test', ownerName: 'Owner' });
    hh = r.household.id;
    owner = r.owner.id;
  });
  afterAll(async () => drop());

  it('seeds the default category tree for new households, idempotently', async () => {
    const before = await pool.query('SELECT count(*)::int AS n FROM category WHERE household_id = $1', [hh]);
    expect(before.rows[0].n).toBeGreaterThan(30);
    await pool.query('SELECT seed_default_categories($1)', [hh]);
    const after = await pool.query('SELECT count(*)::int AS n FROM category WHERE household_id = $1', [hh]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const sub = await pool.query(
      "SELECT c.default_kind FROM category c JOIN category p ON p.id = c.parent_id WHERE p.name = 'Household supplies' AND c.name = 'Batteries'",
    );
    expect(sub.rows[0].default_kind).toBe('supply');
  });

  it('maintains search text with accents removed and finds fuzzy matches', async () => {
    await pool.query(
      "INSERT INTO item (household_id, kind, name, aliases, tags, attributes) VALUES ($1, 'durable', 'Kreissäge', '{circular saw}', '{werkstatt}', '{\"brand\":\"Bosch\"}')",
      [hh],
    );
    const { rows } = await pool.query('SELECT search_text FROM item WHERE household_id = $1', [hh]);
    expect(rows[0].search_text).toBe('kreissage circular saw werkstatt bosch ');
    const fuzzy = await pool.query("SELECT name FROM item WHERE 'kreisage' <% search_text");
    expect(fuzzy.rows).toHaveLength(1);
    const word = await pool.query("SELECT name FROM item WHERE search @@ to_tsquery('simple', 'bosch')");
    expect(word.rows).toHaveLength(1);
  });

  it('returns numbers for numeric and bigint, and plain strings for dates', async () => {
    const { rows } = await pool.query(
      "INSERT INTO item (household_id, kind, name, quantity, price_amount_minor, price_currency, acquired_at) VALUES ($1, 'supply', 'AA', 2.5, 1999, 'EUR', '2026-03-01') RETURNING quantity, price_amount_minor, acquired_at",
      [hh],
    );
    expect(rows[0]).toEqual({ quantity: 2.5, price_amount_minor: 1999, acquired_at: '2026-03-01' });
  });

  it('enforces the location tree shape', async () => {
    await expect(pool.query("INSERT INTO location (household_id, kind, name) VALUES ($1, 'room', 'Loose room')", [hh])).rejects.toThrow(
      /location_site_is_root/,
    );
    const site = await pool.query("INSERT INTO location (household_id, kind, name) VALUES ($1, 'site', 'Flat') RETURNING id", [hh]);
    await expect(pool.query("INSERT INTO location (household_id, kind, name) VALUES ($1, 'site', 'flat')", [hh])).rejects.toThrow(
      /location_sibling_name_key/,
    );
    await pool.query("INSERT INTO location (household_id, parent_id, kind, name) VALUES ($1, $2, 'room', 'Kitchen')", [hh, site.rows[0].id]);
  });

  it('keeps the event log append-only, except for marking an event undone once', async () => {
    const e = await pool.query(
      "INSERT INTO event (household_id, actor_member_id, type, entity, entity_id, after) VALUES ($1, $2, 'item.created', 'item', gen_random_uuid(), '{}') RETURNING id",
      [hh, owner],
    );
    const id = e.rows[0].id;
    await expect(pool.query("UPDATE event SET type = 'x' WHERE id = $1", [id])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM event WHERE id = $1', [id])).rejects.toThrow(/append-only/);
    const u = await pool.query(
      "INSERT INTO event (household_id, type, entity, entity_id, undoes) VALUES ($1, 'item.undo', 'item', gen_random_uuid(), $2) RETURNING id",
      [hh, id],
    );
    await pool.query('UPDATE event SET undone_by = $2 WHERE id = $1', [id, u.rows[0].id]);
    await expect(pool.query('UPDATE event SET undone_by = $2 WHERE id = $1', [id, u.rows[0].id])).rejects.toThrow(/append-only/);
  });
});
