// Shared JSON schemas: request validation and the OpenAPI contract.
export const uuid = { type: 'string', format: 'uuid' } as const;
export const nullableUuid = { anyOf: [uuid, { type: 'null' }] } as const;
export const nullableString = (maxLength: number) => ({ anyOf: [{ type: 'string', maxLength }, { type: 'null' }] }) as const;
export const name = { type: 'string', minLength: 1, maxLength: 200 } as const;
export const idParams = { type: 'object', properties: { id: uuid }, required: ['id'] } as const;
export const timestamp = { type: 'string', format: 'date-time' } as const;

export const ITEM_STATES = ['owned', 'unknown', 'lent', 'sold', 'given_away', 'disposed', 'lost', 'returned', 'consumed'] as const;
export const LOCATION_KINDS = ['site', 'room', 'spot', 'container'] as const;

export const locationSchema = {
  $id: 'Location',
  type: 'object',
  properties: {
    id: uuid,
    parent_id: nullableUuid,
    kind: { type: 'string', enum: LOCATION_KINDS },
    name: { type: 'string' },
    notes: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    photo_document_id: nullableUuid,
    sort_order: { type: 'integer' },
    item_count: { type: 'integer', description: 'items in the house directly at this location' },
    created_at: timestamp,
    updated_at: timestamp,
  },
  required: ['id', 'parent_id', 'kind', 'name', 'notes', 'sort_order', 'created_at', 'updated_at'],
  additionalProperties: false,
} as const;

export const categorySchema = {
  $id: 'Category',
  type: 'object',
  properties: {
    id: uuid,
    parent_id: nullableUuid,
    name: { type: 'string' },
    default_kind: { anyOf: [{ type: 'string', enum: ['durable', 'supply'] }, { type: 'null' }] },
    assume_consumed_after_months: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    item_count: { type: 'integer' },
    created_at: timestamp,
    updated_at: timestamp,
  },
  required: ['id', 'parent_id', 'name', 'default_kind', 'created_at', 'updated_at'],
  additionalProperties: false,
} as const;

const stringArray = { type: 'array', items: { type: 'string', maxLength: 100 }, maxItems: 50 } as const;

export const itemSchema = {
  $id: 'Item',
  type: 'object',
  properties: {
    id: uuid,
    kind: { type: 'string', enum: ['durable', 'supply'] },
    name: { type: 'string' },
    aliases: stringArray,
    category_id: nullableUuid,
    category_path: stringArray,
    location_id: nullableUuid,
    location_path: stringArray,
    belongs_to_person_id: nullableUuid,
    state: { type: 'string', enum: ITEM_STATES },
    quantity: { type: 'number' },
    unit: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    min_quantity: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    price_amount_minor: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'in the minor unit of price_currency' },
    price_currency: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    purchase_url: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    notes: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    tags: stringArray,
    attributes: { type: 'object', additionalProperties: true },
    private_to: nullableUuid,
    acquired_at: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
    last_used_at: { anyOf: [timestamp, { type: 'null' }] },
    photos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          document_id: uuid,
          url: { type: 'string' },
          thumb_url: { type: 'string' },
          width: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          height: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        },
        required: ['document_id', 'url', 'thumb_url'],
      },
    },
    created_at: timestamp,
    updated_at: timestamp,
  },
  required: ['id', 'kind', 'name', 'state', 'quantity', 'location_path', 'category_path', 'photos', 'created_at', 'updated_at'],
  additionalProperties: false,
} as const;

/** Writable item fields (POST requires name; PATCH accepts any subset). */
export const itemWriteProperties = {
  kind: { type: 'string', enum: ['durable', 'supply'] },
  name,
  aliases: stringArray,
  category_id: nullableUuid,
  location_id: nullableUuid,
  belongs_to_person_id: nullableUuid,
  state: { type: 'string', enum: ITEM_STATES },
  quantity: { type: 'number', minimum: 0, maximum: 1e9 },
  unit: nullableString(30),
  min_quantity: { anyOf: [{ type: 'number', minimum: 0, maximum: 1e9 }, { type: 'null' }] },
  price_amount_minor: { anyOf: [{ type: 'integer', minimum: 0, maximum: 1e13 }, { type: 'null' }] },
  price_currency: { anyOf: [{ type: 'string', pattern: '^[A-Z]{3}$' }, { type: 'null' }] },
  purchase_url: { anyOf: [{ type: 'string', maxLength: 2000, pattern: '^https?://' }, { type: 'null' }] },
  notes: nullableString(5000),
  tags: stringArray,
  attributes: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean', 'null'] }, maxProperties: 30 },
  private_to: nullableUuid,
  acquired_at: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
} as const;

export const eventSchema = {
  $id: 'Event',
  type: 'object',
  properties: {
    id: uuid,
    actor_member_id: nullableUuid,
    actor_name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    type: { type: 'string' },
    entity: { type: 'string' },
    entity_id: uuid,
    before: {},
    after: {},
    capture_id: nullableUuid,
    undone_by: nullableUuid,
    created_at: timestamp,
  },
  required: ['id', 'type', 'entity', 'entity_id', 'created_at'],
} as const;

/** Registered once on the root instance so every route plugin can $ref them. */
export const sharedSchemas = [locationSchema, categorySchema, itemSchema, eventSchema] as const;
