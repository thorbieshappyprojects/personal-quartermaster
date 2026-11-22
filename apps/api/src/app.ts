import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from '@pq/db';
import type { Config } from './config';
import type { DiskStats } from './health';
import { healthRoutes } from './routes/health';

export interface AppDeps {
  config: Config;
  pool: Pool;
  /** Override for tests; defaults to fs.statfs. */
  diskStats?: DiskStats;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
}

const BODY_LIMIT = 25 * 1024 * 1024;

export async function buildApp(deps: AppDeps, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : {
      level: deps.config.logLevel,
      // Never log headers: they carry the Access JWT and API tokens.
      serializers: {
        req: (req) => ({ method: req.method, url: req.url.split('?')[0], id: req.id }),
      },
    },
    bodyLimit: BODY_LIMIT,
    trustProxy: true,
  });
  app.decorate('deps', deps);

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Personal Quartermaster API', version: '1' },
      components: {
        securitySchemes: {
          accessJwt: { type: 'apiKey', in: 'header', name: 'Cf-Access-Jwt-Assertion' },
          apiToken: { type: 'http', scheme: 'bearer' },
        },
      },
      security: [{ accessJwt: [] }, { accessJwt: [], apiToken: [] }],
    },
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err }, 'request failed');
      return reply.code(500).send({ error: 'internal_error' });
    }
    return reply.code(status).send({ error: err.validation ? 'invalid_request' : 'request_error', message: err.message });
  });

  await app.register(healthRoutes);

  app.get('/api/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  return app;
}
