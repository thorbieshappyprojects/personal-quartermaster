import { GONE, normaliseText, shortItemName, type GoneReason, type ItemKind, type Possession } from '@pq/core';
import type { Pool, PoolClient } from 'pg';
import { insertItem, itemSnapshot, type ItemRow } from './items';
import { DomainError, tx, writeEvent, type Actor, type Db } from './util';

// ── import ─────────────────────────────────────────────────────────────────

/** Structurally the importers' ParsedPurchase; kept here so the db package has no parser dependency. */
export interface PurchaseImport {
  source: 'amazon_export' | 'taobao' | 'email' | 'photo' | 'csv' | 'manual';
  merchant: string | null;
  externalOrderId: string | null;
  orderedAt: string | null;
  currency: string | null;
  totalMinor: number | null;
  dedupeKey: string;
  lines: {
    title: string;
    quantity: number;
    unitPriceMinor: number | null;
    amountMinor: number | null;
    currency: string | null;
    externalProductId: string | null;
    url: string | null;
    cancelled: boolean;
    dedupeKey: string;
  }[];
}

export interface ImportRunInput {
  source: string;
  format: string;
  filename: string | null;
  sha256: string;
  rowsRead: number;
  errors: { row: number; message: string }[];
}

export interface ImportRun {
  id: string;
  source: string;
  format: string;
  filename: string | null;
  rows_read: number;
  purchases_added: number;
  lines_added: number;
  lines_existing: number;
  lines_auto_closed: number;
  errors: { row: number; message: string }[];
  created_at: Date;
}

const RUN_COLS = 'id, source, format, filename, rows_read, purchases_added, lines_added, lines_existing, lines_auto_closed, errors, created_at';

/**
 * Stores parsed purchases. Purchases and lines already present (same dedupe key) are left
 * untouched, so importing the same or an overlapping file again adds only what is new and
 * never resets a decision. Cancelled lines are closed by rule (ignored). One event per run.
 */
