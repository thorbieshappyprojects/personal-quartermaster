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
  close: () => Promise<void>;
}

export async function createTestApp(
  auth: AuthConfig = { mode: 'dev', email: 'owner@example.test' },
  extra: Partial<Parameters<typeof buildApp>[0]> = {},
): Promise<TestContext> {
  const db = await createTestDatabase();
  await migrate(db.pool, sourceMigrationsDir);
  const mediaDir = await mkdtemp(join(tmpdir(), 'pq-media-'));
  const config: Config = {
    production: false,
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    databaseUrl: db.url,
    mediaDir,
    migrationsDir: sourceMigrationsDir,
    webDir: null,
    auth,
  };
  const diskStats = async () => ({ blocks: 100, bavail: 50 });
  const app = await buildApp({ config, pool: db.pool, diskStats, ...extra }, { logger: false });
  return {
    app,
    pool: db.pool,
    mediaDir,
    close: async () => {
      await app.close();
      await db.drop();
      await rm(mediaDir, { recursive: true, force: true });
    },
  };
}
