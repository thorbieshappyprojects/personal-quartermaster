import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';
import { EXPORT_TABLES, readExportData, writeExportData, type ExportData, type Pool } from '@pq/db';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { mediaPath } from './media';

export const EXPORT_FORMAT = 'personal-quartermaster-export';
export const EXPORT_VERSION = 1;

const README = `Personal Quartermaster export
=============================

manifest.json     format, version, export time, app commit and row counts
data/<table>.json one JSON array per table, rows ordered by id; money is an
                  integer in the currency's minor unit plus an ISO 4217 code
media/<key>.webp  photos (2000 px) and <key>.thumb.webp (400 px), named by the
                  document's storage_key

Not included: API token hashes. Items private to other members are left out.
Import into an empty installation with: pq import <this file>
`;

/** Streams a zip with all data the member may see and the photos it references. */
export async function buildExport(
  pool: Pool,
  mediaDir: string,
  householdId: string,
  memberId: string | null,
): Promise<{ stream: Readable; filename: string }> {
  const { data, excludedPrivateItems } = await readExportData(pool, householdId, memberId);
  const migrations = (await pool.query<{ name: string }>('SELECT name FROM schema_migration ORDER BY name')).rows.map((r) => r.name);
  const zip = new yazl.ZipFile();
  const manifest = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    app_commit: process.env.GIT_COMMIT ?? 'unknown',
    schema_migrations: migrations,
    counts: Object.fromEntries(EXPORT_TABLES.map((t) => [t, data[t].length])),
    excluded_private_items: excludedPrivateItems,
  };
  zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), 'manifest.json');
  zip.addBuffer(Buffer.from(README), 'README.txt');
  for (const t of EXPORT_TABLES) zip.addBuffer(Buffer.from(JSON.stringify(data[t], null, 1) + '\n'), `data/${t}.json`);

  const keys = [...new Set(data.document.map((d) => d.storage_key as string))].sort();
  for (const key of keys) {
    for (const variant of ['main', 'thumb'] as const) {
      const p = mediaPath(mediaDir, key, variant);
      const st = await stat(p).catch(() => null);
      if (st) zip.addReadStream(createReadStream(p), `media/${p.split('/').pop()}`, { size: st.size });
    }
  }
  zip.end();
  const date = manifest.exported_at.slice(0, 10);
  return { stream: zip.outputStream as unknown as Readable, filename: `personal-quartermaster-export-${date}.zip` };
}

/**
 * Reads a zip into memory. `accept` picks the entries to read; `maxBytes` caps the total
 * uncompressed size of those (a guard against zip bombs).
 */
export function readZip(buf: Buffer, opts: { accept?: (name: string) => boolean; maxBytes?: number } = {}): Promise<Map<string, Buffer>> {
  const accept = opts.accept ?? (() => true);
  const maxBytes = opts.maxBytes ?? Number.MAX_SAFE_INTEGER;
  let total = 0;
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('unreadable zip'));
      const files = new Map<string, Buffer>();
      zip.on('entry', (entry: yauzl.Entry) => {
        if (/\/$/.test(entry.fileName) || !accept(entry.fileName)) return zip.readEntry();
        total += entry.uncompressedSize;
        if (total > maxBytes) return reject(new Error('zip content too large'));
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e);
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            files.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
          stream.on('error', reject);
        });
      });
      zip.on('end', () => resolve(files));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

/** Imports an export zip into an empty installation: data first (one transaction), then photos. */
export async function importExport(pool: Pool, mediaDir: string, zipBytes: Buffer): Promise<Record<string, number>> {
  const files = await readZip(zipBytes);
  const manifestRaw = files.get('manifest.json');
  if (!manifestRaw) throw new Error('not an export: manifest.json missing');
  const manifest = JSON.parse(manifestRaw.toString('utf8')) as { format?: string; version?: number };
  if (manifest.format !== EXPORT_FORMAT) throw new Error('not a Personal Quartermaster export');
  if (manifest.version !== EXPORT_VERSION) throw new Error(`unsupported export version ${manifest.version}`);

  const data = {} as ExportData;
  for (const t of EXPORT_TABLES) {
    const raw = files.get(`data/${t}.json`);
    data[t] = raw ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>[]) : [];
  }
  const counts = await writeExportData(pool, data);

  let media = 0;
  for (const [name, content] of files) {
    const m = /^media\/([0-9a-f]{64})(\.thumb)?\.webp$/.exec(name);
    if (!m) continue;
    const p = mediaPath(mediaDir, m[1]!, m[2] ? 'thumb' : 'main');
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content);
    media++;
  }
  return { ...counts, media_files: media };
}

export async function importExportFile(pool: Pool, mediaDir: string, path: string): Promise<Record<string, number>> {
  return importExport(pool, mediaDir, await readFile(path));
}
