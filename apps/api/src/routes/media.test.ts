import { readdir } from 'node:fs/promises';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEV_EMAIL_HEADER } from '../auth';
import { createTestApp, type TestContext } from '../testing';

function multipart(field: string, filename: string, mime: string, data: Buffer) {
  const boundary = '----pqtest' + Math.random().toString(16).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, data, tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

// A 3000×1000 JPEG that should be displayed rotated (orientation 6) and carries a GPS position.
async function phonePhoto(): Promise<Buffer> {
  return sharp({ create: { width: 3000, height: 1000, channels: 3, background: { r: 200, g: 120, b: 40 } } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExifMerge({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '52/1 31/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '13/1 24/1 0/1' } })
    .toBuffer();
}

describe('item photos', () => {
  let t: TestContext;
  let itemId: string;
  let photoBytes: Buffer;

  beforeAll(async () => {
    t = await createTestApp();
    itemId = (await t.app.inject({ method: 'POST', url: '/api/v1/items', payload: { name: 'Lamp' } })).json().id;
    photoBytes = await phonePhoto();
    const meta = await sharp(photoBytes).metadata();
    expect(meta.exif).toBeDefined(); // the fixture really carries EXIF
  });
  afterAll(async () => t.close());

  const upload = (data: Buffer, mime = 'image/jpeg', id = itemId, headers: Record<string, string> = {}) => {
    const m = multipart('file', 'IMG_0001.jpg', mime, data);
    return t.app.inject({ method: 'POST', url: `/api/v1/items/${id}/photos`, payload: m.payload, headers: { ...m.headers, ...headers } });
  };

  it('rotates, downsizes and strips metadata', async () => {
    const res = await upload(photoBytes);
    expect(res.statusCode).toBe(201);
    const photo = res.json().photos[0];
    expect(photo).toMatchObject({ width: 667, height: 2000 });
    expect(photo.url).toBe(`/media/${photo.document_id}`);

    const main = await t.app.inject({ method: 'GET', url: photo.url });
    expect(main.statusCode).toBe(200);
    expect(main.headers['content-type']).toBe('image/webp');
    expect(main.headers['cache-control']).toContain('private');
    const m = await sharp(main.rawPayload).metadata();
    expect([m.width, m.height]).toEqual([667, 2000]);
    expect(m.exif).toBeUndefined();

    const thumb = await t.app.inject({ method: 'GET', url: photo.thumb_url });
    const tm = await sharp(thumb.rawPayload).metadata();
    expect(Math.max(tm.width!, tm.height!)).toBe(400);
  });

  it('stores identical uploads once on disk', async () => {
    await upload(photoBytes);
    const dirs = await readdir(t.mediaDir);
    const files = (await Promise.all(dirs.map((d) => readdir(`${t.mediaDir}/${d}`)))).flat();
    expect(files.filter((f) => !f.startsWith('.'))).toHaveLength(2); // main + thumb, shared by both documents
    const item = (await t.app.inject({ method: 'GET', url: `/api/v1/items/${itemId}` })).json();
    expect(item.photos).toHaveLength(2);
  });

  it('refuses things that are not supported images', async () => {
    const notImage = await upload(Buffer.from('hello'), 'image/jpeg');
    expect(notImage.statusCode).toBe(415);
    const heicLike = await upload(await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).heif({ compression: 'av1' }).toBuffer(), 'image/heic');
    expect([201, 415]).toContain(heicLike.statusCode); // AVIF-in-HEIF decodes; HEVC HEIC does not
    const missing = await t.app.inject({ method: 'POST', url: `/api/v1/items/${itemId}/photos`, payload: {} });
    expect(missing.statusCode).toBe(406);
  });

  it('hides photos of private items from other members', async () => {
    await t.app.inject({ method: 'POST', url: '/api/v1/members', payload: { email: 'm@example.test', display_name: 'M' } });
    const secret = (await t.app.inject({ method: 'POST', url: '/api/v1/items', payload: { name: 'Gift', private_to: t.ownerId } })).json();
    const added = (await upload(photoBytes, 'image/jpeg', secret.id)).json();
    const url = added.photos[0].url;
    const asOther = { [DEV_EMAIL_HEADER]: 'm@example.test' };
    expect((await t.app.inject({ method: 'GET', url, headers: asOther })).statusCode).toBe(404);
    expect((await upload(photoBytes, 'image/jpeg', secret.id, asOther)).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url })).statusCode).toBe(200);
  });

  it('removes a photo and logs it', async () => {
    const item = (await t.app.inject({ method: 'GET', url: `/api/v1/items/${itemId}` })).json();
    const doc = item.photos[0].document_id;
    expect((await t.app.inject({ method: 'DELETE', url: `/api/v1/items/${itemId}/photos/${doc}` })).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: `/media/${doc}` })).statusCode).toBe(404);
    const ev = (await t.app.inject({ method: 'GET', url: `/api/v1/events?entity_id=${itemId}` })).json();
    expect(ev.map((e: { type: string }) => e.type).slice(0, 3)).toEqual(['item.photo_removed', 'item.photo_added', 'item.photo_added']);
  });
});
