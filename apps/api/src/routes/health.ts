import type { FastifyInstance } from 'fastify';
import { isHealthy } from '../health';

const okSchema = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
} as const;

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/healthz',
    {
      schema: {
        summary: 'Liveness: database answers and media volume writable with > 10 % free',
        tags: ['system'],
        response: { 200: okSchema, 503: okSchema },
      },
    },
    async (_req, reply) => {
      const ok = await isHealthy(app.deps.pool, app.deps.config.mediaDir, app.deps.diskStats);
      return reply.code(ok ? 200 : 503).send({ ok });
    },
  );
}
