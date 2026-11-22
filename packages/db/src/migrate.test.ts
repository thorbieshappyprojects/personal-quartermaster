import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, sourceMigrationsDir, type Pool } from './index';
import { createTestDatabase } from './testing';

describe('migrate', () => {
  let pool: Pool;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    ({ pool, drop } = await createTestDatabase());
  });
  afterAll(async () => drop());

  it('applies the shipped migrations once and is idempotent', async () => {
    const first = await migrate(pool, sourceMigrationsDir);
    expect(first.applied).toContain('0001_household_members.sql');
    const second = await migrate(pool, sourceMigrationsDir);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toBe(first.applied.length);

    const { rows } = await pool.query("SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'");
    expect(rows).toHaveLength(1);
  });

  it('enforces the dependant and e-mail constraints', async () => {
    const { rows } = await pool.query<{ id: string }>("INSERT INTO household (name) VALUES ('Test') RETURNING id");
    const hh = rows[0]!.id;
    const m = await pool.query<{ id: string }>(
      "INSERT INTO member (household_id, display_name, email, role) VALUES ($1, 'A', 'a@example.test', 'owner') RETURNING id",
      [hh],
    );
    await expect(
      pool.query("INSERT INTO member (household_id, display_name, email, role) VALUES ($1, 'B', 'A@Example.TEST', 'member')", [hh]),
    ).rejects.toThrow(/member_email_key/);
    await expect(
      pool.query("INSERT INTO person (household_id, display_name, kind, member_id) VALUES ($1, 'Kid', 'dependant', $2)", [hh, m.rows[0]!.id]),
    ).rejects.toThrow(/person_dependant_has_no_member/);
  });

  it('stops on a failing migration and rolls it back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pq-mig-'));
    await writeFile(join(dir, '0001_ok.sql'), 'CREATE TABLE t_ok (x int);');
    await writeFile(join(dir, '0002_bad.sql'), 'CREATE TABLE t_bad (x int); SELECT broken syntax here;');
    const { pool: p2, drop: d2 } = await createTestDatabase();
    try {
      await expect(migrate(p2, dir)).rejects.toThrow(/0002_bad.sql failed/);
      const { rows } = await p2.query("SELECT to_regclass('t_ok') AS ok, to_regclass('t_bad') AS bad");
      expect(rows[0]).toEqual({ ok: 't_ok', bad: null });
    } finally {
      await d2();
    }
  });

  it('refuses when an applied migration was edited', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pq-mig-'));
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE t_a (x int);');
    const { pool: p2, drop: d2 } = await createTestDatabase();
    try {
      await migrate(p2, dir);
      await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE t_a (x bigint);');
      await expect(migrate(p2, dir)).rejects.toThrow(/changed after it was applied/);
    } finally {
      await d2();
    }
  });
});
