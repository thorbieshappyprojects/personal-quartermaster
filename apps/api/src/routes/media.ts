import { createReadStream } from 'node:fs';
import multipart from '@fastify/multipart';
import { addItemPhoto, getItem, getVisibleDocument, removeItemPhoto } from '@pq/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { MAX_UPLOAD_BYTES, mediaPath, storePhoto, UnsupportedImageError } from '../media';
import { presentItem } from './inventory';
import { uuid } from './schemas';

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 } });

  app.post<{ Params: { id: string } }>('/api/v1/items/:id/photos', {
    schema: {
      summary: 'Add a photo to an item (multipart field "file"; JPEG, PNG, WebP, AVIF)',
      tags: ['items'],
      consumes: ['multipart/form-data'],
      params: { type: 'object', properties: { id: uuid }, required: ['id'] },
      response: { 201: { $ref: 'Item#' } },
    },
  }, async (req, reply) => {
    const { householdId, id: memberId } = { householdId: req.identity.member.household_id, id: req.identity.member.id };
    // Check access before reading the upload.
    await getItem(app.deps.pool, householdId, memberId, req.params.id);
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'invalid_request', message: 'multipart field "file" is required' });
    const buf = await file.toBuffer().catch((err: Error & { code?: string }) => {
      if (err.code === 'FST_REQ_FILE_TOO_LARGE') return null;
      throw err;
    });
    if (!buf) return reply.code(413).send({ error: 'too_large', message: 'files above 25 MB are refused' });
    let stored;
    try {
      stored = await storePhoto(app.deps.config.mediaDir, buf);
    } catch (err) {
      if (err instanceof UnsupportedImageError) return reply.code(415).send({ error: 'unsupported_media', message: err.message });
      throw err;
    }
    const actor = { householdId, memberId };
    await addItemPhoto(app.deps.pool, actor, req.params.id, {
      storageKey: stored.key, mime: stored.mime, sizeBytes: stored.sizeBytes, width: stored.width, height: stored.height,
      originalName: file.filename ? file.filename.slice(0, 200) : null,
    });
    return reply.code(201).send(presentItem(await getItem(app.deps.pool, householdId, memberId, req.params.id)));
  });

  app.delete<{ Params: { id: string; documentId: string } }>('/api/v1/items/:id/photos/:documentId', {
    schema: {
      summary: 'Remove a photo from an item', tags: ['items'],
      params: { type: 'object', properties: { id: uuid, documentId: uuid }, required: ['id', 'documentId'] },
      response: { 204: { type: 'null' } },
    },
  }, async (req, reply) => {
    await removeItemPhoto(app.deps.pool, { householdId: req.identity.member.household_id, memberId: req.identity.member.id }, req.params.id, req.params.documentId);
    return reply.code(204).send();
  });

  const serve = (variant: 'main' | 'thumb') => async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const doc = await getVisibleDocument(app.deps.pool, req.identity.member.household_id, req.identity.member.id, req.params.id);
    const path = mediaPath(app.deps.config.mediaDir, doc.storage_key, variant);
    return reply
      .header('content-type', doc.mime)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('content-disposition', 'inline')
      .send(createReadStream(path));
  };
  const mediaParams = { type: 'object', properties: { id: uuid }, required: ['id'] } as const;
  app.get<{ Params: { id: string } }>('/media/:id', { schema: { summary: 'Photo (2000 px WebP)', tags: ['media'], params: mediaParams } }, serve('main'));
  app.get<{ Params: { id: string } }>('/media/:id/thumb', { schema: { summary: 'Thumbnail (400 px WebP)', tags: ['media'], params: mediaParams } }, serve('thumb'));
}
