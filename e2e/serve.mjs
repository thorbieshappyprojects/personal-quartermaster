// Starts the built server for the Playwright smoke test against a fresh database.
import { spawn, spawnSync } from 'node:child_process';
import pg from 'pg';

const base = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:54329/postgres';
const admin = new pg.Client({ connectionString: base });
await admin.connect();
await admin.query('DROP DATABASE IF EXISTS pq_e2e WITH (FORCE)');
await admin.query('CREATE DATABASE pq_e2e');
await admin.end();
const url = new URL(base);
url.pathname = '/pq_e2e';

const env = {
  ...process.env,
  NODE_ENV: 'test',
  DEV_AUTH: '1',
  DEV_AUTH_EMAIL: 'owner@example.test',
  DATABASE_URL: url.toString(),
  MIGRATIONS_DIR: 'apps/api/dist/migrations',
  WEB_DIR: 'apps/web/dist',
  MEDIA_DIR: process.env.E2E_MEDIA_DIR ?? 'test-results/media',
  PORT: '3100',
  LOG_LEVEL: 'warn',
};
spawnSync('mkdir', ['-p', env.MEDIA_DIR]);
const init = spawnSync('node', ['apps/api/dist/cli.mjs', 'init', '--household', 'Test household', '--email', 'owner@example.test', '--name', 'Test Owner'], { env, stdio: 'inherit' });
if (init.status !== 0) process.exit(1);
const server = spawn('node', ['apps/api/dist/main.mjs'], { env, stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.kill(sig));
server.on('exit', (code) => process.exit(code ?? 0));