export async function importPurchases(pool: Pool, actor: Actor, run: ImportRunInput, purchases: PurchaseImport[]): Promise<ImportRun> {
  return tx(pool, async (c) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO import_run (household_id, member_id, source, format, filename, sha256, rows_read, errors)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [actor.householdId, actor.memberId, run.source, run.format, run.filename, run.sha256, run.rowsRead, JSON.stringify(run.errors.slice(0, 200))],
    );
    const runId = r.rows[0]!.id;
    let purchasesAdded = 0;
    let linesAdded = 0;
    let linesExisting = 0;
    let autoClosed = 0;
    for (const p of purchases) {
      const ins = await c.query<{ id: string }>(
        `INSERT INTO purchase (household_id, source, merchant, external_order_id, ordered_at, total_amount_minor, currency, buyer_member_id, import_run_id, dedupe_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (household_id, dedupe_key) DO NOTHING RETURNING id`,
        [actor.householdId, p.source, p.merchant, p.externalOrderId, p.orderedAt, p.totalMinor, p.currency, actor.memberId, runId, p.dedupeKey],
      );
      let purchaseId = ins.rows[0]?.id;
      if (purchaseId) purchasesAdded++;
      else {
        purchaseId = (await c.query<{ id: string }>('SELECT id FROM purchase WHERE household_id = $1 AND dedupe_key = $2', [actor.householdId, p.dedupeKey])).rows[0]!.id;
      }
      if (p.lines.length === 0) continue;
      // All lines of a purchase in one statement.
      const res = await c.query<{ possession: string }>(
        `INSERT INTO purchase_line (household_id, purchase_id, position, title, quantity, unit_price_minor, amount_minor, currency,
                                    external_product_id, url, possession, auto_rule, decided_at, dedupe_key)
         SELECT $1, $2, x.position, x.title, x.quantity, x.unit_price_minor, x.amount_minor, x.currency, x.external_product_id, x.url,
                CASE WHEN x.cancelled THEN 'ignored' ELSE 'pending' END,
                CASE WHEN x.cancelled THEN 'cancelled_order' END,
                CASE WHEN x.cancelled THEN now() END,
                x.dedupe_key
           FROM unnest($3::int[], $4::text[], $5::numeric[], $6::bigint[], $7::bigint[], $8::text[], $9::text[], $10::text[], $11::bool[], $12::text[])
                AS x(position, title, quantity, unit_price_minor, amount_minor, currency, external_product_id, url, cancelled, dedupe_key)
         ON CONFLICT (household_id, dedupe_key) DO NOTHING
         RETURNING possession`,
        [
          actor.householdId, purchaseId,
          p.lines.map((_, i) => i), p.lines.map((l) => l.title), p.lines.map((l) => l.quantity),
          p.lines.map((l) => l.unitPriceMinor), p.lines.map((l) => l.amountMinor), p.lines.map((l) => l.currency),
          p.lines.map((l) => l.externalProductId), p.lines.map((l) => l.url), p.lines.map((l) => l.cancelled), p.lines.map((l) => l.dedupeKey),
        ],
      );
      linesAdded += res.rowCount ?? 0;
      linesExisting += p.lines.length - (res.rowCount ?? 0);
      autoClosed += res.rows.filter((x) => x.possession === 'ignored').length;
    }
    const { rows } = await c.query<ImportRun>(
      `UPDATE import_run SET purchases_added = $2, lines_added = $3, lines_existing = $4, lines_auto_closed = $5 WHERE id = $1 RETURNING ${RUN_COLS}`,
      [runId, purchasesAdded, linesAdded, linesExisting, autoClosed],
    );
    await writeEvent(c, actor, {
      type: 'import.completed',
      entity: 'import_run',
      entityId: runId,
      after: { source: run.source, filename: run.filename, purchases_added: purchasesAdded, lines_added: linesAdded, lines_existing: linesExisting, lines_auto_closed: autoClosed },
    });
    return rows[0]!;
  });
}

export async function listImportRuns(db: Db, householdId: string): Promise<ImportRun[]> {
  const { rows } = await db.query<ImportRun>(`SELECT ${RUN_COLS} FROM import_run WHERE household_id = $1 ORDER BY created_at DESC LIMIT 100`, [householdId]);
  return rows;
}

// ── the line view: effective status and EUR amount ─────────────────────────

/**
 * Lines with their purchase, the effective status and the amount in EUR. A line whose item
 * was later sold, given away, used up, … counts as gone with that reason, so the statistics
 * follow the inventory. EUR uses the ECB reference rate of the order day (or the last one before).
 * Parameters: $1 household, $2 member (for private purchases).
 */
const LINE_VIEW = `
  SELECT l.id, l.purchase_id, l.position, l.title, l.title_translated, l.quantity, l.unit_price_minor, l.amount_minor, l.currency,
         l.external_product_id, l.url, l.item_id, l.item_created, l.auto_rule, l.decided_at, l.search_text,
         l.possession, l.gone_reason,
         p.source, p.merchant, p.external_order_id, p.ordered_at,
         i.state AS item_state, i.name AS item_name,
         CASE WHEN i.state = ANY('{${GONE.join(',')}}') THEN 'gone' ELSE l.possession END AS status,
         CASE WHEN i.state = ANY('{${GONE.join(',')}}') THEN i.state ELSE l.gone_reason END AS reason,
         CASE WHEN l.amount_minor IS NULL THEN NULL
              WHEN l.currency = 'EUR' THEN l.amount_minor
              WHEN r.per_eur IS NULL THEN NULL
              ELSE round(l.amount_minor::numeric / power(10, pq_currency_exponent(l.currency)) / r.per_eur * 100)::bigint
         END AS amount_eur_minor
    FROM purchase_line l
    JOIN purchase p ON p.id = l.purchase_id
    LEFT JOIN item i ON i.id = l.item_id
    LEFT JOIN LATERAL (
      SELECT f.per_eur FROM fx_rate f
       WHERE l.currency IS NOT NULL AND l.currency <> 'EUR' AND f.currency = l.currency AND f.day <= coalesce(p.ordered_at, current_date)
       ORDER BY f.day DESC LIMIT 1
    ) r ON true
   WHERE l.household_id = $1 AND (p.private_to IS NULL OR p.private_to = $2)`;

