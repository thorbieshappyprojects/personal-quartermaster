// `pq` command line. Subcommands are added per milestone.
import { createPool, migrate, sourceMigrationsDir } from '@pq/db';

const [cmd] = process.argv.slice(2);

async function run(): Promise<number> {
  switch (cmd) {
    case 'migrate': {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error('DATABASE_URL is required');
      const pool = createPool(url, 1);
      try {
        const r = await migrate(pool, process.env.MIGRATIONS_DIR ?? sourceMigrationsDir);
        console.log(`applied: ${r.applied.join(', ') || 'none'}`);
      } finally {
        await pool.end();
      }
      return 0;
    }
    default:
      console.log('usage: pq <migrate>');
      return cmd ? 1 : 0;
  }
}

run().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  },
);
