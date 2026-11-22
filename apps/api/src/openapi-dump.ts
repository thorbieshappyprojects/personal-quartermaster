import { writeFile } from 'node:fs/promises';
import { buildApp } from './app';
import type { Pool } from '@pq/db';

// Builds the app without a database to emit the OpenAPI document (the client contract).
const app = await buildApp(
  {
    config: {
      production: false, host: '127.0.0.1', port: 0, logLevel: 'silent', databaseUrl: '', mediaDir: '',
      migrationsDir: '', webDir: null, auth: { mode: 'dev', email: 'owner@example.test' },
    },
    pool: {} as Pool,
  },
  { logger: false },
);
await app.ready();
await writeFile(process.argv[2] ?? 'openapi.json', JSON.stringify(app.swagger(), null, 2) + '\n');
await app.close();
