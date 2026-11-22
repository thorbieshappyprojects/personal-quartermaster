import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createPool } from './pool';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:54329/postgres';

/** Creates a fresh, uniquely named database for one test file and returns a pool plus a cleanup. */
export async function createTestDatabase(): Promise<{ url: string; pool: pg.Pool; drop: () => Promise<void> }> {
  const name = `pq_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString(), 4);
  return {
    url: url.toString(),
    pool,
    drop: async () => {
      await pool.end();
      const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
