// Container health check. Runs in-process instead of over HTTP, because every
// HTTP request (including /healthz) has to pass the Access gate.
import { createPool } from '@pq/db';
import { isHealthy } from './health';

const url = process.env.DATABASE_URL;
if (!url) process.exit(1);
const pool = createPool(url, 1);
const ok = await isHealthy(pool, process.env.MEDIA_DIR ?? '/data/media');
await pool.end();
process.exit(ok ? 0 : 1);
