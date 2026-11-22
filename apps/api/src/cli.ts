// `pq` command line, for setup and operator tasks on the server:
//   docker compose run --rm jobs pq <command>
import { parseArgs } from 'node:util';
import {
  createApiToken,
  createMember,
  createPool,
  findMemberByEmail,
  getHousehold,
  initHousehold,
  migrate,
  sourceMigrationsDir,
  type Pool,
} from '@pq/db';

const USAGE = `usage: pq <command> [options]

  migrate                                         apply pending migrations
  init --household <name> --email <e> --name <n>  create the household and its first owner
  member add --email <e> --name <n> [--owner]     add a member (also add them to the Access policy)
  token create --email <e> --label <l>            create an API token for a member (printed once)
  token revoke --id <token id>                    revoke an API token
`;

function need(v: string | undefined, flag: string): string {
  if (!v) throw new Error(`--${flag} is required`);
  return v;
}

async function withPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = createPool(url, 2);
  try {
    await migrate(pool, process.env.MIGRATIONS_DIR ?? sourceMigrationsDir);
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      household: { type: 'string' },
      email: { type: 'string' },
      name: { type: 'string' },
      label: { type: 'string' },
      id: { type: 'string' },
      owner: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const cmd = positionals.join(' ');
  if (values.help || !cmd) {
    console.log(USAGE);
    return 0;
  }

  switch (cmd) {
    case 'migrate':
      return withPool(async () => {
        console.log('migrations up to date');
        return 0;
      });

    case 'init':
      return withPool(async (pool) => {
        const { household, owner } = await initHousehold(pool, {
          name: need(values.household, 'household'),
          ownerEmail: need(values.email, 'email'),
          ownerName: need(values.name, 'name'),
        });
        console.log(`household ${household.id} created; owner ${owner.id}`);
        return 0;
      });

    case 'member add':
      return withPool(async (pool) => {
        const household = await getHousehold(pool);
        if (!household) throw new Error('no household yet; run `pq init` first');
        const m = await createMember(pool, household.id, {
          email: need(values.email, 'email'),
          displayName: need(values.name, 'name'),
          role: values.owner ? 'owner' : 'member',
        });
        console.log(`member ${m.id} added as ${m.role}`);
        return 0;
      });

    case 'token create':
      return withPool(async (pool) => {
        const member = await findMemberByEmail(pool, need(values.email, 'email'));
        if (!member) throw new Error('no member with this e-mail');
        const { id, token } = await createApiToken(pool, member.id, need(values.label, 'label'));
        console.error(`token ${id} created. It is shown once; store it in the device's Shortcuts now.`);
        console.log(token);
        return 0;
      });

    case 'token revoke':
      return withPool(async (pool) => {
        const r = await pool.query('UPDATE api_token SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [
          need(values.id, 'id'),
        ]);
        console.log(r.rowCount ? 'revoked' : 'no active token with this id');
        return r.rowCount ? 0 : 1;
      });

    default:
      console.error(USAGE);
      return 1;
  }
}

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  },
);
