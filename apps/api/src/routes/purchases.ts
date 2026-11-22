import multipart from '@fastify/multipart';
import { GONE_REASONS, isCurrencyCode, type GoneReason, type ItemKind } from '@pq/core';
import {
  bulkDecide,
  decideLine,
  fxStatus,
  importPurchases,
  lineFacets,
  listImportRuns,
  listLines,
  resetLine,
  spendingReport,
  upsertFxRates,
  type Actor,
  type LineFilter,
} from '@pq/db';
import { FIELDS, type Mapping, type ParseOptions } from '@pq/importers';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ecbSource } from '../fx';
import { ImportFileError, MAX_IMPORT_BYTES, parseImportFiles, readImportFiles, sha256 } from '../orders-import';
import { idParams, nullableUuid, timestamp, uuid } from './schemas';

const actorOf = (req: FastifyRequest): Actor => ({ householdId: req.identity.member.household_id, memberId: req.identity.member.id });

const str = { type: 'string' } as const;
const nstr = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const;
const nint = { anyOf: [{ type: 'integer' }, { type: 'null' }] } as const;
const POSSESSION = ['pending', 'owned', 'gone', 'ignored'] as const;
const reasonOrNull = { anyOf: [{ type: 'string', enum: GONE_REASONS }, { type: 'null' }] } as const;

export const purchaseLineSchema = {
  $id: 'PurchaseLine',
  type: 'object',
  properties: {
    id: uuid, purchase_id: uuid, title: str, title_translated: nstr, quantity: { type: 'number' },
    unit_price_minor: nint, amount_minor: nint, currency: nstr,
    amount_eur_minor: { ...nint, description: 'converted with the ECB rate of the order day; null until rates exist' },
    external_product_id: nstr, url: nstr, item_id: { anyOf: [uuid, { type: 'null' }] }, item_name: nstr, item_created: { type: 'boolean' },
    possession: { type: 'string', enum: POSSESSION, description: 'as decided in the check' },
    gone_reason: reasonOrNull,
    status: { type: 'string', enum: POSSESSION, description: 'effective: "gone" once the linked item is sold, given away, used up, …' },
    reason: reasonOrNull,
    auto_rule: nstr, decided_at: { anyOf: [timestamp, { type: 'null' }] },
    source: str, merchant: nstr, external_order_id: nstr, ordered_at: nstr,
  },
  required: ['id', 'title', 'quantity', 'amount_minor', 'currency', 'amount_eur_minor', 'status', 'reason', 'possession', 'ordered_at', 'merchant'],
  additionalProperties: false,
} as const;

const runSchema = {
  type: 'object',
  properties: {
    id: uuid, source: str, format: str, filename: nstr, rows_read: { type: 'integer' }, purchases_added: { type: 'integer' },
    lines_added: { type: 'integer' }, lines_existing: { type: 'integer' }, lines_auto_closed: { type: 'integer' },
    errors: { type: 'array', items: { type: 'object', properties: { row: { type: 'integer' }, message: str }, required: ['row', 'message'] } },
    created_at: timestamp,
  },
  required: ['id', 'source', 'lines_added', 'lines_existing', 'errors'],
  additionalProperties: false,
} as const;

const filterProps = {
  q: { type: 'string', maxLength: 200 },
  year: { type: 'integer', minimum: 1970, maximum: 2100 },
  merchant: { type: 'string', maxLength: 200 },
  source: { type: 'string', maxLength: 40 },
  min_eur: { type: 'integer', minimum: 0, description: 'minor units (cents)' },
  max_eur: { type: 'integer', minimum: 0, description: 'minor units (cents)' },
} as const;

interface FilterQuery {
  q?: string;
  year?: number;
  merchant?: string;
  source?: string;
  min_eur?: number;
  max_eur?: number;
}
const toFilter = (q: FilterQuery): LineFilter => ({
  q: q.q, year: q.year, merchant: q.merchant, source: q.source, minEur: q.min_eur, maxEur: q.max_eur,
});

interface Upload {
  buf: Buffer;
  filename: string;
  fields: Record<string, string>;
}