export interface LineView {
  id: string;
  purchase_id: string;
  title: string;
  title_translated: string | null;
  quantity: number;
  unit_price_minor: number | null;
  amount_minor: number | null;
  currency: string | null;
  amount_eur_minor: number | null;
  external_product_id: string | null;
  url: string | null;
  item_id: string | null;
  item_name: string | null;
  item_created: boolean;
  possession: Possession;
  gone_reason: GoneReason | null;
  status: Possession;          // effective, following the linked item
  reason: GoneReason | null;   // effective
  auto_rule: string | null;
  decided_at: Date | null;
  source: string;
  merchant: string | null;
  external_order_id: string | null;
  ordered_at: string | null;
}

const VIEW_COLS = `id, purchase_id, title, title_translated, quantity, unit_price_minor, amount_minor, currency, amount_eur_minor,
  external_product_id, url, item_id, item_name, item_created, possession, gone_reason, status, reason, auto_rule, decided_at,
  source, merchant, external_order_id, ordered_at`;

export interface LineFilter {
  status?: Possession | 'all';
  q?: string;
  year?: number;
  merchant?: string;
  source?: string;
  minEur?: number; // minor units
  maxEur?: number;
  sort?: 'price' | 'date' | 'date_asc';
  limit?: number;
  offset?: number;
}

function where(f: LineFilter, params: unknown[]): string {
  const p = (v: unknown) => `$${params.push(v)}`;
  const w: string[] = [];
  const status = f.status ?? 'pending';
  if (status !== 'all') w.push(`v.status = ${p(status)}`);
  const q = f.q ? normaliseText(f.q) : '';
  if (q) w.push(`v.search_text LIKE ${p(`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`)}`);
  if (f.year) w.push(`extract(year FROM v.ordered_at) = ${p(f.year)}`);
  if (f.merchant) w.push(`v.merchant = ${p(f.merchant)}`);
  if (f.source) w.push(`v.source = ${p(f.source)}`);
  if (f.minEur != null) w.push(`v.amount_eur_minor >= ${p(f.minEur)}`);
  if (f.maxEur != null) w.push(`coalesce(v.amount_eur_minor, 0) <= ${p(f.maxEur)}`);
  return w.length ? `WHERE ${w.join(' AND ')}` : '';
}

const ORDER = {
  // Most expensive first (unconverted foreign amounts are ranked by their face value until rates exist).
  price: 'coalesce(v.amount_eur_minor, v.amount_minor) DESC NULLS LAST, v.ordered_at DESC NULLS LAST, v.id',
  date: 'v.ordered_at DESC NULLS LAST, v.id',
  date_asc: 'v.ordered_at ASC NULLS LAST, v.id',
} as const;

export interface LinePage {
  total: number;
  total_eur_minor: number;
  lines: LineView[];
}

export async function listLines(db: Db, householdId: string, memberId: string | null, f: LineFilter): Promise<LinePage> {
  const params: unknown[] = [householdId, memberId];
  const w = where(f, params);
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  const offset = Math.max(f.offset ?? 0, 0);
  const [rows, agg] = await Promise.all([
    db.query<LineView>(`SELECT ${VIEW_COLS} FROM (${LINE_VIEW}) v ${w} ORDER BY ${ORDER[f.sort ?? 'price']} LIMIT ${limit} OFFSET ${offset}`, params),
    db.query<{ n: number; eur: number }>(`SELECT count(*)::int AS n, coalesce(sum(v.amount_eur_minor), 0)::bigint AS eur FROM (${LINE_VIEW}) v ${w}`, params),
  ]);
  return { total: agg.rows[0]!.n, total_eur_minor: Number(agg.rows[0]!.eur), lines: rows.rows };
}

