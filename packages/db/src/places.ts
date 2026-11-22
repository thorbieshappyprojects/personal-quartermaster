import { checkPlacement, wouldCreateCycle, type ItemKind, type LocationKind } from '@pq/core';
import type { Pool, PoolClient } from 'pg';
import { DomainError, diff, isUniqueViolation, tx, writeEvent, type Actor, type Db } from './util';

// ── locations ──────────────────────────────────────────────────────────────

export interface Location {
  id: string;
  parent_id: string | null;
  kind: LocationKind;
  name: string;
  notes: string | null;
  photo_document_id: string | null;
  sort_order: number;
  item_count: number; // items in possession directly at this location
  created_at: Date;
  updated_at: Date;
}

const LOCATION_COLS = 'l.id, l.parent_id, l.kind, l.name, l.notes, l.photo_document_id, l.sort_order, l.created_at, l.updated_at';
type LocationRow = Omit<Location, 'item_count'>;

export async function listLocations(db: Db, householdId: string, memberId: string | null): Promise<Location[]> {
  const { rows } = await db.query<Location>(
    `SELECT ${LOCATION_COLS},
            (SELECT count(*)::int FROM item i
              WHERE i.location_id = l.id AND i.state IN ('owned', 'lent', 'unknown')
                AND (i.private_to IS NULL OR i.private_to = $2)) AS item_count
       FROM location l WHERE l.household_id = $1
      ORDER BY l.sort_order, lower(l.name)`,
    [householdId, memberId],
  );
  return rows;
}

async function lockedLocations(c: PoolClient, householdId: string): Promise<LocationRow[]> {
  // Serialises tree edits per household so two moves cannot create a cycle together.
  const { rows } = await c.query<LocationRow>(
    `SELECT ${LOCATION_COLS} FROM location l WHERE l.household_id = $1 ORDER BY l.id FOR UPDATE`,
    [householdId],
  );
  return rows;
}

const PLACEMENT_MESSAGES = {
  parent_not_found: 'parent location not found',
  invalid_nesting: 'this kind of location cannot be placed there (site › room › spot › container)',
  cycle: 'a location cannot be placed inside itself',
} as const;

function nameConflict(err: unknown): never {
  if (isUniqueViolation(err)) throw new DomainError('conflict', 'a sibling with this name already exists');
  throw err;
}

export async function createLocation(
  pool: Pool,
  actor: Actor,
  input: { parentId: string | null; kind: LocationKind; name: string; notes?: string | null },
): Promise<LocationRow> {
  return tx(pool, async (c) => {
    const nodes = await lockedLocations(c, actor.householdId);
    const problem = checkPlacement(nodes, { kind: input.kind, parentId: input.parentId });
    if (problem) throw new DomainError(problem === 'parent_not_found' ? 'not_found' : 'invalid', PLACEMENT_MESSAGES[problem]);
    const { rows } = await c
      .query<LocationRow>(
        `INSERT INTO location AS l (household_id, parent_id, kind, name, notes) VALUES ($1, $2, $3, $4, $5) RETURNING ${LOCATION_COLS}`,
        [actor.householdId, input.parentId, input.kind, input.name.trim(), input.notes ?? null],
      )
      .catch(nameConflict);
    const loc = rows[0]!;
    await writeEvent(c, actor, { type: 'location.created', entity: 'location', entityId: loc.id, after: loc });
    return loc;
  });
}

export async function updateLocation(
  pool: Pool,
  actor: Actor,
  id: string,
  patch: { parentId?: string | null; kind?: LocationKind; name?: string; notes?: string | null; sortOrder?: number },
): Promise<LocationRow> {
  return tx(pool, async (c) => {
    const nodes = await lockedLocations(c, actor.householdId);
    const current = nodes.find((n) => n.id === id);
    if (!current) throw new DomainError('not_found', 'location not found');
    const next: LocationRow = {
      ...current,
      parent_id: patch.parentId !== undefined ? patch.parentId : current.parent_id,
      kind: patch.kind ?? current.kind,
      name: patch.name?.trim() ?? current.name,
      notes: patch.notes !== undefined ? patch.notes : current.notes,
      sort_order: patch.sortOrder ?? current.sort_order,
    };
    const problem = checkPlacement(nodes, { id, kind: next.kind, parentId: next.parent_id });
    if (problem) throw new DomainError(problem === 'parent_not_found' ? 'not_found' : 'invalid', PLACEMENT_MESSAGES[problem]);
    const d = diff(current, next, ['parent_id', 'kind', 'name', 'notes', 'sort_order']);
    if (!d.changed) return current;
    const { rows } = await c
      .query<LocationRow>(
        `UPDATE location l SET parent_id = $2, kind = $3, name = $4, notes = $5, sort_order = $6 WHERE id = $1 RETURNING ${LOCATION_COLS}`,
        [id, next.parent_id, next.kind, next.name, next.notes, next.sort_order],
      )
      .catch(nameConflict);
    const type = 'parent_id' in d.after ? 'location.moved' : 'location.updated';
    await writeEvent(c, actor, { type, entity: 'location', entityId: id, before: d.before, after: d.after });
    return rows[0]!;
  });
}

