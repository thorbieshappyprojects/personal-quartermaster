-- Household, members, persons (for "belongs to") and API tokens.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TABLE household (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (length(trim(name)) > 0),
  base_currency char(3) NOT NULL DEFAULT 'EUR' CHECK (base_currency ~ '^[A-Z]{3}$'),
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE member (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id          uuid NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  display_name          text NOT NULL CHECK (length(trim(display_name)) > 0),
  email                 text NOT NULL CHECK (position('@' in email) > 1),
  role                  text NOT NULL CHECK (role IN ('owner', 'member')),
  notification_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
-- One installation serves one household, so e-mail is unique per installation.
CREATE UNIQUE INDEX member_email_key ON member (lower(email));
CREATE INDEX member_household_idx ON member (household_id);

CREATE TABLE person (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (length(trim(display_name)) > 0),
  kind         text NOT NULL CHECK (kind IN ('member', 'dependant')),
  member_id    uuid UNIQUE REFERENCES member(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT person_dependant_has_no_member CHECK (kind = 'member' OR member_id IS NULL)
);
CREATE INDEX person_household_idx ON person (household_id);

CREATE TABLE api_token (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id    uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE,
  label        text NOT NULL CHECK (length(trim(label)) > 0),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_token_member_idx ON api_token (member_id);

CREATE TRIGGER household_updated_at BEFORE UPDATE ON household FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER member_updated_at    BEFORE UPDATE ON member    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER person_updated_at    BEFORE UPDATE ON person    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER api_token_updated_at BEFORE UPDATE ON api_token FOR EACH ROW EXECUTE FUNCTION set_updated_at();
