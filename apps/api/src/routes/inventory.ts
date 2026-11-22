import { extractSearchTerms, summariseFind, type ItemKind, type ItemState, type LocationKind } from '@pq/core';
import {
  createCategory,
  createItem,
  createLocation,
  deleteCategory,
  deleteItem,
  deleteLocation,
  getItem,
  listCategories,
  listEvents,
  listItems,
  listLocations,
  moveItems,
  updateCategory,
  updateItem,
  updateLocation,
  type Actor,
  type Item,
  type ItemInput,
} from '@pq/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  categorySchema,
  eventSchema,
  idParams,
  ITEM_STATES,
  itemSchema,
  itemWriteProperties,
  LOCATION_KINDS,
  locationSchema,
  name,
  nullableString,
  nullableUuid,
  uuid,
} from './schemas';

const actorOf = (req: FastifyRequest): Actor => ({
  householdId: req.identity.member.household_id,
  memberId: req.identity.member.id,
});

/** Adds the media URLs clients need to show photos. */
export function presentItem(item: Item) {
  return {
    ...item,
    photos: item.photos.map((p) => ({
      ...p,
      url: `/media/${p.document_id}`,
      thumb_url: `/media/${p.document_id}/thumb`,
    })),
  };
}

type ItemBody = {
  kind?: ItemKind;
  name: string;
  aliases?: string[];
  category_id?: string | null;
  location_id?: string | null;
  belongs_to_person_id?: string | null;
  state?: ItemState;
  quantity?: number;
  unit?: string | null;
  min_quantity?: number | null;
  price_amount_minor?: number | null;
  price_currency?: string | null;
  purchase_url?: string | null;
  notes?: string | null;
  tags?: string[];
  attributes?: Record<string, unknown>;
  private_to?: string | null;
  acquired_at?: string | null;
};

function toInput(b: Partial<ItemBody>): Partial<ItemInput> {
  const map: Record<keyof ItemBody, keyof ItemInput> = {
    kind: 'kind', name: 'name', aliases: 'aliases', category_id: 'categoryId', location_id: 'locationId',
    belongs_to_person_id: 'belongsToPersonId', state: 'state', quantity: 'quantity', unit: 'unit',
    min_quantity: 'minQuantity', price_amount_minor: 'priceAmountMinor', price_currency: 'priceCurrency',
    purchase_url: 'purchaseUrl', notes: 'notes', tags: 'tags', attributes: 'attributes', private_to: 'privateTo',
    acquired_at: 'acquiredAt',
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) if (v !== undefined) out[map[k as keyof ItemBody]] = v;
  return out as Partial<ItemInput>;
}

const listQuery = {
  type: 'object',
  properties: {
    q: { type: 'string', maxLength: 200 },
    location_id: uuid,
    category_id: uuid,
    state: { type: 'string', description: 'comma-separated states; "active" = owned, lent, unknown' },
    kind: { type: 'string', enum: ['durable', 'supply'] },
    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    offset: { type: 'integer', minimum: 0, default: 0 },
  },
  additionalProperties: false,
} as const;

function parseStates(s: string | undefined): ItemState[] | undefined {
  if (!s) return undefined;
  const out = new Set<ItemState>();
  for (const part of s.split(',').map((x) => x.trim())) {
    if (part === 'active') ['owned', 'lent', 'unknown'].forEach((x) => out.add(x as ItemState));
    else if ((ITEM_STATES as readonly string[]).includes(part)) out.add(part as ItemState);
  }
  return [...out];
}