async function readUpload(req: FastifyRequest, reply: FastifyReply): Promise<Upload | null> {
  const fields: Record<string, string> = {};
  let buf: Buffer | null = null;
  let filename = 'upload.csv';
  try {
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        filename = part.filename || filename;
        buf = await part.toBuffer();
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
  } catch (err) {
    if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      await reply.code(413).send({ error: 'too_large', message: 'files above 50 MB are refused; upload the CSV instead of the whole zip' });
      return null;
    }
    throw err;
  }
  if (!buf) {
    await reply.code(400).send({ error: 'invalid_request', message: 'multipart field "file" is required' });
    return null;
  }
  return { buf, filename, fields };
}

function parseOptionsFrom(fields: Record<string, string>): ParseOptions {
  const opts: ParseOptions = {};
  if (fields.mapping) {
    let m: unknown;
    try {
      m = JSON.parse(fields.mapping);
    } catch {
      throw new ImportFileError('mapping is not valid JSON');
    }
    if (!m || typeof m !== 'object') throw new ImportFileError('mapping must be an object');
    const mapping: Mapping = {};
    for (const [k, v] of Object.entries(m)) {
      if (!(FIELDS as readonly string[]).includes(k)) throw new ImportFileError(`unknown mapping field "${k}"`);
      if (typeof v === 'string' && v) mapping[k as keyof Mapping] = v;
    }
    opts.mapping = mapping;
  }
  const cur = fields.default_currency?.trim().toUpperCase();
  if (cur) {
    if (!isCurrencyCode(cur)) throw new ImportFileError('default_currency must be an ISO 4217 code');
    opts.defaultCurrency = cur;
  }
  if (fields.default_merchant?.trim()) opts.defaultMerchant = fields.default_merchant.trim().slice(0, 200);
  if (fields.date_order === 'dmy' || fields.date_order === 'mdy') opts.dateOrder = fields.date_order;
  return opts;
}

