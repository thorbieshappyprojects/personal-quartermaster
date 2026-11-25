-- Rule-based suggestion whether a purchase line was a consumable (see @pq/core consumables.ts).
-- Recomputed by the app when the rules version changes; a person can reject it per line.
ALTER TABLE purchase_line
  ADD COLUMN suggested_kind text CHECK (suggested_kind IN ('food', 'supplies')),
  ADD COLUMN suggestion_rejected boolean NOT NULL DEFAULT false,
  ADD COLUMN suggestion_v integer;
CREATE INDEX purchase_line_suggested_idx ON purchase_line (household_id, possession) WHERE suggested_kind IS NOT NULL;