export async function getLine(db: Db, householdId: string, memberId: string | null, id: string): Promise<LineView> {
  const { rows } = await db.query<LineView>(`SELECT ${VIEW_COLS} FROM (${LINE_VIEW}) v WHERE v.id = $3`, [householdId, memberId, id]);
  if (!rows[0]) throw new DomainError('not_found', 'purchase line not found');
  return rows[0];
}

/** Years, shops and sources present, for the filters. */
export async function lineFacets(db: Db, householdId: string, memberId: string | null) {
  const { rows } = await db.query<{ years: number[] | null; merchants: string[] | null; sources: string[] | null }>(
    `SELECT array_agg(DISTINCT extract(year FROM v.ordered_at)::int ORDER BY extract(year FROM v.ordered_at)::int DESC)
              FILTER (WHERE v.ordered_at IS NOT NULL) AS years,
            array_agg(DISTINCT v.merchant ORDER BY v.merchant) FILTER (WHERE v.merchant IS NOT NULL) AS merchants,
            array_agg(DISTINCT v.source ORDER BY v.source) AS sources
       FROM (${LINE_VIEW}) v`,
    [householdId, memberId],
  );
  return { years: rows[0]?.years ?? [], merchants: rows[0]?.merchants ?? [], sources: rows[0]?.sources ?? [] };
}

// ── deciding ───────────────────────────────────────────────────────────────

interface LineRow {
  id: string;
  title: string;
  quantity: number;
  amount_minor: number | null;
  currency: string | null;
  url: string | null;
  item_id: string | null;
  item_created: boolean;
  possession: Possession;
  gone_reason: GoneReason | null;
  ordered_at: string | null;
}

async function lockLine(c: PoolClient, actor: Actor, id: string): Promise<LineRow> {
  const { rows } = await c.query<LineRow>(
    `SELECT l.id, l.title, l.quantity, l.amount_minor, l.currency, l.url, l.item_id, l.item_created, l.possession, l.gone_reason, p.ordered_at
       FROM purchase_line l JOIN purchase p ON p.id = l.purchase_id
      WHERE l.household_id = $1 AND (p.private_to IS NULL OR p.private_to = $2) AND l.id = $3
      FOR UPDATE OF l`,
    [actor.householdId, actor.memberId, id],
  );
  if (!rows[0]) throw new DomainError('not_found', 'purchase line not found');
  return rows[0];
}

const snap = (l: Pick<LineRow, 'possession' | 'gone_reason' | 'item_id'>) => ({ possession: l.possession, gone_reason: l.gone_reason, item_id: l.item_id });

export interface Decision {
  status: Exclude<Possession, 'pending'>;
  goneReason?: GoneReason | null;
  locationId?: string | null; // owned: where the new item goes
  kind?: ItemKind;            // owned: durable (default) or supply
  name?: string;              // owned: item name (default: shortened title)
}

/**
 * One tap in the possession check. "owned" creates an inventory item from the line (price,
 * date, link and quantity carried over); "gone" and "ignored" only record the decision, the
 * line itself always stays. A decided line can change its gone reason; anything else needs
 * a reset first, so an existing item is never silently dropped.
 */
