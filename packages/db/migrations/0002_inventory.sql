-- Inventory core (M1): locations, categories, items, documents (photos) and the event log.

CREATE EXTENSION IF NOT EXISTS unaccent;

-- unaccent() is only STABLE; this wrapper pins the dictionary so it can be used in triggers and indexes.
CREATE FUNCTION pq_unaccent(text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS
$$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- ── documents (photos now; receipts, manuals, contracts later) ─────────────
CREATE TABLE document (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id  uuid NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('receipt', 'manual', 'warranty', 'photo', 'import_file', 'email', 'contract', 'policy', 'invoice')),
  storage_key   text NOT NULL,              -- sha256 of the uploaded original; files are addressed by it
  mime          text NOT NULL,              -- mime of the stored main file
  size_bytes    bigint NOT NULL CHECK (size_bytes >= 0),
  width         integer,
  height        integer,
  original_name text,
  created_by    uuid REFERENCES member(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_household_idx ON document (household_id);
CREATE INDEX document_storage_key_idx ON document (storage_key);

-- ── locations: site → room → spot → container ─────────────────────────────
CREATE TABLE location (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id      uuid NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  parent_id         uuid REFERENCES location(id) ON DELETE RESTRICT,
  kind              text NOT NULL CHECK (kind IN ('site', 'room', 'spot', 'container')),
  name              text NOT NULL CHECK (length(trim(name)) > 0),
  notes             text,
  photo_document_id uuid REFERENCES document(id) ON DELETE SET NULL,
  sort_order        integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT location_site_is_root CHECK ((kind = 'site') = (parent_id IS NULL))
);
CREATE INDEX location_parent_idx ON location (parent_id);
CREATE UNIQUE INDEX location_sibling_name_key
  ON location (household_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

-- ── categories ─────────────────────────────────────────────────────────────
CREATE TABLE category (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id                uuid NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  parent_id                   uuid REFERENCES category(id) ON DELETE RESTRICT,
  name                        text NOT NULL CHECK (length(trim(name)) > 0),
  default_kind                text CHECK (default_kind IN ('durable', 'supply')),
  depreciation                jsonb,       -- F1 (M8): depreciation curve
  assume_consumed_after_months integer CHECK (assume_consumed_after_months > 0),  -- B5 (M2)
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX category_parent_idx ON category (parent_id);
CREATE UNIQUE INDEX category_sibling_name_key
  ON category (household_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

-- ── items ──────────────────────────────────────────────────────────────────
CREATE TABLE item (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id         uuid NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  kind                 text NOT NULL CHECK (kind IN ('durable', 'supply')),
  name                 text NOT NULL CHECK (length(trim(name)) > 0),
  aliases              text[] NOT NULL DEFAULT '{}',
  category_id          uuid REFERENCES category(id) ON DELETE SET NULL,
  location_id          uuid REFERENCES location(id) ON DELETE RESTRICT,   -- null = location unknown
  belongs_to_person_id uuid REFERENCES person(id) ON DELETE SET NULL,      -- null = the household
  state                text NOT NULL DEFAULT 'owned'
                       CHECK (state IN ('owned', 'unknown', 'lent', 'sold', 'given_away', 'disposed', 'lost', 'returned', 'consumed')),
  quantity             numeric(12, 3) NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  unit                 text,
  min_quantity         numeric(12, 3) CHECK (min_quantity >= 0),
  price_amount_minor   bigint CHECK (price_amount_minor >= 0),
  price_currency       char(3) CHECK (price_currency ~ '^[A-Z]{3}$'),
  purchase_url         text,
  notes                text,
  tags                 text[] NOT NULL DEFAULT '{}',
  attributes           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- brand, model, size, colour, serial
  private_to           uuid REFERENCES member(id) ON DELETE CASCADE,   -- A7 (M8)
  acquired_at          date,
  last_used_at         timestamptz,
  search_text          text NOT NULL DEFAULT '',     -- maintained by trigger
  search               tsvector NOT NULL DEFAULT ''::tsvector,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT item_price_complete CHECK ((price_amount_minor IS NULL) = (price_currency IS NULL))
);
CREATE INDEX item_household_state_idx ON item (household_id, state);
CREATE INDEX item_location_idx ON item (location_id);
CREATE INDEX item_category_idx ON item (category_id);
CREATE INDEX item_search_idx ON item USING gin (search);
CREATE INDEX item_search_trgm_idx ON item USING gin (search_text gin_trgm_ops);

CREATE FUNCTION item_search_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attrs text := coalesce(NEW.attributes->>'brand', '') || ' ' || coalesce(NEW.attributes->>'model', '');
BEGIN
  NEW.search_text := lower(pq_unaccent(
    NEW.name || ' ' || array_to_string(NEW.aliases, ' ') || ' ' || array_to_string(NEW.tags, ' ') || ' ' || attrs));
  NEW.search :=
    setweight(to_tsvector('simple', lower(pq_unaccent(NEW.name))), 'A') ||
    setweight(to_tsvector('simple', lower(pq_unaccent(array_to_string(NEW.aliases, ' ')))), 'A') ||
    setweight(to_tsvector('simple', lower(pq_unaccent(array_to_string(NEW.tags, ' ') || ' ' || attrs))), 'B');
  RETURN NEW;
END;
$$;
CREATE TRIGGER item_search BEFORE INSERT OR UPDATE OF name, aliases, tags, attributes ON item
  FOR EACH ROW EXECUTE FUNCTION item_search_refresh();

CREATE TABLE item_document (
  item_id     uuid NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, document_id)
);
CREATE INDEX item_document_document_idx ON item_document (document_id);

-- ── event log: append-only ─────────────────────────────────────────────────
CREATE TABLE event (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id    uuid NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  actor_member_id uuid REFERENCES member(id) ON DELETE SET NULL,   -- null = system
  type            text NOT NULL,                                   -- e.g. item.created, item.moved
  entity          text NOT NULL CHECK (entity IN ('item', 'location', 'category', 'document')),
  entity_id       uuid NOT NULL,
  before          jsonb,
  after           jsonb,
  capture_id      uuid,                                            -- C1 (M3)
  undoes          uuid REFERENCES event(id),
  undone_by       uuid REFERENCES event(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_household_created_idx ON event (household_id, created_at DESC);
CREATE INDEX event_entity_idx ON event (entity, entity_id, created_at DESC);

-- Events are never changed or deleted; the only allowed update is setting undone_by once.
-- (Deleting a whole household cascades, which is the deliberate exception.)
CREATE FUNCTION event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.undone_by IS NULL AND NEW.undone_by IS NOT NULL
     AND (to_jsonb(NEW) - 'undone_by') = (to_jsonb(OLD) - 'undone_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'event log is append-only';
END;
$$;
CREATE TRIGGER event_append_only BEFORE UPDATE ON event FOR EACH ROW EXECUTE FUNCTION event_append_only();
CREATE TRIGGER event_no_delete BEFORE DELETE ON event FOR EACH ROW
  WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION event_append_only();

CREATE TRIGGER document_updated_at BEFORE UPDATE ON document FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER location_updated_at BEFORE UPDATE ON location FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER category_updated_at BEFORE UPDATE ON category FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER item_updated_at     BEFORE UPDATE ON item     FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── default categories ─────────────────────────────────────────────────────
-- Editable starting tree; called for new households and, below, for existing ones.
CREATE FUNCTION seed_default_categories(hh uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  tree jsonb := '[
    ["Furniture", null, []],
    ["Electronics", "durable", ["Computers", "Phones & tablets", "Audio & video", "Cables & accessories", "Smart home"]],
    ["Kitchen", "durable", ["Appliances", "Cookware", "Tableware", "Utensils"]],
    ["Clothes", "durable", ["Tops", "Bottoms", "Outerwear", "Shoes", "Underwear & socks", "Accessories"]],
    ["Tools", "durable", ["Power tools", "Hand tools", "Garden", "Hardware"]],
    ["Sport & outdoor", "durable", ["Camping", "Bikes", "Fitness", "Winter sports"]],
    ["Household supplies", "supply", ["Cleaning", "Batteries", "Light bulbs", "Paper goods"]],
    ["Toiletries", "supply", []],
    ["Pantry", "supply", []],
    ["Health", "supply", ["First aid", "Medicine"]],
    ["Books & media", "durable", []],
    ["Toys & games", "durable", []],
    ["Office & stationery", null, []],
    ["Decoration", "durable", []],
    ["Bedding & textiles", "durable", []],
    ["Car & bike accessories", "durable", []],
    ["Other", null, []]
  ]';
  top jsonb;
  child text;
  parent uuid;
BEGIN
  FOR top IN SELECT * FROM jsonb_array_elements(tree) LOOP
    INSERT INTO category (household_id, name, default_kind)
      VALUES (hh, top->>0, top->>1)
      ON CONFLICT DO NOTHING
      RETURNING id INTO parent;
    IF parent IS NULL THEN CONTINUE; END IF;
    FOR child IN SELECT jsonb_array_elements_text(top->2) LOOP
      INSERT INTO category (household_id, parent_id, name, default_kind)
        VALUES (hh, parent, child, top->>1) ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;
END;
$$;

SELECT seed_default_categories(id) FROM household;
