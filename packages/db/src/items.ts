import {
  descendantIds,
  indexById,
  pathNames,
  toPrefixTsQuery,
  normaliseText,
  type ItemKind,
  type ItemState,
} from '@pq/core';
import type { Pool, PoolClient } from 'pg';
import { DomainError, diff, tx, writeEvent, type Actor, type Db } from './util';

export interface ItemRow {
  id: string;
  kind: ItemKind;
  name: string;
  aliases: string[];
  category_id: string | null;
  location_id: string | null;
  belongs_to_person_id: string | null;
  state: ItemState;
  quantity: number;
  unit: string | null;
  min_quantity: number | null;
  price_amount_minor: number | null;
  price_currency: string | null;
  purchase_url: string | null;
  notes: string | null;
  tags: string[];
  attributes: Record<string, unknown>;
  private_to: string | null;
  acquired_at: string | null;
  last_used_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ItemPhoto {
  document_id: string;
  width: number | null;
  height: number | null;
}

export interface Item extends ItemRow {
  location_path: string[];
  category_path: string[];
  photos: ItemPhoto[];
}

const COLS = [
  'id', 'kind', 'name', 'aliases', 'category_id', 'location_id', 'belongs_to_person_id', 'state', 'quantity', 'unit',
  'min_quantity', 'price_amount_minor', 'price_currency', 'purchase_url', 'notes', 'tags', 'attributes', 'private_to',
  'acquired_at', 'last_used_at', 'created_at', 'updated_at',
] as const;
const SELECT = COLS.map((c) => `i.${c}`).join(', ');

/** Fields the event log records for item changes. */
const TRACKED = [
  'kind', 'name', 'aliases', 'category_id', 'location_id', 'belongs_to_person_id', 'state', 'quantity', 'unit',
  'min_quantity', 'price_amount_minor', 'price_currency', 'purchase_url', 'notes', 'tags', 'attributes', 'private_to',
  'acquired_at',
] as const satisfies readonly (keyof ItemRow)[];

const VISIBLE = '(i.private_to IS NULL OR i.private_to = $2)';

// ── decoration: paths and photos ───────────────────────────────────────────

async function decorate(db: Db, householdId: string, rows: ItemRow[]): Promise<Item[]> {
  if (rows.length === 0) return [];
  const [locs, cats, photos] = await Promise.all([
    db.query<{ id: string; parent_id: string | null; name: string }>('SELECT id, parent_id, name FROM location WHERE household_id = $1', [householdId]),
    db.query<{ id: string; parent_id: string | null; name: string }>('SELECT id, parent_id, name FROM category WHERE household_id = $1', [householdId]),
    db.query<ItemPhoto & { item_id: string }>(
      `SELECT x.item_id, d.id AS document_id, d.width, d.height FROM item_document x JOIN document d ON d.id = x.document_id
        WHERE x.item_id = ANY($1) AND d.kind = 'photo' ORDER BY x.position, x.created_at`,
      [rows.map((r) => r.id)],
    ),
  ]);
  const li = indexById(locs.rows);
  const ci = indexById(cats.rows);
  const byItem = new Map<string, ItemPhoto[]>();
  for (const p of photos.rows) {
    const list = byItem.get(p.item_id) ?? [];
    list.push({ document_id: p.document_id, width: p.width, height: p.height });
    byItem.set(p.item_id, list);
  }
  return rows.map((r) => ({
    ...r,
    location_path: r.location_id ? pathNames(li, r.location_id) : [],
    category_path: r.category_id ? pathNames(ci, r.category_id) : [],
    photos: byItem.get(r.id) ?? [],
  }));
}

// ── reads ──────────────────────────────────────────────────────────────────

export async function getItem(db: Db, householdId: string, memberId: string | null, id: string): Promise<Item> {
  const { rows } = await db.query<ItemRow>(`SELECT ${SELECT} FROM item i WHERE i.household_id = $1 AND ${VISIBLE} AND i.id = $3`, [
    householdId,
    memberId,
    id,
  ]);
  if (!rows[0]) throw new DomainError('not_found', 'item not found');
  return (await decorate(db, householdId, rows))[0]!;
}

export interface ItemFilter {
  q?: string;
  locationId?: string;       // includes everything below it
  categoryId?: string;       // includes subcategories
  states?: ItemState[];
  kind?: ItemKind;
  limit?: number;
  offset?: number;
}

export interface ItemPage {
  items: Item[];
  total: number;
}

/**
 * Lists or searches items. With `q`, matches whole-word prefixes ("batt" → batteries), fuzzy
 * spellings via trigram word similarity ("kreisage" → Kreissäge), and category names
 * (with their subcategories); ranked by match quality, things still in the house first.
 */
export async function listItems(db: Db, householdId: string, memberId: string | null, f: ItemFilter): Promise<ItemPage> {
  const params: unknown[] = [householdId, memberId];
  const where: string[] = ['i.household_id = $1', VISIBLE];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };

