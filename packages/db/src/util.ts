import type { Pool, PoolClient } from 'pg';

export type Db = Pool | PoolClient;

export class DomainError extends Error {
  constructor(
    readonly code: 'not_found' | 'conflict' | 'last_owner' | 'already_initialised' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}

export async function tx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === '23505';
}

/** Who acts, for which household. Every write is attributed. */
export interface Actor {
  householdId: string;
  memberId: string | null; // null = system
}

export type EventEntity = 'item' | 'location' | 'category' | 'document';

export async function writeEvent(
  c: PoolClient,
  actor: Actor,
  e: { type: string; entity: EventEntity; entityId: string; before?: unknown; after?: unknown; captureId?: string | null },
): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO event (household_id, actor_member_id, type, entity, entity_id, before, after, capture_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [actor.householdId, actor.memberId, e.type, e.entity, e.entityId, e.before ?? null, e.after ?? null, e.captureId ?? null],
  );
  return rows[0]!.id;
}

/** The subset of fields that differ, as { before, after } snapshots for the event log. */
export function diff<T extends object>(before: T, after: T, keys: readonly (keyof T)[]) {
  const b: Partial<T> = {};
  const a: Partial<T> = {};
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      b[k] = before[k];
      a[k] = after[k];
    }
  }
  return { before: b, after: a, changed: Object.keys(a).length > 0 };
}
