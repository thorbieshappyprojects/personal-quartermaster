import type { FastifyInstance } from 'fastify';
import { buildExport } from '../exchange';

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v1/export', {
    schema: {
      summary: 'Full export (zip): all data you can see, as JSON per table, plus photos',
      tags: ['export'],
      produces: ['application/zip'],
    },
  }, async (req, reply) => {
    const { stream, filename } = await buildExport(
      app.deps.pool, app.deps.config.mediaDir, req.identity.member.household_id, req.identity.member.id,
    );
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('cache-control', 'no-store')
      .send(stream);
  });
}
