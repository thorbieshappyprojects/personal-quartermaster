import pg from 'pg';

export type { Pool, PoolClient } from 'pg';

// numeric and bigint arrive as strings by default. Quantities and minor-unit amounts
// stay well below 2^53, so plain numbers are safe and much easier to work with.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
// date stays 'YYYY-MM-DD': parsing it into a Date would shift it by the local time zone.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000 });
}