  if (f.locationId || f.categoryId) {
    const [locs, cats] = await Promise.all([
      f.locationId ? db.query('SELECT id, parent_id, name FROM location WHERE household_id = $1', [householdId]) : null,
      f.categoryId ? db.query('SELECT id, parent_id, name FROM category WHERE household_id = $1', [householdId]) : null,
    ]);
    if (f.locationId) where.push(`i.location_id = ANY(${p([f.locationId, ...descendantIds(locs!.rows, f.locationId)])})`);
    if (f.categoryId) where.push(`i.category_id = ANY(${p([f.categoryId, ...descendantIds(cats!.rows, f.categoryId)])})`);
  }
  if (f.states?.length) where.push(`i.state = ANY(${p(f.states)})`);
  if (f.kind) where.push(`i.kind = ${p(f.kind)}`);

  let rank = '0';
  const terms = f.q ? normaliseText(f.q) : '';
  if (terms) {
    const tsq = toPrefixTsQuery(terms);
    const t = p(terms);
    const cats = await db.query<{ id: string; parent_id: string | null; name: string; norm: string }>(
      'SELECT id, parent_id, name, lower(pq_unaccent(name)) AS norm FROM category WHERE household_id = $1',
      [householdId],
    );
    const matchedCats = new Set<string>();
    for (const c of cats.rows) {
      if (c.norm === terms || (terms.length >= 3 && c.norm.startsWith(terms))) {
        matchedCats.add(c.id);
        for (const d of descendantIds(cats.rows, c.id)) matchedCats.add(d);
      }
    }
    const conds = [`${t} <% i.search_text`];
    const tq = tsq ? p(tsq) : null;
    if (tq) conds.push(`i.search @@ to_tsquery('simple', ${tq})`);
    if (matchedCats.size) conds.push(`i.category_id = ANY(${p([...matchedCats])})`);
    where.push(`(${conds.join(' OR ')})`);
    rank = `(word_similarity(${t}, i.search_text)${tq ? ` + ts_rank(i.search, to_tsquery('simple', ${tq}))` : ''})`;
  }

  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const offset = Math.max(f.offset ?? 0, 0);
  const whereSql = where.join(' AND ');
  const order = terms
    ? `(i.state IN ('owned', 'lent', 'unknown')) DESC, ${rank} DESC, lower(i.name)`
    : `(i.state IN ('owned', 'lent', 'unknown')) DESC, i.updated_at DESC`;
  const [page, count] = await Promise.all([
    db.query<ItemRow>(`SELECT ${SELECT} FROM item i WHERE ${whereSql} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, params),
    db.query<{ n: number }>(`SELECT count(*)::int AS n FROM item i WHERE ${whereSql}`, params),
  ]);
  return { items: await decorate(db, householdId, page.rows), total: count.rows[0]!.n };
}

// ── writes ─────────────────────────────────────────────────────────────────

export interface ItemInput {
  kind?: ItemKind;
  name: string;
  aliases?: string[];
  categoryId?: string | null;
  locationId?: string | null;
  belongsToPersonId?: string | null;
  state?: ItemState;
  quantity?: number;
  unit?: string | null;
  minQuantity?: number | null;
  priceAmountMinor?: number | null;
  priceCurrency?: string | null;
  purchaseUrl?: string | null;
  notes?: string | null;
  tags?: string[];
  attributes?: Record<string, unknown>;
  privateTo?: string | null;
  acquiredAt?: string | null;
}

async function assertRefs(c: PoolClient, householdId: string, refs: { categoryId?: string | null; locationId?: string | null; personId?: string | null; memberId?: string | null }) {
  const checks: [string, string | null | undefined, string][] = [
    ['category', refs.categoryId, 'category not found'],
    ['location', refs.locationId, 'location not found'],
    ['person', refs.personId, 'person not found'],
    ['member', refs.memberId, 'member not found'],
  ];
  for (const [table, id, msg] of checks) {
    if (!id) continue;
    const r = await c.query(`SELECT 1 FROM ${table} WHERE id = $1 AND household_id = $2`, [id, householdId]);
    if (!r.rowCount) throw new DomainError('not_found', msg);
  }
}

const cleanList = (xs: string[] | undefined) => [...new Set((xs ?? []).map((x) => x.trim()).filter(Boolean))];

function checkPrice(amount: number | null | undefined, currency: string | null | undefined) {
  if ((amount == null) !== (currency == null)) throw new DomainError('invalid', 'price needs both an amount and a currency');
}

export async function createItem(pool: Pool, actor: Actor, input: ItemInput, opts: { captureId?: string } = {}): Promise<Item> {
  checkPrice(input.priceAmountMinor, input.priceCurrency);
  const row = await tx(pool, async (c) => {
    await assertRefs(c, actor.householdId, {
      categoryId: input.categoryId,
      locationId: input.locationId,
      personId: input.belongsToPersonId,
      memberId: input.privateTo,
    });
    let kind = input.kind;
    if (!kind && input.categoryId) {
      const cat = await c.query<{ default_kind: ItemKind | null }>('SELECT default_kind FROM category WHERE id = $1', [input.categoryId]);
      kind = cat.rows[0]?.default_kind ?? undefined;
    }
    const { rows } = await c.query<ItemRow>(
      `INSERT INTO item AS i (household_id, kind, name, aliases, category_id, location_id, belongs_to_person_id, state, quantity, unit,
                         min_quantity, price_amount_minor, price_currency, purchase_url, notes, tags, attributes, private_to, acquired_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING ${SELECT}`,
      [
        actor.householdId, kind ?? 'durable', input.name.trim(), cleanList(input.aliases), input.categoryId ?? null,
        input.locationId ?? null, input.belongsToPersonId ?? null, input.state ?? 'owned', input.quantity ?? 1,
        input.unit?.trim() || null, input.minQuantity ?? null, input.priceAmountMinor ?? null, input.priceCurrency ?? null,
        input.purchaseUrl?.trim() || null, input.notes?.trim() || null, cleanList(input.tags), input.attributes ?? {},
        input.privateTo ?? null, input.acquiredAt ?? null,
      ],
    );
    const item = rows[0]!;
    await writeEvent(c, actor, {
      type: 'item.created',
      entity: 'item',
      entityId: item.id,
      after: Object.fromEntries(TRACKED.map((k) => [k, item[k]])),
      captureId: opts.captureId,
    });
    return item;
  });
  return (await decorate(pool, actor.householdId, [row]))[0]!;
}

async function lockItem(c: PoolClient, actor: Actor, id: string): Promise<ItemRow> {
  const { rows } = await c.query<ItemRow>(
    `SELECT ${SELECT} FROM item i WHERE i.household_id = $1 AND ${VISIBLE} AND i.id = $3 FOR UPDATE`,
    [actor.householdId, actor.memberId, id],
  );
  if (!rows[0]) throw new DomainError('not_found', 'item not found');
  return rows[0];
}

function eventType(changed: Record<string, unknown>): string {
  const keys = Object.keys(changed);
  if (keys.length === 1 && keys[0] === 'location_id') return 'item.moved';
  if (keys.length === 1 && keys[0] === 'state') return 'item.state_changed';
  return 'item.updated';
}

export async function updateItem(pool: Pool, actor: Actor, id: string, patch: Partial<ItemInput>): Promise<Item> {
  const row = await tx(pool, async (c) => {
    const cur = await lockItem(c, actor, id);
    await assertRefs(c, actor.householdId, {
      categoryId: patch.categoryId,
      locationId: patch.locationId,
      personId: patch.belongsToPersonId,
      memberId: patch.privateTo,
    });
    const pick = <K extends keyof ItemInput, V>(k: K, curV: V, map: (v: NonNullable<ItemInput[K]> | null) => V = (v) => v as V): V =>
      patch[k] !== undefined ? map((patch[k] ?? null) as NonNullable<ItemInput[K]> | null) : curV;
    const next: ItemRow = {
      ...cur,
      kind: pick('kind', cur.kind),
      name: pick('name', cur.name, (v) => (v as string).trim()),
      aliases: pick('aliases', cur.aliases, (v) => cleanList(v as string[] | undefined)),
      category_id: pick('categoryId', cur.category_id),
      location_id: pick('locationId', cur.location_id),
      belongs_to_person_id: pick('belongsToPersonId', cur.belongs_to_person_id),
      state: pick('state', cur.state),
      quantity: pick('quantity', cur.quantity),
      unit: pick('unit', cur.unit, (v) => (v as string | null)?.trim() || null),
      min_quantity: pick('minQuantity', cur.min_quantity),
      price_amount_minor: pick('priceAmountMinor', cur.price_amount_minor),
      price_currency: pick('priceCurrency', cur.price_currency),
      purchase_url: pick('purchaseUrl', cur.purchase_url, (v) => (v as string | null)?.trim() || null),
      notes: pick('notes', cur.notes, (v) => (v as string | null)?.trim() || null),
      tags: pick('tags', cur.tags, (v) => cleanList(v as string[] | undefined)),
      attributes: pick('attributes', cur.attributes, (v) => (v ?? {}) as Record<string, unknown>),
      private_to: pick('privateTo', cur.private_to),
      acquired_at: pick('acquiredAt', cur.acquired_at),
    };
    checkPrice(next.price_amount_minor, next.price_currency);
    const d = diff(cur, next, TRACKED);
    if (!d.changed) return cur;
    const sets = TRACKED.map((k, n) => `${k} = $${n + 2}`).join(', ');
    const { rows } = await c.query<ItemRow>(`UPDATE item i SET ${sets} WHERE id = $1 RETURNING ${SELECT}`, [
      id,
      ...TRACKED.map((k) => next[k]),
    ]);
    await writeEvent(c, actor, { type: eventType(d.after), entity: 'item', entityId: id, before: d.before, after: d.after });
    return rows[0]!;
  });
  return (await decorate(pool, actor.householdId, [row]))[0]!;
}

/** Moves several items in one transaction; one event per item that actually moves. */
export async function moveItems(pool: Pool, actor: Actor, ids: string[], locationId: string | null): Promise<number> {
  return tx(pool, async (c) => {
    await assertRefs(c, actor.householdId, { locationId });
    let moved = 0;
    for (const id of [...new Set(ids)].sort()) {
      const cur = await lockItem(c, actor, id);
      if (cur.location_id === locationId) continue;
      await c.query('UPDATE item SET location_id = $2 WHERE id = $1', [id, locationId]);
      await writeEvent(c, actor, {
        type: 'item.moved',
        entity: 'item',
        entityId: id,
        before: { location_id: cur.location_id },
        after: { location_id: locationId },
      });
      moved++;
    }
    return moved;
  });
}

export async function deleteItem(pool: Pool, actor: Actor, id: string): Promise<void> {
  await tx(pool, async (c) => {
    const cur = await lockItem(c, actor, id);
    await c.query('DELETE FROM item WHERE id = $1', [id]);
    await writeEvent(c, actor, {
      type: 'item.deleted',
      entity: 'item',
      entityId: id,
      before: Object.fromEntries(TRACKED.map((k) => [k, cur[k]])),
    });
  });
}

// ── events ─────────────────────────────────────────────────────────────────

export interface EventRow {
  id: string;
  actor_member_id: string | null;
  actor_name: string | null;
  type: string;
  entity: string;
  entity_id: string;
  before: unknown;
  after: unknown;
  capture_id: string | null;
  undone_by: string | null;
  created_at: Date;
}

export async function listEvents(
  db: Db,
  householdId: string,
  memberId: string | null,
  f: { entity?: string; entityId?: string; before?: Date; limit?: number },
): Promise<EventRow[]> {
  const params: unknown[] = [householdId, memberId];
  const where = ['e.household_id = $1'];
  if (f.entity) where.push(`e.entity = $${params.push(f.entity)}`);
  if (f.entityId) where.push(`e.entity_id = $${params.push(f.entityId)}`);
  if (f.before) where.push(`e.created_at < $${params.push(f.before)}`);
  // Hide events about items that are private to someone else.
  where.push(`NOT EXISTS (SELECT 1 FROM item i WHERE i.id = e.entity_id AND i.private_to IS NOT NULL AND i.private_to IS DISTINCT FROM $2)`);
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const { rows } = await db.query<EventRow>(
    `SELECT e.id, e.actor_member_id, m.display_name AS actor_name, e.type, e.entity, e.entity_id, e.before, e.after,
            e.capture_id, e.undone_by, e.created_at
       FROM event e LEFT JOIN member m ON m.id = e.actor_member_id
      WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC, e.id LIMIT ${limit}`,
    params,
  );
  return rows;
}