export async function inventoryRoutes(app: FastifyInstance): Promise<void> {
  for (const s of [locationSchema, categorySchema, itemSchema, eventSchema]) app.addSchema(s);
  const pool = () => app.deps.pool;

  // ── locations ──
  app.get('/api/v1/locations', {
    schema: { summary: 'All locations (flat; build the tree from parent_id)', tags: ['locations'], response: { 200: { type: 'array', items: { $ref: 'Location#' } } } },
  }, async (req) => listLocations(pool(), actorOf(req).householdId, actorOf(req).memberId));

  app.post<{ Body: { parent_id: string | null; kind: LocationKind; name: string; notes?: string | null } }>('/api/v1/locations', {
    schema: {
      summary: 'Create a location', tags: ['locations'],
      body: {
        type: 'object',
        properties: { parent_id: nullableUuid, kind: { type: 'string', enum: LOCATION_KINDS }, name, notes: nullableString(2000) },
        required: ['kind', 'name'], additionalProperties: false,
      },
      response: { 201: { $ref: 'Location#' } },
    },
  }, async (req, reply) => {
    const loc = await createLocation(pool(), actorOf(req), { parentId: req.body.parent_id ?? null, kind: req.body.kind, name: req.body.name, notes: req.body.notes });
    return reply.code(201).send({ ...loc, item_count: 0 });
  });

  app.patch<{ Params: { id: string }; Body: { parent_id?: string | null; kind?: LocationKind; name?: string; notes?: string | null; sort_order?: number } }>(
    '/api/v1/locations/:id', {
      schema: {
        summary: 'Rename, re-kind or move a location', tags: ['locations'], params: idParams,
        body: {
          type: 'object',
          properties: { parent_id: nullableUuid, kind: { type: 'string', enum: LOCATION_KINDS }, name, notes: nullableString(2000), sort_order: { type: 'integer' } },
          minProperties: 1, additionalProperties: false,
        },
        response: { 200: { $ref: 'Location#' } },
      },
    }, async (req) => updateLocation(pool(), actorOf(req), req.params.id, {
      parentId: req.body.parent_id, kind: req.body.kind, name: req.body.name, notes: req.body.notes, sortOrder: req.body.sort_order,
    }),
  );

  app.delete<{ Params: { id: string } }>('/api/v1/locations/:id', {
    schema: { summary: 'Delete an empty location', tags: ['locations'], params: idParams, response: { 204: { type: 'null' } } },
  }, async (req, reply) => {
    await deleteLocation(pool(), actorOf(req), req.params.id);
    return reply.code(204).send();
  });

  // ── categories ──
  app.get('/api/v1/categories', {
    schema: { summary: 'All categories (flat; build the tree from parent_id)', tags: ['categories'], response: { 200: { type: 'array', items: { $ref: 'Category#' } } } },
  }, async (req) => listCategories(pool(), actorOf(req).householdId, actorOf(req).memberId));

  const kindOrNull = { anyOf: [{ type: 'string', enum: ['durable', 'supply'] }, { type: 'null' }] } as const;
  app.post<{ Body: { parent_id?: string | null; name: string; default_kind?: ItemKind | null } }>('/api/v1/categories', {
    schema: {
      summary: 'Create a category', tags: ['categories'],
      body: { type: 'object', properties: { parent_id: nullableUuid, name, default_kind: kindOrNull }, required: ['name'], additionalProperties: false },
      response: { 201: { $ref: 'Category#' } },
    },
  }, async (req, reply) => {
    const c = await createCategory(pool(), actorOf(req), { parentId: req.body.parent_id ?? null, name: req.body.name, defaultKind: req.body.default_kind });
    return reply.code(201).send({ ...c, item_count: 0 });
  });

  app.patch<{ Params: { id: string }; Body: { parent_id?: string | null; name?: string; default_kind?: ItemKind | null; assume_consumed_after_months?: number | null } }>(
    '/api/v1/categories/:id', {
      schema: {
        summary: 'Rename or move a category', tags: ['categories'], params: idParams,
        body: {
          type: 'object',
          properties: {
            parent_id: nullableUuid, name, default_kind: kindOrNull,
            assume_consumed_after_months: { anyOf: [{ type: 'integer', minimum: 1, maximum: 600 }, { type: 'null' }] },
          },
          minProperties: 1, additionalProperties: false,
        },
        response: { 200: { $ref: 'Category#' } },
      },
    }, async (req) => updateCategory(pool(), actorOf(req), req.params.id, {
      parentId: req.body.parent_id, name: req.body.name, defaultKind: req.body.default_kind, assumeConsumedAfterMonths: req.body.assume_consumed_after_months,
    }),
  );

  app.delete<{ Params: { id: string } }>('/api/v1/categories/:id', {
    schema: { summary: 'Delete an unused category', tags: ['categories'], params: idParams, response: { 204: { type: 'null' } } },
  }, async (req, reply) => {
    await deleteCategory(pool(), actorOf(req), req.params.id);
    return reply.code(204).send();
  });

  // ── items ──
  app.get<{ Querystring: { q?: string; location_id?: string; category_id?: string; state?: string; kind?: ItemKind; limit?: number; offset?: number } }>(
    '/api/v1/items', {
      schema: {
        summary: 'List or search items', tags: ['items'], querystring: listQuery,
        response: { 200: { type: 'object', properties: { total: { type: 'integer' }, items: { type: 'array', items: { $ref: 'Item#' } } }, required: ['total', 'items'] } },
      },
    }, async (req) => {
      const a = actorOf(req);
      const page = await listItems(pool(), a.householdId, a.memberId, {
        q: req.query.q, locationId: req.query.location_id, categoryId: req.query.category_id,
        states: parseStates(req.query.state), kind: req.query.kind, limit: req.query.limit, offset: req.query.offset,
      });
      return { total: page.total, items: page.items.map(presentItem) };
    },
  );

  app.get<{ Querystring: { q: string } }>('/api/v1/find', {
    schema: {
      summary: '"Do we have X?" without AI: a one-sentence answer plus the matching items',
      tags: ['items'],
      querystring: { type: 'object', properties: { q: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['q'] },
      response: {
        200: {
          type: 'object',
          properties: { terms: { type: 'string' }, answer: { type: 'string' }, items: { type: 'array', items: { $ref: 'Item#' } } },
          required: ['terms', 'answer', 'items'],
        },
      },
    },
  }, async (req) => {
    const a = actorOf(req);
    const terms = extractSearchTerms(req.query.q);
    if (!terms) return { terms, answer: 'What are you looking for?', items: [] };
    const page = await listItems(pool(), a.householdId, a.memberId, { q: terms, limit: 20 });
    return { terms, answer: summariseFind(terms, page.items), items: page.items.map(presentItem) };
  });

  app.post<{ Body: ItemBody }>('/api/v1/items', {
    schema: {
      summary: 'Create an item', tags: ['items'],
      body: { type: 'object', properties: itemWriteProperties, required: ['name'], additionalProperties: false },
      response: { 201: { $ref: 'Item#' } },
    },
  }, async (req, reply) => reply.code(201).send(presentItem(await createItem(pool(), actorOf(req), toInput(req.body) as ItemInput))));

  app.get<{ Params: { id: string } }>('/api/v1/items/:id', {
    schema: { summary: 'One item', tags: ['items'], params: idParams, response: { 200: { $ref: 'Item#' } } },
  }, async (req) => presentItem(await getItem(pool(), actorOf(req).householdId, actorOf(req).memberId, req.params.id)));

  app.patch<{ Params: { id: string }; Body: Partial<ItemBody> }>('/api/v1/items/:id', {
    schema: {
      summary: 'Update item fields', tags: ['items'], params: idParams,
      body: { type: 'object', properties: itemWriteProperties, minProperties: 1, additionalProperties: false },
      response: { 200: { $ref: 'Item#' } },
    },
  }, async (req) => presentItem(await updateItem(pool(), actorOf(req), req.params.id, toInput(req.body))));

  app.delete<{ Params: { id: string } }>('/api/v1/items/:id', {
    schema: { summary: 'Delete an item entered by mistake (its history stays in the event log)', tags: ['items'], params: idParams, response: { 204: { type: 'null' } } },
  }, async (req, reply) => {
    await deleteItem(pool(), actorOf(req), req.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string }; Body: { location_id: string | null } }>('/api/v1/items/:id/move', {
    schema: {
      summary: 'Move one item', tags: ['items'], params: idParams,
      body: { type: 'object', properties: { location_id: nullableUuid }, required: ['location_id'], additionalProperties: false },
      response: { 200: { $ref: 'Item#' } },
    },
  }, async (req) => presentItem(await updateItem(pool(), actorOf(req), req.params.id, { locationId: req.body.location_id })));

  app.post<{ Body: { item_ids: string[]; location_id: string | null } }>('/api/v1/items/move', {
    schema: {
      summary: 'Move several items at once', tags: ['items'],
      body: {
        type: 'object',
        properties: { item_ids: { type: 'array', items: uuid, minItems: 1, maxItems: 500 }, location_id: nullableUuid },
        required: ['item_ids', 'location_id'], additionalProperties: false,
      },
      response: { 200: { type: 'object', properties: { moved: { type: 'integer' } }, required: ['moved'] } },
    },
  }, async (req) => ({ moved: await moveItems(pool(), actorOf(req), req.body.item_ids, req.body.location_id) }));

  app.post<{ Params: { id: string }; Body: { state: ItemState } }>('/api/v1/items/:id/state', {
    schema: {
      summary: 'Change the lifecycle state (sold, given away, lent, …)', tags: ['items'], params: idParams,
      body: { type: 'object', properties: { state: { type: 'string', enum: ITEM_STATES } }, required: ['state'], additionalProperties: false },
      response: { 200: { $ref: 'Item#' } },
    },
  }, async (req) => presentItem(await updateItem(pool(), actorOf(req), req.params.id, { state: req.body.state })));

  // ── events ──
  app.get<{ Querystring: { entity?: string; entity_id?: string; before?: string; limit?: number } }>('/api/v1/events', {
    schema: {
      summary: 'Change history, newest first', tags: ['events'],
      querystring: {
        type: 'object',
        properties: {
          entity: { type: 'string', enum: ['item', 'location', 'category', 'document'] },
          entity_id: uuid,
          before: { type: 'string', format: 'date-time' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
        additionalProperties: false,
      },
      response: { 200: { type: 'array', items: { $ref: 'Event#' } } },
    },
  }, async (req) =>
    listEvents(pool(), actorOf(req).householdId, actorOf(req).memberId, {
      entity: req.query.entity, entityId: req.query.entity_id, before: req.query.before ? new Date(req.query.before) : undefined, limit: req.query.limit,
    }),
  );
}
