import { createHash } from 'node:crypto';
import { decodeText, parseOrders, type ParseOptions, type ParseResult } from '@pq/importers';
import { readZip } from './exchange';

export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;

export class ImportFileError extends Error {}

export interface ImportFile {
  name: string;
  text: string;
}

const isZip = (buf: Buffer) => buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;

/**
 * The CSV files inside an upload. A zip is searched for Amazon's Retail.OrderHistory CSVs
 * (the numeric suffix varies), else for any CSV; only those entries are decompressed.
 */
export async function readImportFiles(buf: Buffer, filename: string): Promise<ImportFile[]> {
  if (!isZip(buf)) return [{ name: filename, text: decodeText(buf) }];
  let entries: Map<string, Buffer>;
  try {
    const amazon = await readZip(buf, { accept: (n) => /(^|\/)Retail\.OrderHistory[^/]*\.csv$/i.test(n), maxBytes: MAX_UNZIPPED_BYTES });
    entries = amazon.size ? amazon : await readZip(buf, { accept: (n) => /\.(csv|tsv|txt)$/i.test(n) && !/(^|\/)(__MACOSX|\.)/.test(n), maxBytes: MAX_UNZIPPED_BYTES });
  } catch (err) {
    throw new ImportFileError(`could not read the zip: ${(err as Error).message}`);
  }
  if (!entries.size) throw new ImportFileError('the zip contains no CSV file (for Amazon: Retail.OrderHistory.*.csv)');
  return [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([name, content]) => ({ name, text: decodeText(content) }));
}

export interface CombinedParse extends ParseResult {
  files: string[];
}

/** Parses every file with the same options; results are concatenated. */
export function parseImportFiles(files: ImportFile[], opts: ParseOptions): CombinedParse {
  const parts = files.map((f) => ({ f, r: parseOrders(f.text, opts) }));
  const first = parts[0]!.r;
  return {
    ...first,
    files: files.map((f) => f.name),
    rowCount: parts.reduce((s, p) => s + p.r.rowCount, 0),
    lineCount: parts.reduce((s, p) => s + p.r.lineCount, 0),
    purchases: parts.flatMap((p) => p.r.purchases),
    errors: parts.flatMap((p) => p.r.errors.map((e) => (files.length > 1 ? { ...e, message: `${p.f.name}: ${e.message}` } : e))),
  };
}

export const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

