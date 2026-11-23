-- Orders skipped because they were already in the history (overlapping exports).
ALTER TABLE import_run ADD COLUMN orders_skipped integer NOT NULL DEFAULT 0;
