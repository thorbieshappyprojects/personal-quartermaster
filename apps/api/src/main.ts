import { createPool, migrate, refreshSuggestions } from '@pq/db';
import { buildApp } from './app';
import { ConfigError, loadConfig } from './config';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`config error: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  const pool = createPool(config.databaseUrl);
  try {
    const result = await migrate(pool, config.migrationsDir);
    console.log(`migrations: ${result.applied.length} applied, ${result.skipped} already present`);
  } catch (err) {
    console.error(`refusing to start: ${(err as Error).message}`);
    await pool.end();
    process.exit(1);
  }

  // Consumable suggestions follow the rules shipped with this version.
  const refreshed = await refreshSuggestions(pool);
  if (refreshed) console.log(`consumable suggestions: ${refreshed} lines updated`);

  const app = await buildApp({ config, pool });
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
