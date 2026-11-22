-- Purchase history (M2): import runs, purchases and their lines, the possession check, FX rates.
-- Purchase history is not inventory: a line becomes an item only when someone confirms it.

ALTER TABLE event DROP CONSTRAINT event_entity_check;
ALTER TABLE event ADD CONSTRAINT event_entity_check
  CHECK (entity IN ('item', 'location', 'category', 'document', 'purchase', 'purchase_line', 'import_run'));

CREATE TABLE import_run (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id    uuid NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  member_id       uuid REFERENCES member(id) ON DELETE SET NULL,
  source          text NOT NULL,
  format          text NOT NULL,
  filename        text,
  sha256          text NOT NULL,
  rows_read       integer NOT NULL DEFAULT 0,
  purchases_added integer NOT NULL DEFAULT 0,
  lines_added     integer NOT NULL DEFAULT 0,
  lines_existing  integer NOT NULL DEFAULT 0,
  lines_auto_closed integer NOT NULL DEFAULT 0,
  errors          jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{ row, message }], first 200
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX import_run_household_idx ON import_run (household_id, created_at DESC);

CREATE TABLE purchase (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id       uuid NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  source             text NOT NULL CHECK (source IN ('amazon_export', 'taobao', 'email', 'photo', 'csv', 'manual')),
  merchant           text,
  external_order_id  text,
  ordered_at         date,
  total_amount_minor bigint CHECK (total_amount_minor >= 0),
  currency           char(3) CHECK (currency ~ '^[A-Z]{3}$'),
  buyer_member_id    uuid REFERENCES member(id) ON DELETE SET NULL,
  private_to         uuid REFERENCES member(id) ON DELETE CASCADE,   -- A7 (M8)
  import_run_id      uuid REFERENCES import_run(id) ON DELETE SET NULL,
  dedupe_key         text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, dedupe_key)
);
CREATE INDEX purchase_household_date_idx ON purchase (household_id, ordered_at);

CREATE TABLE purchase_line (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id        uuid NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  purchase_id         uuid NOT NULL REFERENCES purchase(id) ON DELETE CASCADE,
  position            integer NOT NULL DEFAULT 0,
  title               text NOT NULL CHECK (length(trim(title)) > 0),
  title_translated    text,
  quantity            numeric(12, 3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_minor    bigint CHECK (unit_price_minor >= 0),
  amount_minor        bigint CHECK (amount_minor >= 0),          -- the line's total
  currency            char(3) CHECK (currency ~ '^[A-Z]{3}$'),
  external_product_id text,
  url                 text,
  item_id             uuid REFERENCES item(id) ON DELETE SET NULL,
  item_created        boolean NOT NULL DEFAULT false,           -- the item was created by the check
  possession          text NOT NULL DEFAULT 'pending' CHECK (possession IN ('pending', 'owned', 'gone', 'ignored')),
  gone_reason         text CHECK (gone_reason IN ('sold', 'given_away', 'disposed', 'lost', 'returned', 'consumed')),
  auto_rule           text,                                      -- set when a rule, not a person, decided
  decided_by          uuid REFERENCES member(id) ON DELETE SET NULL,
  decided_at          timestamptz,
  return_deadline     date,
  warranty_until      date,
  dedupe_key          text NOT NULL,
  search_text         text NOT NULL DEFAULT '',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, dedupe_key),
  CONSTRAINT purchase_line_amount_currency CHECK (amount_minor IS NULL OR currency IS NOT NULL),
  CONSTRAINT purchase_line_reason_only_when_gone CHECK (gone_reason IS NULL OR possession = 'gone')
);
CREATE INDEX purchase_line_purchase_idx ON purchase_line (purchase_id, position);
CREATE INDEX purchase_line_queue_idx ON purchase_line (household_id, possession);
CREATE INDEX purchase_line_item_idx ON purchase_line (item_id);
CREATE INDEX purchase_line_search_trgm_idx ON purchase_line USING gin (search_text gin_trgm_ops);

CREATE FUNCTION purchase_line_search_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_text := lower(pq_unaccent(NEW.title || ' ' || coalesce(NEW.title_translated, '')));
  RETURN NEW;
END;
$$;
CREATE TRIGGER purchase_line_search BEFORE INSERT OR UPDATE OF title, title_translated ON purchase_line
  FOR EACH ROW EXECUTE FUNCTION purchase_line_search_refresh();

-- Reference rates (ECB): units of `currency` per 1 EUR on `day`. Not household data.
CREATE TABLE fx_rate (
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  day      date NOT NULL,
  per_eur  numeric(18, 8) NOT NULL CHECK (per_eur > 0),
  PRIMARY KEY (currency, day)
);

CREATE TRIGGER import_run_updated_at    BEFORE UPDATE ON import_run    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER purchase_updated_at      BEFORE UPDATE ON purchase      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER purchase_line_updated_at BEFORE UPDATE ON purchase_line FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ISO 4217 minor-unit exponent, mirrored from @pq/core money.ts.
CREATE FUNCTION pq_currency_exponent(c text) RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN c IN ('BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND') THEN 3
    WHEN c IN ('BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF') THEN 0
    ELSE 2 END
$$;
