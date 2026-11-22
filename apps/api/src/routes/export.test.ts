import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, sourceMigrationsDir } from '@pq/db';
import { createTestDatabase } from '@pq/db/testing';
import sharp from 'sharp';
import yauzl from 'yauzl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { importExport } from '../exchange';
import { createTestApp, type TestContext } from '../testing';

function unzip(buf: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const out = new Map<string, Buffer>();
      zip.on('entry', (e: yauzl.Entry) =>
        zip.openReadStream(e, (er, s) => {
          if (er || !s) return reject(er);
          const parts: Buffer[] = [];
          s.on('data', (c: Buffer) => parts.push(c));
          s.on('end', () => {
            out.set(e.fileName, Buffer.concat(parts));
            zip.readEntry();
          });
        }),
      );
      zip.on('end', () => resolve(out));
      zip.readEntry();
    });
  });
}

const dataFiles = (files: Map<string, Buffer>) =>
  Object.fromEntries([...files].filter(([n]) => n.startsWith('data/')).map(([n, b]) => [n, JSON.parse(b.toString())]));

describe('export (H3)', () => {
  let t: TestContext;
  let first: Map<string, Buffer>;

  beforeAll(async () => {
    t = await createTestApp();
    const post = (url: string, payload: unknown) => t.app.inject({ method: 'POST', url, payload: payload as object }).then((r) => r.json());
    const site = await post('/api/v1/locations', { kind: 'site', name: 'Flat' });
    const room = await post('/api/v1/locations', { kind: 'room', name: 'Hall', parent_id: site.id });
    const item = await post('/api/v1/items', {
      name: 'Drill', location_id: room.id, tags: ['tools'], aliases: ['Bohrmaschine'],
      attributes: { brand: 'Makita', voltage: 18 }, price_amount_minor: 12900, price_currency: 'EUR', acquired_at: '2024-02-03',
    });
    await t.app.inject({ method: 'POST', url: `/api/v1/items/${item.id}/state`, payload: { state: 'lent' } });
    const img = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#336699' } }).jpeg().toBuffer();
    const boundary = 'b' + Date.now();
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="d.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      img,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    await t.app.inject({ method: 'POST', url: `/api/v1/items/${item.id}/photos`, payload: body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
    await post('/api/v1/items', { name: 'Private gift', private_to: t.ownerId });
  });
  afterAll(async () => t.close());

  it('produces a zip with manifest, readme, one file per table and the photos', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/export' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="personal-quartermaster-export-\d{4}-\d{2}-\d{2}\.zip"/);
    first = await unzip(res.rawPayload);
    const manifest = JSON.parse(first.get('manifest.json')!.toString());
    expect(manifest).toMatchObject({ format: 'personal-quartermaster-export', version: 1, excluded_private_items: 0 });
    expect(manifest.counts).toMatchObject({ household: 1, member: 1, location: 2, item: 2, document: 1, item_document: 1 });
    expect(first.has('README.txt')).toBe(true);
    expect([...first.keys()].filter((k) => k.startsWith('media/'))).toHaveLength(2);
    const items = JSON.parse(first.get('data/item.json')!.toString());
    expect(items[0]).not.toHaveProperty('search_text');
    expect(first.has('data/api_token.json')).toBe(false);
  });

  it('round-trips: import into an empty installation, export again, same data and photos', async () => {
    const db = await createTestDatabase();
    const mediaDir = await mkdtemp(join(tmpdir(), 'pq-media2-'));
    try {
      await migrate(db.pool, sourceMigrationsDir);
      const res = await t.app.inject({ method: 'GET', url: '/api/v1/export' });
      const counts = await importExport(db.pool, mediaDir, res.rawPayload);
      expect(counts).toMatchObject({ item: 2, event: expect.any(Number), media_files: 2 });

      const app2 = await buildApp(
        { config: { ...t.app.deps.config, databaseUrl: db.url, mediaDir }, pool: db.pool, diskStats: async () => ({ blocks: 100, bavail: 50 }) },
        { logger: false },
      );
      const again = await unzip((await app2.inject({ method: 'GET', url: '/api/v1/export' })).rawPayload);
      expect(dataFiles(again)).toEqual(dataFiles(first));
      const media = (files: Map<string, Buffer>) => [...files].filter(([n]) => n.startsWith('media/')).map(([n, b]) => [n, b.length]);
      expect(media(again)).toEqual(media(first));
      // The imported search index works.
      const found = await app2.inject({ method: 'GET', url: '/api/v1/find?q=bohrmaschine' });
      expect(found.json().answer).toBe('Yes: Drill (Flat › Hall, lent out). Last acquired 2024-02-03.');
      expect((await readdir(mediaDir)).length).toBeGreaterThan(0);
      await app2.close();

      // A second import into the now-populated database is refused.
      await expect(importExport(db.pool, mediaDir, res.rawPayload)).rejects.toThrow(/already has a household/);
    } finally {
      await db.drop();
      await rm(mediaDir, { recursive: true, force: true });
    }
  });

  it('leaves out items that are private to someone else', async () => {
    await t.app.inject({ method: 'POST', url: '/api/v1/members', payload: { email: 'm@example.test', display_name: 'M' } });
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/export', headers: { 'x-pq-dev-email': 'm@example.test' } });
    const files = await unzip(res.rawPayload);
    const manifest = JSON.parse(files.get('manifest.json')!.toString());
    expect(manifest.excluded_private_items).toBe(1);
    const names = JSON.parse(files.get('data/item.json')!.toString()).map((i: { name: string }) => i.name);
    expect(names).toEqual(['Drill']);
  });

  it('rejects files that are not exports', async () => {
    const db = await createTestDatabase();
    try {
      await migrate(db.pool, sourceMigrationsDir);
      await expect(importExport(db.pool, '/nonexistent', Buffer.from('not a zip'))).rejects.toThrow();
    } finally {
      await db.drop();
    }
  });
});
