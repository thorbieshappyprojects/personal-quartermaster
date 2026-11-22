import { readZip } from './exchange';

export interface FxRate {
  currency: string;
  day: string;
  perEur: number;
}

/** Where rates come from; injectable for tests (no network in tests or CI). */
export type FxSource = () => Promise<FxRate[]>;

// The ECB's euro foreign exchange reference rates since 1999, one CSV in a zip, free to reuse.
export const ECB_HISTORY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.zip';

/** Parses the ECB history CSV: "Date,USD,JPY,…" then one row per day, "N/A" where none. */
export function parseEcbCsv(text: string): FxRate[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = (lines.shift() ?? '').split(',').map((h) => h.trim());
  const out: FxRate[] = [];
  for (const line of lines) {
    const cells = line.split(',').map((c) => c.trim());
    const day = cells[0];
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    for (let i = 1; i < head.length; i++) {
      const cur = head[i]!;
      const v = Number(cells[i]);
      if (/^[A-Z]{3}$/.test(cur) && Number.isFinite(v) && v > 0) out.push({ currency: cur, day, perEur: v });
    }
  }
  return out;
}

export const ecbSource: FxSource = async () => {
  const res = await fetch(ECB_HISTORY_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`ECB rates: HTTP ${res.status}`);
  const files = await readZip(Buffer.from(await res.arrayBuffer()), { accept: (n) => n.endsWith('.csv'), maxBytes: 50 * 1024 * 1024 });
  const csv = [...files.values()][0];
  if (!csv) throw new Error('ECB rates: no CSV in the download');
  return parseEcbCsv(csv.toString('utf8'));
};
