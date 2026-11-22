import type { Pool } from 'pg';
import { DomainError, tx, writeEvent, type Actor, type Db } from './util';

export interface DocumentRow {
  id: string;
  kind: string;
  storage_key: string;
  mime: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  original_name: string | null;
  created_at: Date;
}

/** Stores the document row and links it to the item, with an event on the item. */
export async function addItemPhoto(
  pool: Pool,
  actor: Actor,
  itemId: string,
  doc: { storageKey: string; mime: string; sizeBytes: number; width: number; height: number; originalName: string | null },
): Promise<string> {
  return tx(pool, async (c) => {
    const item = await c.query(
      'SELECT 1 FROM item WHERE id = $1 AND household_id = $2 AND (private_to IS NULL OR private_to = $3) FOR UPDATE',
      [itemId, actor.householdId, actor.memberId],
    );
    if (!item.rowCount) throw new DomainError('not_found', 'item not found');
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO document (household_id, kind, storage_key, mime, size_bytes, width, height, original_name, created_by)
       VALUES ($1, 'photo', $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [actor.householdId, doc.storageKey, doc.mime, doc.sizeBytes, doc.width, doc.height, doc.originalName, actor.memberId],
    );
    const docId = rows[0]!.id;
    await c.query(
      `INSERT INTO item_document (item_id, document_id, position)
       VALUES ($1, $2, (SELECT coalesce(max(position) + 1, 0) FROM item_document WHERE item_id = $1))`,
      [itemId, docId],
    );
    await writeEvent(c, actor, { type: 'item.photo_added', entity: 'item', entityId: itemId, after: { document_id: docId } });
    return docId;
  });
}

export async function removeItemPhoto(pool: Pool, actor: Actor, itemId: string, documentId: string): Promise<void> {
  await tx(pool, async (c) => {
    const r = await c.query(
      `DELETE FROM item_document x USING item i
        WHERE x.item_id = $1 AND x.document_id = $2 AND i.id = x.item_id AND i.household_id = $3
          AND (i.private_to IS NULL OR i.private_to = $4)`,
      [itemId, documentId, actor.householdId, actor.memberId],
    );
    if (!r.rowCount) throw new DomainError('not_found', 'photo not found on this item');
    await c.query('DELETE FROM document WHERE id = $1', [documentId]);
    await writeEvent(c, actor, { type: 'item.photo_removed', entity: 'item', entityId: itemId, before: { document_id: documentId } });
  });
}

/**
 * A document the member may see: in the household and not attached to someone else's private item.
 * (Files stay on disk: they are content-addressed and may be shared by other documents.)
 */
export async function getVisibleDocument(db: Db, householdId: string, memberId: string | null, id: string): Promise<DocumentRow> {
  const { rows } = await db.query<DocumentRow>(
    `SELECT d.id, d.kind, d.storage_key, d.mime, d.size_bytes, d.width, d.height, d.original_name, d.created_at
       FROM document d
      WHERE d.id = $1 AND d.household_id = $2
        AND NOT EXISTS (SELECT 1 FROM item_document x JOIN item i ON i.id = x.item_id
                         WHERE x.document_id = d.id AND i.private_to IS NOT NULL AND i.private_to IS DISTINCT FROM $3)`,
    [id, householdId, memberId],
  );
  if (!rows[0]) throw new DomainError('not_found', 'document not found');
  return rows[0];
}