export async function purchaseRoutes(app: FastifyInstance): Promise<void> {
  await app.register(multipart, { limits: { fileSize: MAX_IMPORT_BYTES, files: 1, fields: 10 } });
  app.addSchema(purchaseLineSchema);
  const pool = () => app.deps.pool;
  const fxSource = app.deps.fxSource ?? ecbSource;

  let fxRefreshing: Promise<number> | null = null;
  const refreshFx = () => {
    fxRefreshing ??= (async () => {
      try {
        return await upsertFxRates(pool(), await fxSource());
      } finally {
        fxRefreshing = null;
      }
    })();
    return fxRefreshing;
  };

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ImportFileError) return reply.code(400).send({ error: 'invalid_file', message: err.message });
    throw err;
  });

  // ── imports ──
  const uploadDoc = 'multipart: "file" (CSV, or a zip such as Amazon\'s data export) plus optional fields mapping (JSON {field: header}), default_currency, default_merchant, date_order (dmy|mdy)';

  app.post('/api/v1/imports/preview', {
    schema: { summary: 'Read an order file without saving: detected format, column mapping, first lines, problems', description: uploadDoc, tags: ['imports'], consumes: ['multipart/form-data'] },
  }, async (req, reply) => {
    const up = await readUpload(req, reply);
    if (!up) return reply;
    const files = await readImportFiles(up.buf, up.filename);
    const r = parseImportFiles(files, parseOptionsFrom(up.fields));
    return {
      format: r.format, source: r.source, files: r.files, headers: r.headers, mapping: r.mapping,
      row_count: r.rowCount, purchase_count: r.purchases.length, line_count: r.lineCount,
      currencies: [...new Set(r.purchases.flatMap((p) => p.lines.map((l) => l.currency)).filter(Boolean))],
      sample: r.purchases.flatMap((p) => p.lines.map((l) => ({
        title: l.title, ordered_at: p.orderedAt, merchant: p.merchant, quantity: l.quantity, amount_minor: l.amountMinor, currency: l.currency, cancelled: l.cancelled,
      }))).slice(0, 8),
      errors: r.errors.slice(0, 50), error_count: r.errors.length,
    };
  });

  app.post('/api/v1/imports', {
    schema: {
      summary: 'Import an order file into the purchase history (never into the inventory directly)',
      description: `${uploadDoc}. Re-importing the same or an overlapping file adds only new lines.`,
      tags: ['imports'], consumes: ['multipart/form-data'], response: { 201: runSchema },
    },
  }, async (req, reply) => {
    const up = await readUpload(req, reply);
    if (!up) return reply;
    const files = await readImportFiles(up.buf, up.filename);
    const r = parseImportFiles(files, parseOptionsFrom(up.fields));
    if (!r.mapping.title) throw new ImportFileError('no column for the product title; map one');
    const run = await importPurchases(pool(), actorOf(req), {
      source: r.source, format: r.format, filename: up.filename.slice(0, 300), sha256: sha256(up.buf), rowsRead: r.rowCount, errors: r.errors,
    }, r.purchases);
    // Foreign currencies need reference rates; fetch them in the background when missing or stale.
    if (r.purchases.some((p) => p.lines.some((l) => l.currency && l.currency !== 'EUR'))) {
      const s = await fxStatus(pool());
      const stale = !s.latest_day || Date.now() - Date.parse(s.latest_day) > 5 * 86_400_000;
      if (stale) refreshFx().catch((err: Error) => req.log.warn({ msg: err.message }, 'fx refresh failed'));
    }
    return reply.code(201).send(run);
  });

  app.get('/api/v1/imports', {
    schema: { summary: 'Import runs, newest first', tags: ['imports'], response: { 200: { type: 'array', items: runSchema } } },
  }, async (req) => listImportRuns(pool(), actorOf(req).householdId));

  // ── possession check ──
  app.get<{ Querystring: FilterQuery & { status?: (typeof POSSESSION)[number] | 'all'; sort?: 'price' | 'date' | 'date_asc'; limit?: number; offset?: number } }>(
    '/api/v1/possession', {
      schema: {
        summary: 'Purchase lines to check (default: pending, most expensive first)', tags: ['possession'],
        querystring: {
          type: 'object',
          properties: {
            ...filterProps,
            status: { type: 'string', enum: [...POSSESSION, 'all'], default: 'pending' },
            sort: { type: 'string', enum: ['price', 'date', 'date_asc'], default: 'price' },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: { total: { type: 'integer' }, total_eur_minor: { type: 'integer' }, lines: { type: 'array', items: { $ref: 'PurchaseLine#' } } },
            required: ['total', 'total_eur_minor', 'lines'],
          },
        },
      },
    }, async (req) => {
      const a = actorOf(req);
      return listLines(pool(), a.householdId, a.memberId, { ...toFilter(req.query), status: req.query.status, sort: req.query.sort, limit: req.query.limit, offset: req.query.offset });
    },
  );

  app.get('/api/v1/possession/facets', {
    schema: {
      summary: 'Years, shops and sources in the purchase history, for filters', tags: ['possession'],
      response: { 200: { type: 'object', properties: { years: { type: 'array', items: { type: 'integer' } }, merchants: { type: 'array', items: str }, sources: { type: 'array', items: str } } } },
    },
  }, async (req) => lineFacets(pool(), actorOf(req).householdId, actorOf(req).memberId));

  app.post<{ Params: { id: string }; Body: { status: 'owned' | 'gone' | 'ignored'; gone_reason?: GoneReason | null; location_id?: string | null; kind?: ItemKind; name?: string } }>(
    '/api/v1/possession/:id', {
      schema: {
        summary: 'Decide one line: owned (creates an item), gone (optional reason; consumed = used up) or ignored',
        tags: ['possession'], params: idParams,
        body: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['owned', 'gone', 'ignored'] },
            gone_reason: reasonOrNull,
            location_id: nullableUuid,
            kind: { type: 'string', enum: ['durable', 'supply'] },
            name: { type: 'string', minLength: 1, maxLength: 200 },
          },
          required: ['status'], additionalProperties: false,
        },
        response: { 200: { $ref: 'PurchaseLine#' } },
      },
    }, async (req) => decideLine(pool(), actorOf(req), req.params.id, {
      status: req.body.status, goneReason: req.body.gone_reason, locationId: req.body.location_id, kind: req.body.kind, name: req.body.name,
    }),
  );

  app.post<{ Params: { id: string } }>('/api/v1/possession/:id/reset', {
    schema: { summary: 'Undo a decision (back to pending; removes the item it created while that is untouched)', tags: ['possession'], params: idParams, response: { 200: { $ref: 'PurchaseLine#' } } },
  }, async (req) => resetLine(pool(), actorOf(req), req.params.id));

  app.post<{ Body: FilterQuery & { status: 'gone' | 'ignored'; gone_reason?: GoneReason | null } }>('/api/v1/possession/bulk', {
    schema: {
      summary: 'Mark every pending line matching the filter as gone or ignored (never creates items)', tags: ['possession'],
      body: {
        type: 'object',
        properties: { ...filterProps, status: { type: 'string', enum: ['gone', 'ignored'] }, gone_reason: reasonOrNull },
        required: ['status'], additionalProperties: false,
      },
      response: { 200: { type: 'object', properties: { updated: { type: 'integer' } }, required: ['updated'] } },
    },
  }, async (req) => ({ updated: await bulkDecide(pool(), actorOf(req), toFilter(req.body), { status: req.body.status, goneReason: req.body.gone_reason }) }));

  // ── reports and rates ──
  const totals = { type: 'object', properties: { count: { type: 'integer' }, eur_minor: { type: 'integer' } } } as const;
  const buckets = ['all', 'pending', 'owned', 'gone', 'used_up', 'ignored'] as const;
  app.get('/api/v1/reports/spending', {
    schema: {
      summary: 'Spending over the purchase history in EUR: by status, year, reason and shop; the most expensive things no longer owned',
      description: '"gone" = no longer in the house and not used up; "used_up" = consumables. Lines without an exchange rate are counted in "unconverted".',
      tags: ['reports'],
      response: {
        200: {
          type: 'object',
          properties: {
            currency: str,
            totals: { type: 'object', properties: Object.fromEntries(buckets.map((b) => [b, totals])) },
            unconverted: { type: 'object', properties: { count: { type: 'integer' }, currencies: { type: 'array', items: str } } },
            coverage: { type: 'number' },
            by_year: { type: 'array', items: { type: 'object', properties: { year: nint, ...Object.fromEntries(buckets.map((b) => [b, { type: 'integer' }])) } } },
            by_reason: { type: 'array', items: { type: 'object', properties: { reason: reasonOrNull, count: { type: 'integer' }, eur_minor: { type: 'integer' } } } },
            by_merchant: { type: 'array', items: { type: 'object', properties: { merchant: nstr, count: { type: 'integer' }, eur_minor: { type: 'integer' }, gone_eur_minor: { type: 'integer' } } } },
            top_gone: { type: 'array', items: { $ref: 'PurchaseLine#' } },
            fx: { type: 'object', properties: { latest_day: nstr, currencies: { type: 'integer' } } },
          },
        },
      },
    },
  }, async (req) => {
    const a = actorOf(req);
    const [r, fx] = await Promise.all([spendingReport(pool(), a.householdId, a.memberId), fxStatus(pool())]);
    return { ...r, fx };
  });

  app.post('/api/v1/fx/refresh', {
    schema: {
      summary: 'Fetch the ECB reference rates (all days since 1999) and store them', tags: ['reports'],
      response: {
        200: { type: 'object', properties: { written: { type: 'integer' }, latest_day: nstr } },
        502: { type: 'object', properties: { error: str, message: str } },
      },
    },
  }, async (req, reply) => {
    try {
      const written = await refreshFx();
      return { written, latest_day: (await fxStatus(pool())).latest_day };
    } catch (err) {
      req.log.warn({ msg: (err as Error).message }, 'fx refresh failed');
      return reply.code(502).send({ error: 'upstream', message: 'Could not fetch exchange rates from the ECB. Try again later.' });
    }
  });
}
