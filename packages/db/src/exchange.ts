import type { Pool, PoolClient } from 'pg';
import { DomainError, tx, type Db } from './util';

/**
 * Tables in an export, in insert order (parents before children).
 * Not exported: api_token (credential hashes) and schema_migration (recorded in the manifest).
 */
export const EXPORT_TABLES = ['household', 'member', 'person', 'document', 'location', 'category', 'item', 'item_document', 'event'] as const;
export type ExportTable = (typeof EXPORT_TABLES)[number];

// Derived columns are rebuilt on import.
const SKIP_COLUMNS: Partial<Record<ExportTable, string[]>> = { item: ['search_text', 'search'] };

export type ExportData = Record<ExportTable, Record<string, unknown>[]>;

/**
 * Everything the member may see, as plain JSON rows ordered by id. Items private to other
 * members are left out, together with their photos, photo links and events.
 */
export async function readExportData(db: Db, householdId: string, memberId: string | null): Promise<{ data: ExportData; excludedPrivateItems: number }> {
  const hidden = await db.query<{ id: string }>(
    'SELECT id FROM item WHERE household_id = $1 AND private_to IS NOT NULL AND private_to IS DISTINCT FROM $2',
    [householdId, memberId],
  );
  const hiddenItems = hidden.rows.map((r) => r.id);
  const hiddenDocs = (
    await db.query<{ document_id: string }>('SELECT document_id FROM item_document WHERE item_id = ANY($1)', [hiddenItems])
  ).rows.map((r) => r.document_id);

  const hh = householdId;
  const filter: Record<ExportTable, [string, unknown[]]> = {
    household: ['t.id = $1', [hh]],
    member: ['t.household_id = $1', [hh]],
    person: ['t.household_id = $1', [hh]],
    document: ['t.household_id = $1 AND NOT (t.id = ANY($2::uuid[]))', [hh, hiddenDocs]],
    location: ['t.household_id = $1', [hh]],
    category: ['t.household_id = $1', [hh]],
    item: ['t.household_id = $1 AND NOT (t.id = ANY($2::uuid[]))', [hh, hiddenItems]],
    item_document: [
      'EXISTS (SELECT 1 FROM item i WHERE i.id = t.item_id AND i.household_id = $1) AND NOT (t.item_id = ANY($2::uuid[]))',
      [hh, hiddenItems],
    ],
    event: ['t.household_id = $1 AND NOT (t.entity_id = ANY($2::uuid[]))', [hh, hiddenItems]],
  };
  const data = {} as ExportData;
  for (const table of EXPORT_TABLES) {
    const skip = SKIP_COLUMNS[table] ?? [];
    const order = table === 'item_document' ? 't.item_id, t.document_id' : 't.id';
    const [where, params] = filter[table];
    const { rows } = await db.query<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(t) ${skip.map((c) => `- '${c}'`).join(' ')} AS row FROM ${table} t WHERE ${where} ORDER BY ${order}`,
      params,
    );
    data[table] = rows.map((r) => r.row);
  }
  return { data, excludedPrivateItems: hiddenItems.length };
}

/** Parents before children, for self-referencing tables. */
function topological(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const byId = new Map(rows.map((r) => [r.id as string, r]));
  const out: Record<string, unknown>[] = [];
  const done = new Set<string>();
  const visit = (r: Record<string, unknown>, depth: number) => {
    if (done.has(r.id as string)) return;
    if (depth > 1000) throw new DomainError('invalid', 'cycle in exported tree');
    const parent = r.parent_id ? byId.get(r.parent_id as string) : undefined;
    if (parent) visit(parent, depth + 1);
    done.add(r.id as string);
    out.push(r);
  };
  rows.forEach((r) => visit(r, 0));
  return out;
}

async function columnsOf(c: PoolClient, table: string): Promise<Map<string, string>> {
  const { rows } = await c.query<{ column_name: string; data_type: string }>(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
    [table],
  );
  return new Map(rows.map((r) => [r.column_name, r.data_type]));
}

/**
 * Loads an export into a database that has no household yet. Column names are checked
 * against the live schema; values go in as parameters. All or nothing.
 */
export async function writeExportData(pool: Pool, data: ExportData): Promise<Record<ExportTable, number>> {
  return tx(pool, async (c) => {
    const existing = await c.query('SELECT 1 FROM household LIMIT 1');
    if (existing.rowCount) throw new DomainError('conflict', 'this database already has a household; import only into an empty one');
    if ((data.household ?? []).length !== 1) throw new DomainError('invalid', 'export must contain exactly one household');
    const counts = {} as Record<ExportTable, number>;
    for (const table of EXPORT_TABLES) {
      let rows = data[table] ?? [];
      if (table === 'location' || table === 'category') rows = topological(rows);
      const allowed = await columnsOf(c, table);
      for (const row of rows) {
        const r = { ...row };
        if (table === 'event') delete r.undone_by; // set after all events exist
        const cols = Object.keys(r).filter((k) => allowed.has(k));
        const unknown = Object.keys(r).filter((k) => !allowed.has(k));
        if (unknown.length) throw new DomainError('invalid', `${table}: unknown columns ${unknown.join(', ')}`);
        // json/jsonb values are sent as JSON text; everything else (text[], dates, numbers) as is.
        const values = cols.map((k) => (allowed.get(k)?.startsWith('json') && r[k] !== null ? JSON.stringify(r[k]) : r[k]));
        await c.query(
          `INSERT INTO ${table} (${cols.map((k) => `"${k}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
          values,
        );
      }
      counts[table] = rows.length;
    }
    for (const e of data.event ?? []) {
      if (e.undone_by) await c.query('UPDATE event SET undone_by = $2 WHERE id = $1', [e.id, e.undone_by]);
    }
    // updated_at was overwritten by triggers only on UPDATE; inserts keep the exported values.
    return counts;
  });
}
