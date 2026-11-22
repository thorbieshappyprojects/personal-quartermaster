import { randomBytes } from 'node:crypto';
import { statfs, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from '@pq/db';

const MIN_FREE_RATIO = 0.1;
const TIMEOUT_MS = 2_000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS).unref()),
  ]);
}

async function databaseAnswers(pool: Pool): Promise<boolean> {
  try {
    await withTimeout(pool.query('SELECT 1'));
    return true;
  } catch {
    return false;
  }
}

export type DiskStats = (dir: string) => Promise<{ blocks: number; bavail: number }>;

async function mediaWritable(mediaDir: string, stats: DiskStats): Promise<boolean> {
  const probe = join(mediaDir, `.healthz-${randomBytes(4).toString('hex')}`);
  try {
    await withTimeout(writeFile(probe, 'ok'));
    await unlink(probe);
    const s = await stats(mediaDir);
    return s.blocks > 0 && s.bavail / s.blocks > MIN_FREE_RATIO;
  } catch {
    return false;
  }
}

/** True when the database answers and the media volume is writable with more than 10 % free. */
export async function isHealthy(pool: Pool, mediaDir: string, stats: DiskStats = statfs): Promise<boolean> {
  const [db, media] = await Promise.all([databaseAnswers(pool), mediaWritable(mediaDir, stats)]);
  return db && media;
}
