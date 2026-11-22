import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import sharp, { type Metadata } from 'sharp';

// Keep libvips lean on a shared 4 GB server: no cache, one image at a time per call.
sharp.cache(false);
sharp.concurrency(1);

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAIN_PX = 2000;
const THUMB_PX = 400;
const ACCEPTED = new Set(['jpeg', 'png', 'webp', 'gif', 'avif', 'tiff']);

export class UnsupportedImageError extends Error {}

export interface StoredImage {
  key: string;          // sha256 of the uploaded bytes
  width: number;
  height: number;
  sizeBytes: number;    // of the stored main file
  mime: 'image/webp';
}

export type Variant = 'main' | 'thumb';

/** Content-addressed path: <media>/ab/<sha256>.webp and <sha256>.thumb.webp */
export function mediaPath(mediaDir: string, key: string, variant: Variant): string {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('invalid media key');
  return join(mediaDir, key.slice(0, 2), variant === 'thumb' ? `${key}.thumb.webp` : `${key}.webp`);
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

async function writeAtomic(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/**
 * Re-encodes a photo: applies EXIF orientation, downsizes to 2000 px (longest side) and a
 * 400 px thumbnail, both WebP. Metadata (including GPS position) is not carried over.
 * Identical uploads map to the same files.
 */
export async function storePhoto(mediaDir: string, input: Buffer): Promise<StoredImage> {
  if (input.length > MAX_UPLOAD_BYTES) throw new UnsupportedImageError('file is larger than 25 MB');
  let meta: Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch {
    throw new UnsupportedImageError('not an image this server can read (iPhone HEIC: send JPEG instead)');
  }
  if (!meta.format || !ACCEPTED.has(meta.format)) {
    throw new UnsupportedImageError(
      meta.format === 'heif' ? 'HEIC photos are not supported; send JPEG (the app converts automatically)' : `unsupported image format: ${meta.format}`,
    );
  }
  const key = createHash('sha256').update(input).digest('hex');
  const mainPath = mediaPath(mediaDir, key, 'main');
  const thumbPath = mediaPath(mediaDir, key, 'thumb');

  const pipeline = sharp(input, { failOn: 'error', limitInputPixels: 100_000_000 }).rotate();
  const main = await pipeline
    .clone()
    .resize({ width: MAIN_PX, height: MAIN_PX, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true });
  if (!(await exists(mainPath))) await writeAtomic(mainPath, main.data);
  if (!(await exists(thumbPath))) {
    const thumb = await pipeline
      .clone()
      .resize({ width: THUMB_PX, height: THUMB_PX, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 70 })
      .toBuffer();
    await writeAtomic(thumbPath, thumb);
  }
  return { key, width: main.info.width, height: main.info.height, sizeBytes: main.data.length, mime: 'image/webp' };
}