export async function decideLine(pool: Pool, actor: Actor, id: string, d: Decision): Promise<LineView> {
  if (d.goneReason && d.status !== 'gone') throw new DomainError('invalid', 'a reason is only for "gone"');
  await tx(pool, async (c) => {
    const cur = await lockLine(c, actor, id);
    if (cur.possession !== 'pending' && cur.possession !== d.status) {
      throw new DomainError('conflict', `already marked ${cur.possession}; undo that first`);
    }
    if (cur.possession === d.status && d.status !== 'gone') return;
    let itemId = cur.item_id;
    let created = cur.item_created;
    if (d.status === 'owned' && !itemId) {
      const name = d.name?.trim() || shortItemName(cur.title);
      const item = await insertItem(c, actor, {
        kind: d.kind ?? 'durable',
        name,
        locationId: d.locationId ?? null,
        quantity: cur.quantity,
        priceAmountMinor: cur.amount_minor,
        priceCurrency: cur.amount_minor != null ? cur.currency : null,
        purchaseUrl: cur.url,
        acquiredAt: cur.ordered_at,
        notes: name !== cur.title ? `Bought as: ${cur.title}` : null,
      });
      itemId = item.id;
      created = true;
    }
    const reason = d.status === 'gone' ? (d.goneReason ?? null) : null;
    const next = { possession: d.status, gone_reason: reason, item_id: itemId };
    if (JSON.stringify(snap(cur)) === JSON.stringify(next)) return;
    await c.query(
      `UPDATE purchase_line SET possession = $2, gone_reason = $3, item_id = $4, item_created = $5, auto_rule = NULL, decided_by = $6, decided_at = now()
        WHERE id = $1`,
      [id, d.status, reason, itemId, created, actor.memberId],
    );
    await writeEvent(c, actor, { type: 'purchase_line.decided', entity: 'purchase_line', entityId: id, before: snap(cur), after: next });
  });
  return getLine(pool, actor.householdId, actor.memberId, id);
}

/**
 * Undo of a decision: back to pending. An item the check created is deleted only while it
 * is untouched (no edits, moves or photos since); otherwise the reset is refused, because
 * that item now carries information of its own.
 */
export async function resetLine(pool: Pool, actor: Actor, id: string): Promise<LineView> {
  await tx(pool, async (c) => {
    const cur = await lockLine(c, actor, id);
    if (cur.possession === 'pending') return;
    if (cur.item_id && cur.item_created) {
      const touched = await c.query(
        `SELECT 1 FROM event WHERE entity = 'item' AND entity_id = $1 AND type <> 'item.created'
          UNION ALL SELECT 1 FROM item_document WHERE item_id = $1 LIMIT 1`,
        [cur.item_id],
      );
      if (touched.rowCount) throw new DomainError('conflict', 'the item made from this line was changed since; change it in the inventory instead');
      const item = await c.query<ItemRow>('DELETE FROM item WHERE id = $1 RETURNING *', [cur.item_id]);
      if (item.rows[0]) {
        await writeEvent(c, actor, { type: 'item.deleted', entity: 'item', entityId: cur.item_id, before: itemSnapshot(item.rows[0]) });
      }
    }
    const keepItem = cur.item_id && !cur.item_created ? cur.item_id : null;
    await c.query(
      `UPDATE purchase_line SET possession = 'pending', gone_reason = NULL, item_id = $2, item_created = false, auto_rule = NULL, decided_by = NULL, decided_at = NULL
        WHERE id = $1`,
      [id, keepItem],
    );
    await writeEvent(c, actor, {
      type: 'purchase_line.reset', entity: 'purchase_line', entityId: id,
      before: snap(cur), after: { possession: 'pending', gone_reason: null, item_id: keepItem },
    });
  });
  return getLine(pool, actor.householdId, actor.memberId, id);
}

/**
 * Marks every pending line matching the filter as gone (with an optional reason) or ignored,
 * e.g. "everything under €10 from before 2020 was used up". Never creates items.
 */
