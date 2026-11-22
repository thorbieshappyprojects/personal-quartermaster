import { generateApiToken, normaliseEmail, wouldRemoveLastOwner, type Role } from '@pq/core';
import type { Pool, PoolClient } from 'pg';
import { DomainError, isUniqueViolation, tx, type Db } from './util';

export type { Role };

export interface Household {
  id: string;
  name: string;
  base_currency: string;
  settings: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

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

export interface Person {
  id: string;
  household_id: string;
  display_name: string;
  kind: 'member' | 'dependant';
  member_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const MEMBER_COLS = ['id', 'household_id', 'display_name', 'email', 'role', 'notification_settings', 'created_at', 'updated_at'];
const M = MEMBER_COLS.join(', ');
const PERSON_COLS = 'id, household_id, display_name, kind, member_id, created_at, updated_at';

// ── household ──────────────────────────────────────────────────────────────

export async function getHousehold(db: Db): Promise<Household | null> {
  const { rows } = await db.query<Household>('SELECT * FROM household ORDER BY created_at LIMIT 1');
  return rows[0] ?? null;
}

/** Creates the installation's single household and its first owner. Refuses if a household exists. */
export async function initHousehold(
  pool: Pool,
  input: { name: string; ownerEmail: string; ownerName: string },
): Promise<{ household: Household; owner: Member }> {
  return tx(pool, async (c) => {
    await c.query('LOCK TABLE household IN EXCLUSIVE MODE');
    if (await getHousehold(c)) throw new DomainError('already_initialised', 'a household already exists');
    const { rows } = await c.query<Household>('INSERT INTO household (name) VALUES ($1) RETURNING *', [input.name.trim()]);
    const household = rows[0]!;
    const owner = await insertMember(c, household.id, { email: input.ownerEmail, displayName: input.ownerName, role: 'owner' });
    await c.query('SELECT seed_default_categories($1)', [household.id]);
    return { household, owner };
  });
}

// ── members ────────────────────────────────────────────────────────────────

export async function findMemberByEmail(db: Db, email: string): Promise<Member | null> {
  const { rows } = await db.query<Member>(`SELECT ${M} FROM member WHERE lower(email) = lower($1)`, [email.trim()]);
  return rows[0] ?? null;
}

/** Resolves an unrevoked API token hash to its member and records the use. */
export async function findMemberByTokenHash(db: Db, hash: Buffer): Promise<Member | null> {
  const { rows } = await db.query<Member>(
    `WITH t AS (
       UPDATE api_token SET last_used_at = now()
        WHERE token_hash = $1 AND revoked_at IS NULL
        RETURNING member_id)
     SELECT ${MEMBER_COLS.map((c) => `m.${c}`).join(', ')}
       FROM member m JOIN t ON t.member_id = m.id`,
    [hash],
  );
  return rows[0] ?? null;
}

export async function listMembers(db: Db, householdId: string): Promise<Member[]> {
  const { rows } = await db.query<Member>(`SELECT ${M} FROM member WHERE household_id = $1 ORDER BY created_at`, [householdId]);
  return rows;
}

async function insertMember(
  c: PoolClient,
  householdId: string,
  input: { email: string; displayName: string; role: Role },
): Promise<Member> {
  try {
    const { rows } = await c.query<Member>(
      `INSERT INTO member (household_id, display_name, email, role) VALUES ($1, $2, $3, $4) RETURNING ${M}`,
      [householdId, input.displayName.trim(), normaliseEmail(input.email), input.role],
    );
    const member = rows[0]!;
    await c.query("INSERT INTO person (household_id, display_name, kind, member_id) VALUES ($1, $2, 'member', $3)", [
      householdId,
      member.display_name,
      member.id,
    ]);
    return member;
  } catch (err) {
    if (isUniqueViolation(err)) throw new DomainError('conflict', 'a member with this e-mail already exists');
    throw err;
  }
}

/** Adds a member with a login; also creates the matching person for "belongs to". */
export async function createMember(
  pool: Pool,
  householdId: string,
  input: { email: string; displayName: string; role: Role },
): Promise<Member> {
  return tx(pool, (c) => insertMember(c, householdId, input));
}

export async function updateMember(
  pool: Pool,
  householdId: string,
  id: string,
  patch: { displayName?: string; role?: Role; notificationSettings?: Record<string, unknown> },
): Promise<Member> {
  return tx(pool, async (c) => {
    // Lock all members of the household so concurrent demotions cannot both pass the owner check.
    const { rows } = await c.query<Member>(`SELECT ${M} FROM member WHERE household_id = $1 ORDER BY id FOR UPDATE`, [householdId]);
    const current = rows.find((m) => m.id === id);
    if (!current) throw new DomainError('not_found', 'member not found');
    const owners = rows.filter((m) => m.role === 'owner').length;
    if (patch.role && wouldRemoveLastOwner(owners, current.role, patch.role)) {
      throw new DomainError('last_owner', 'the household needs at least one owner');
    }
    const { rows: updated } = await c.query<Member>(
      `UPDATE member SET
         display_name = COALESCE($2, display_name),
         role = COALESCE($3, role),
         notification_settings = COALESCE($4, notification_settings)
       WHERE id = $1 RETURNING ${M}`,
      [id, patch.displayName?.trim() ?? null, patch.role ?? null, patch.notificationSettings ?? null],
    );
    const member = updated[0]!;
    if (patch.displayName) {
      await c.query('UPDATE person SET display_name = $2 WHERE member_id = $1', [id, member.display_name]);
    }
    return member;
  });
}

// ── persons (members and dependants) ───────────────────────────────────────

export async function listPersons(db: Db, householdId: string): Promise<Person[]> {
  const { rows } = await db.query<Person>(
    `SELECT ${PERSON_COLS} FROM person WHERE household_id = $1 ORDER BY kind, display_name`,
    [householdId],
  );
  return rows;
}

/** A dependant (child, pet) has no login; it exists so items can belong to it. */
export async function createDependant(db: Db, householdId: string, displayName: string): Promise<Person> {
  const { rows } = await db.query<Person>(
    `INSERT INTO person (household_id, display_name, kind) VALUES ($1, $2, 'dependant') RETURNING ${PERSON_COLS}`,
    [householdId, displayName.trim()],
  );
  return rows[0]!;
}

export async function renameDependant(db: Db, householdId: string, id: string, displayName: string): Promise<Person> {
  const { rows } = await db.query<Person>(
    `UPDATE person SET display_name = $3 WHERE id = $2 AND household_id = $1 AND kind = 'dependant' RETURNING ${PERSON_COLS}`,
    [householdId, id, displayName.trim()],
  );
  if (!rows[0]) throw new DomainError('not_found', 'dependant not found (member names are changed on the member)');
  return rows[0];
}

// ── api tokens ─────────────────────────────────────────────────────────────

/** Creates an API token for a member and returns the plaintext once. */
export async function createApiToken(db: Db, memberId: string, label: string): Promise<{ id: string; token: string }> {
  const { token, hash } = generateApiToken();
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO api_token (member_id, token_hash, label) VALUES ($1, $2, $3) RETURNING id',
    [memberId, hash, label.trim()],
  );
  return { id: rows[0]!.id, token };
}