export async function deleteLocation(pool: Pool, actor: Actor, id: string): Promise<void> {
  await tx(pool, async (c) => {
    const nodes = await lockedLocations(c, actor.householdId);
    const current = nodes.find((n) => n.id === id);
    if (!current) throw new DomainError('not_found', 'location not found');
    if (nodes.some((n) => n.parent_id === id)) throw new DomainError('conflict', 'location still contains other locations');
    const items = await c.query('SELECT 1 FROM item WHERE location_id = $1 LIMIT 1', [id]);
    if (items.rowCount) throw new DomainError('conflict', 'location still has items (move them first)');
    await c.query('DELETE FROM location WHERE id = $1', [id]);
    await writeEvent(c, actor, { type: 'location.deleted', entity: 'location', entityId: id, before: current });
  });
}

// ── categories ─────────────────────────────────────────────────────────────

export interface Category {
  id: string;
  parent_id: string | null;
  name: string;
  default_kind: ItemKind | null;
  assume_consumed_after_months: number | null;
  item_count: number;
  created_at: Date;
  updated_at: Date;
}
type CategoryRow = Omit<Category, 'item_count'>;
const CATEGORY_COLS = 'c.id, c.parent_id, c.name, c.default_kind, c.assume_consumed_after_months, c.created_at, c.updated_at';

export async function listCategories(db: Db, householdId: string, memberId: string | null): Promise<Category[]> {
  const { rows } = await db.query<Category>(
    `SELECT ${CATEGORY_COLS},
            (SELECT count(*)::int FROM item i WHERE i.category_id = c.id AND i.state IN ('owned', 'lent', 'unknown')
                AND (i.private_to IS NULL OR i.private_to = $2)) AS item_count
       FROM category c WHERE c.household_id = $1 ORDER BY lower(c.name)`,
    [householdId, memberId],
  );
  return rows;
}

async function lockedCategories(c: PoolClient, householdId: string): Promise<CategoryRow[]> {
  const { rows } = await c.query<CategoryRow>(
    `SELECT ${CATEGORY_COLS} FROM category c WHERE c.household_id = $1 ORDER BY c.id FOR UPDATE`,
    [householdId],
  );
  return rows;
}

export async function createCategory(
  pool: Pool,
  actor: Actor,
  input: { parentId: string | null; name: string; defaultKind?: ItemKind | null },
): Promise<CategoryRow> {
  return tx(pool, async (c) => {
    const nodes = await lockedCategories(c, actor.householdId);
    if (input.parentId && !nodes.some((n) => n.id === input.parentId)) throw new DomainError('not_found', 'parent category not found');
    const { rows } = await c
      .query<CategoryRow>(
        `INSERT INTO category AS c (household_id, parent_id, name, default_kind) VALUES ($1, $2, $3, $4) RETURNING ${CATEGORY_COLS}`,
        [actor.householdId, input.parentId, input.name.trim(), input.defaultKind ?? null],
      )
      .catch(nameConflict);
    await writeEvent(c, actor, { type: 'category.created', entity: 'category', entityId: rows[0]!.id, after: rows[0] });
    return rows[0]!;
  });
}

export async function updateCategory(
  pool: Pool,
  actor: Actor,
  id: string,
  patch: { parentId?: string | null; name?: string; defaultKind?: ItemKind | null; assumeConsumedAfterMonths?: number | null },
): Promise<CategoryRow> {
  return tx(pool, async (c) => {
    const nodes = await lockedCategories(c, actor.householdId);
    const current = nodes.find((n) => n.id === id);
    if (!current) throw new DomainError('not_found', 'category not found');
    const next: CategoryRow = {
      ...current,
      parent_id: patch.parentId !== undefined ? patch.parentId : current.parent_id,
      name: patch.name?.trim() ?? current.name,
      default_kind: patch.defaultKind !== undefined ? patch.defaultKind : current.default_kind,
      assume_consumed_after_months:
        patch.assumeConsumedAfterMonths !== undefined ? patch.assumeConsumedAfterMonths : current.assume_consumed_after_months,
    };
    if (next.parent_id && !nodes.some((n) => n.id === next.parent_id)) throw new DomainError('not_found', 'parent category not found');
    if (wouldCreateCycle(nodes, id, next.parent_id)) throw new DomainError('invalid', 'a category cannot be placed inside itself');
    const d = diff(current, next, ['parent_id', 'name', 'default_kind', 'assume_consumed_after_months']);
    if (!d.changed) return current;
    const { rows } = await c
      .query<CategoryRow>(
        `UPDATE category c SET parent_id = $2, name = $3, default_kind = $4, assume_consumed_after_months = $5 WHERE id = $1 RETURNING ${CATEGORY_COLS}`,
        [id, next.parent_id, next.name, next.default_kind, next.assume_consumed_after_months],
      )
      .catch(nameConflict);
    await writeEvent(c, actor, { type: 'category.updated', entity: 'category', entityId: id, before: d.before, after: d.after });
    return rows[0]!;
  });
}

export async function deleteCategory(pool: Pool, actor: Actor, id: string): Promise<void> {
  await tx(pool, async (c) => {
    const nodes = await lockedCategories(c, actor.householdId);
    const current = nodes.find((n) => n.id === id);
    if (!current) throw new DomainError('not_found', 'category not found');
    if (nodes.some((n) => n.parent_id === id)) throw new DomainError('conflict', 'category still has subcategories');
    const items = await c.query('SELECT 1 FROM item WHERE category_id = $1 LIMIT 1', [id]);
    if (items.rowCount) throw new DomainError('conflict', 'category is still used by items (recategorise them first)');
    await c.query('DELETE FROM category WHERE id = $1', [id]);
    await writeEvent(c, actor, { type: 'category.deleted', entity: 'category', entityId: id, before: current });
  });
}