export async function bulkDecide(
  pool: Pool,
  actor: Actor,
  f: Omit<LineFilter, 'status' | 'sort' | 'limit' | 'offset'>,
  d: { status: 'gone' | 'ignored'; goneReason?: GoneReason | null },
): Promise<number> {
  if (d.goneReason && d.status !== 'gone') throw new DomainError('invalid', 'a reason is only for "gone"');
  return tx(pool, async (c) => {
    const params: unknown[] = [actor.householdId, actor.memberId];
    const w = where({ ...f, status: 'pending' }, params);
    const ids = await c.query<{ id: string }>(`SELECT v.id FROM (${LINE_VIEW}) v ${w} AND v.item_id IS NULL`, params);
    if (!ids.rowCount) return 0;
    const reason = d.status === 'gone' ? (d.goneReason ?? null) : null;
    const updated = await c.query<{ id: string }>(
      `UPDATE purchase_line SET possession = $2, gone_reason = $3, decided_by = $4, decided_at = now()
        WHERE id = ANY($1::uuid[]) AND possession = 'pending' RETURNING id`,
      [ids.rows.map((r) => r.id), d.status, reason, actor.memberId],
    );
    await c.query(
      `INSERT INTO event (household_id, actor_member_id, type, entity, entity_id, before, after)
       SELECT $1, $2, 'purchase_line.decided', 'purchase_line', x, $3, $4 FROM unnest($5::uuid[]) AS x`,
      [
        actor.householdId, actor.memberId,
        { possession: 'pending', gone_reason: null, item_id: null },
        { possession: d.status, gone_reason: reason, item_id: null, bulk: true },
        updated.rows.map((r) => r.id),
      ],
    );
    return updated.rowCount ?? 0;
  });
}

// ── spending report ────────────────────────────────────────────────────────

export interface StatusTotals {
  count: number;
  eur_minor: number;
}

export interface SpendingReport {
  currency: 'EUR';
  totals: Record<'all' | 'pending' | 'owned' | 'gone' | 'used_up' | 'ignored', StatusTotals>;
  /** Lines with an amount but no exchange rate yet; not in the EUR sums. */
  unconverted: { count: number; currencies: string[] };
  /** Share of spend (EUR) that has been decided: owned, gone, used up or ignored. */
  coverage: number;
  by_year: ({ year: number | null } & Record<'all' | 'pending' | 'owned' | 'gone' | 'used_up' | 'ignored', number>)[];
  by_reason: { reason: GoneReason | null; count: number; eur_minor: number }[];
  by_merchant: { merchant: string | null; count: number; eur_minor: number; gone_eur_minor: number }[];
  top_gone: LineView[];
}

/**
 * Spending over the imported history. "gone" means things no longer in the house that were
 * not used up; consumables (reason "consumed") are counted separately as "used_up".
 */
