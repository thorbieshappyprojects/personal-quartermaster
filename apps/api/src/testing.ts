import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, sourceMigrationsDir, type Pool } from '@pq/db';
import { createTestDatabase } from '@pq/db/testing';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import type { AuthConfig, Config } from './config';

export interface TestContext {
  app: FastifyInstance;
  pool: Pool;
  mediaDir: string;
  householdId: string;
  ownerId: string;
  close: () => Promise<void>;
}

export async function createTestApp(
  auth: AuthConfig = { mode: 'dev', email: 'owner@example.test' },
  extra: Omit<Partial<Parameters<typeof buildApp>[0]>, 'config' | 'pool'> = {},
  configOverrides: Partial<Config> = {},
): Promise<TestContext> {
  const db = await createTestDatabase();
  await migrate(db.pool, sourceMigrationsDir);
  const hh = await db.pool.query<{ id: string }>("INSERT INTO household (name) VALUES ('Test household') RETURNING id");
  const owner = await db.pool.query<{ id: string }>(
    "INSERT INTO member (household_id, display_name, email, role) VALUES ($1, 'Owner', 'owner@example.test', 'owner') RETURNING id",
    [hh.rows[0]!.id],
  );
  await db.pool.query("INSERT INTO person (household_id, display_name, kind, member_id) VALUES ($1, 'Owner', 'member', $2)", [
    hh.rows[0]!.id,
    owner.rows[0]!.id,
  ]);
  await db.pool.query('SELECT seed_default_categories($1)', [hh.rows[0]!.id]);
  const mediaDir = await mkdtemp(join(tmpdir(), 'pq-media-'));
  const config: Config = {
    production: false,
    host: '127.0.0.1',
    port: 0,
    logLevel: process.env.PQ_TEST_LOG === '1' ? 'debug' : 'silent',
    databaseUrl: db.url,
    mediaDir,
    migrationsDir: sourceMigrationsDir,
    webDir: null,
    auth,
    ...configOverrides,
  };
  const diskStats = async () => ({ blocks: 100, bavail: 50 });
  const app = await buildApp({ config, pool: db.pool, diskStats, ...extra }, { logger: process.env.PQ_TEST_LOG === "1" });
  return {
    app,
    pool: db.pool,
    mediaDir,
    householdId: hh.rows[0]!.id,
    ownerId: owner.rows[0]!.id,
    close: async () => {
      await app.close();
      await db.drop();
      await rm(mediaDir, { recursive: true, force: true });
    },
  };
}
