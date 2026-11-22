import {
  createDependant,
  createMember,
  getHousehold,
  listMembers,
  listPersons,
  renameDependant,
  updateMember,
  type Role,
} from '@pq/db';
import type { FastifyInstance } from 'fastify';
import { requireOwner } from '../auth';

const uuid = { type: 'string', format: 'uuid' } as const;
const name = { type: 'string', minLength: 1, maxLength: 100 } as const;
const role = { type: 'string', enum: ['owner', 'member'] } as const;
const timestamps = {
  created_at: { type: 'string', format: 'date-time' },
  updated_at: { type: 'string', format: 'date-time' },
} as const;

const memberSchema = {
  $id: 'Member',
  type: 'object',
  properties: {
    id: uuid,
    display_name: { type: 'string' },
    email: { type: 'string' },
    role,
    notification_settings: { type: 'object', additionalProperties: true },
    ...timestamps,
  },
  required: ['id', 'display_name', 'email', 'role', 'notification_settings', 'created_at', 'updated_at'],
  additionalProperties: false,
} as const;

const personSchema = {
  $id: 'Person',
  type: 'object',
  properties: {
    id: uuid,
    display_name: { type: 'string' },
    kind: { type: 'string', enum: ['member', 'dependant'] },
    member_id: { anyOf: [uuid, { type: 'null' }] },
    ...timestamps,
  },
  required: ['id', 'display_name', 'kind', 'member_id', 'created_at', 'updated_at'],
  additionalProperties: false,
} as const;

const householdSchema = {
  $id: 'Household',
  type: 'object',
  properties: { id: uuid, name: { type: 'string' }, base_currency: { type: 'string' } },
  required: ['id', 'name', 'base_currency'],
  additionalProperties: false,
} as const;

const idParams = { type: 'object', properties: { id: uuid }, required: ['id'] } as const;
const tags = ['household'];

export async function memberRoutes(app: FastifyInstance): Promise<void> {
  app.addSchema(memberSchema);
  app.addSchema(personSchema);
  app.addSchema(householdSchema);

  app.get(
    '/api/v1/me',
    {
      schema: {
        summary: 'The calling member and their household',
        tags,
        response: {
          200: {
            type: 'object',
            properties: { member: { $ref: 'Member#' }, household: { $ref: 'Household#' }, via: { type: 'string' } },
            required: ['member', 'household', 'via'],
          },
        },
      },
    },
    async (req) => ({
      member: req.identity.member,
      household: await getHousehold(app.deps.pool),
      via: req.identity.via,
    }),
  );

  app.get(
    '/api/v1/members',
    { schema: { summary: 'List members', tags, response: { 200: { type: 'array', items: { $ref: 'Member#' } } } } },
    async (req) => listMembers(app.deps.pool, req.identity.member.household_id),
  );

  app.post<{ Body: { email: string; display_name: string; role?: Role } }>(
    '/api/v1/members',
    {
      schema: {
        summary: 'Add a member (owner only). They also need to be on the Access allow list.',
        tags,
        body: {
          type: 'object',
          properties: { email: { type: 'string', format: 'email', maxLength: 254 }, display_name: name, role },
          required: ['email', 'display_name'],
          additionalProperties: false,
        },
        response: { 201: { $ref: 'Member#' } },
      },
    },
    async (req, reply) => {
      if (requireOwner(req, reply)) return reply;
      const m = await createMember(app.deps.pool, req.identity.member.household_id, {
        email: req.body.email,
        displayName: req.body.display_name,
        role: req.body.role ?? 'member',
      });
      return reply.code(201).send(m);
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { display_name?: string; role?: Role; notification_settings?: Record<string, unknown> };
  }>(
    '/api/v1/members/:id',
    {
      schema: {
        summary: 'Update a member. Owners may change anyone; members only their own name and notification settings.',
        tags,
        params: idParams,
        body: {
          type: 'object',
          properties: {
            display_name: name,
            role,
            notification_settings: { type: 'object', additionalProperties: true },
          },
          minProperties: 1,
          additionalProperties: false,
        },
        response: { 200: { $ref: 'Member#' } },
      },
    },
    async (req, reply) => {
      const me = req.identity.member;
      const self = req.params.id === me.id;
      if (me.role !== 'owner' && (!self || req.body.role !== undefined)) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      return updateMember(app.deps.pool, me.household_id, req.params.id, {
        displayName: req.body.display_name,
        role: req.body.role,
        notificationSettings: req.body.notification_settings,
      });
    },
  );

  app.get(
    '/api/v1/persons',
    {
      schema: {
        summary: 'Members and dependants (targets for "belongs to")',
        tags,
        response: { 200: { type: 'array', items: { $ref: 'Person#' } } },
      },
    },
    async (req) => listPersons(app.deps.pool, req.identity.member.household_id),
  );

  app.post<{ Body: { display_name: string } }>(
    '/api/v1/persons',
    {
      schema: {
        summary: 'Add a dependant (child, pet) without a login',
        tags,
        body: { type: 'object', properties: { display_name: name }, required: ['display_name'], additionalProperties: false },
        response: { 201: { $ref: 'Person#' } },
      },
    },
    async (req, reply) =>
      reply.code(201).send(await createDependant(app.deps.pool, req.identity.member.household_id, req.body.display_name)),
  );

  app.patch<{ Params: { id: string }; Body: { display_name: string } }>(
    '/api/v1/persons/:id',
    {
      schema: {
        summary: 'Rename a dependant',
        tags,
        params: idParams,
        body: { type: 'object', properties: { display_name: name }, required: ['display_name'], additionalProperties: false },
        response: { 200: { $ref: 'Person#' } },
      },
    },
    async (req) => renameDependant(app.deps.pool, req.identity.member.household_id, req.params.id, req.body.display_name),
  );
}
