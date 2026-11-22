import type { Pool, PoolClient } from 'pg';

type Db = Pool | PoolClient;

export type Role = 'owner' | 'member';

export interface Member {
  id: string;
  household_id: string;
  display_name: string;
  email: string;
  role: Role;
  notification_settings: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

const MEMBER_COLS = 'id, household_id, display_name, email, role, notification_settings, created_at, updated_at';

export async function findMemberByEmail(db: Db, email: string): Promise<Member | null> {
  const { rows } = await db.query<Member>(`SELECT ${MEMBER_COLS} FROM member WHERE lower(email) = lower($1)`, [email]);
  return rows[0] ?? null;
}

/** Resolves an unrevoked API token hash to its member and records the use. */
export async function findMemberByTokenHash(db: Db, hash: Buffer): Promise<Member | null> {
  const { rows } = await db.query<Member>(
    `WITH t AS (
       UPDATE api_token SET last_used_at = now()
        WHERE token_hash = $1 AND revoked_at IS NULL
        RETURNING member_id)
     SELECT ${MEMBER_COLS.split(', ').map((c) => `m.${c}`).join(', ')}
       FROM member m JOIN t ON t.member_id = m.id`,
    [hash],
  );
  return rows[0] ?? null;
}