export async function spendingReport(db: Db, householdId: string, memberId: string | null): Promise<SpendingReport> {
  const params = [householdId, memberId];
  const bucket = `CASE WHEN v.status = 'gone' AND v.reason = 'consumed' THEN 'used_up' ELSE v.status END`;
  const [totals, years, reasons, merchants, top, unconv] = await Promise.all([
    db.query<{ bucket: string; n: number; eur: string }>(
      `SELECT ${bucket} AS bucket, count(*)::int AS n, coalesce(sum(v.amount_eur_minor), 0) AS eur FROM (${LINE_VIEW}) v GROUP BY 1`, params),
    db.query<{ year: number | null; bucket: string; eur: string }>(
      `SELECT extract(year FROM v.ordered_at)::int AS year, ${bucket} AS bucket, coalesce(sum(v.amount_eur_minor), 0) AS eur
         FROM (${LINE_VIEW}) v GROUP BY 1, 2`, params),
    db.query<{ reason: GoneReason | null; n: number; eur: string }>(
      `SELECT v.reason, count(*)::int AS n, coalesce(sum(v.amount_eur_minor), 0) AS eur FROM (${LINE_VIEW}) v
        WHERE v.status = 'gone' GROUP BY 1 ORDER BY 3 DESC`, params),
    db.query<{ merchant: string | null; n: number; eur: string; gone: string }>(
      `SELECT v.merchant, count(*)::int AS n, coalesce(sum(v.amount_eur_minor), 0) AS eur,
              coalesce(sum(v.amount_eur_minor) FILTER (WHERE v.status = 'gone' AND v.reason IS DISTINCT FROM 'consumed'), 0) AS gone
         FROM (${LINE_VIEW}) v WHERE v.status <> 'ignored' GROUP BY 1 ORDER BY 3 DESC LIMIT 20`, params),
    db.query<LineView>(
      `SELECT ${VIEW_COLS} FROM (${LINE_VIEW}) v WHERE v.status = 'gone' AND v.reason IS DISTINCT FROM 'consumed'
        ORDER BY v.amount_eur_minor DESC NULLS LAST, v.id LIMIT 25`, params),
    db.query<{ n: number; currencies: string[] | null }>(
      `SELECT count(*)::int AS n, array_agg(DISTINCT v.currency) AS currencies FROM (${LINE_VIEW}) v
        WHERE v.amount_minor IS NOT NULL AND v.amount_eur_minor IS NULL`, params),
  ]);
  const zero = (): StatusTotals => ({ count: 0, eur_minor: 0 });
  const t = { all: zero(), pending: zero(), owned: zero(), gone: zero(), used_up: zero(), ignored: zero() };
  for (const r of totals.rows) {
    const k = r.bucket as keyof typeof t;
    t[k] = { count: r.n, eur_minor: Number(r.eur) };
    t.all.count += r.n;
    t.all.eur_minor += Number(r.eur);
  }
  const yearMap = new Map<number | null, SpendingReport['by_year'][number]>();
  for (const r of years.rows) {
    const y = yearMap.get(r.year) ?? { year: r.year, all: 0, pending: 0, owned: 0, gone: 0, used_up: 0, ignored: 0 };
    y[r.bucket as 'pending'] += Number(r.eur);
    y.all += Number(r.eur);
    yearMap.set(r.year, y);
  }
  const relevant = t.all.eur_minor;
  return {
    currency: 'EUR',
    totals: t,
    unconverted: { count: unconv.rows[0]?.n ?? 0, currencies: unconv.rows[0]?.currencies ?? [] },
    coverage: relevant > 0 ? 1 - t.pending.eur_minor / relevant : 0,
    by_year: [...yearMap.values()].sort((a, b) => (b.year ?? -1) - (a.year ?? -1)),
    by_reason: reasons.rows.map((r) => ({ reason: r.reason, count: r.n, eur_minor: Number(r.eur) })),
    by_merchant: merchants.rows.map((r) => ({ merchant: r.merchant, count: r.n, eur_minor: Number(r.eur), gone_eur_minor: Number(r.gone) })),
    top_gone: top.rows,
  };
}

// ── FX reference rates ─────────────────────────────────────────────────────

/** Inserts or replaces rates; returns how many rows were written. */
export async function upsertFxRates(pool: Pool, rates: { currency: string; day: string; perEur: number }[]): Promise<number> {
  let n = 0;
  for (let i = 0; i < rates.length; i += 5000) {
    const chunk = rates.slice(i, i + 5000);
    const r = await pool.query(
      `INSERT INTO fx_rate (currency, day, per_eur)
       SELECT * FROM unnest($1::text[], $2::date[], $3::numeric[])
       ON CONFLICT (currency, day) DO UPDATE SET per_eur = EXCLUDED.per_eur`,
      [chunk.map((x) => x.currency), chunk.map((x) => x.day), chunk.map((x) => x.perEur)],
    );
    n += r.rowCount ?? 0;
  }
  return n;
}

export async function fxStatus(db: Db): Promise<{ latest_day: string | null; currencies: number }> {
  const { rows } = await db.query<{ latest_day: string | null; currencies: number }>(
    'SELECT max(day)::text AS latest_day, count(DISTINCT currency)::int AS currencies FROM fx_rate',
  );
  return rows[0]!;
}
