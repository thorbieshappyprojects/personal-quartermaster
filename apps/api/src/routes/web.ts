import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/** Serves the built PWA (behind the same Access gate) with an SPA fallback for client routes. */
export async function webRoutes(app: FastifyInstance, opts: { root: string }): Promise<void> {
  await app.register(fastifyStatic, {
    root: opts.root,
    wildcard: false,
    index: ['index.html'],
    setHeaders(reply, path) {
      // Hashed assets are immutable; the shell, manifest and service worker must revalidate.
      reply.header('cache-control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });

  app.setNotFoundHandler((req, reply) => {
    const isPage = req.method === 'GET' && !req.url.startsWith('/api/') && (req.headers.accept ?? '').includes('text/html');
    if (isPage) return reply.header('cache-control', 'no-cache').sendFile('index.html');
    return reply.code(404).send({ error: 'not_found' });
  });
}
