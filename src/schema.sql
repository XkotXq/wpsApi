-- yfoc-frp-api schema
-- Ids are generated in application code (crypto.randomUUID()), so no
-- pgcrypto/uuid-ossp extension is required on the database.
--
-- Model:
--   *_current   = live, editable stock right now (add/edit/transfer/reorder).
--   drums       = permanent registry of physical drums; one row forever per
--                 drum_number, reused across materials and over time so
--                 historical snapshots can point at "the same drum" via id.
--   stocks +
--   stock_versions +
--   *_stock     = read-only history. A stock-take is counted client-side
--                 (yes/no per drum, kept in the browser) and submitted once
--                 at the end as: a yes/no tally (stock_versions) plus a full
--                 snapshot of *_current at that moment (*_stock). Submitting
--                 never modifies *_current.

CREATE TABLE IF NOT EXISTS frp_catalog (
  item_number  TEXT PRIMARY KEY,
  name         TEXT NOT NULL DEFAULT '',
  label        TEXT NOT NULL DEFAULT '',
  type         TEXT NOT NULL DEFAULT 'XB' CHECK (type IN ('XB', 'Z')),
  mmc          BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS drums (
  id           UUID PRIMARY KEY,
  drum_number  TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Current (live) stock
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS frp_current (
  id                  UUID PRIMARY KEY,
  frp_item_number     TEXT NOT NULL REFERENCES frp_catalog (item_number) ON UPDATE CASCADE ON DELETE RESTRICT,
  drum_id             UUID NOT NULL REFERENCES drums (id) ON DELETE RESTRICT,
  drum_number         TEXT NOT NULL,
  length              TEXT NOT NULL DEFAULT '',
  location            TEXT NOT NULL DEFAULT '',
  remark              TEXT NOT NULL DEFAULT '',
  position            INTEGER NOT NULL DEFAULT 0,
  reserved_for_order  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (drum_number)
);

CREATE TABLE IF NOT EXISTS coated_frp_current (
  id           UUID PRIMARY KEY,
  drum_id      UUID NOT NULL REFERENCES drums (id) ON DELETE RESTRICT,
  drum_number  TEXT NOT NULL,
  diameter     TEXT NOT NULL DEFAULT '',
  length       TEXT NOT NULL DEFAULT '',
  type         TEXT NOT NULL DEFAULT 'XB' CHECK (type IN ('XB', 'Z')),
  location     TEXT NOT NULL DEFAULT '',
  remark       TEXT NOT NULL DEFAULT '',
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (drum_number)
);

CREATE TABLE IF NOT EXISTS filler_current (
  id           UUID PRIMARY KEY,
  drum_id      UUID NOT NULL REFERENCES drums (id) ON DELETE RESTRICT,
  drum_number  TEXT NOT NULL,
  diameter     TEXT NOT NULL DEFAULT '',
  length       TEXT NOT NULL DEFAULT '',
  color        TEXT NOT NULL DEFAULT 'GRAY' CHECK (color IN ('GRAY', 'WHITE', 'BLACK')),
  flameproof   BOOLEAN NOT NULL DEFAULT FALSE,
  location     TEXT NOT NULL DEFAULT 'PRZED' CHECK (location IN ('PRZED', 'ZA')),
  remark       TEXT NOT NULL DEFAULT '',
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (drum_number)
);

-- ---------------------------------------------------------------------
-- Stock-take history (read-only once written)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS stock_versions (
  id            UUID PRIMARY KEY,
  material_key  TEXT NOT NULL CHECK (material_key IN ('frp', 'coatedFrp', 'filler')),
  performed_by  TEXT,
  performed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  yes_count     INTEGER NOT NULL DEFAULT 0,
  no_count      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_stock_versions_material_time ON stock_versions (material_key, performed_at DESC);

CREATE TABLE IF NOT EXISTS stocks (
  id                     UUID PRIMARY KEY,
  performed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  frp_version_id         UUID REFERENCES stock_versions (id) ON DELETE SET NULL,
  coated_frp_version_id  UUID REFERENCES stock_versions (id) ON DELETE SET NULL,
  filler_version_id      UUID REFERENCES stock_versions (id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS frp_stock (
  id               UUID PRIMARY KEY,
  version_id       UUID NOT NULL REFERENCES stock_versions (id) ON DELETE CASCADE,
  frp_item_number  TEXT NOT NULL,
  drum_id          UUID NOT NULL REFERENCES drums (id) ON DELETE RESTRICT,
  drum_number      TEXT NOT NULL,
  length           TEXT NOT NULL DEFAULT '',
  location         TEXT NOT NULL DEFAULT '',
  remark           TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_frp_stock_version ON frp_stock (version_id);

CREATE TABLE IF NOT EXISTS coated_frp_stock (
  id           UUID PRIMARY KEY,
  version_id   UUID NOT NULL REFERENCES stock_versions (id) ON DELETE CASCADE,
  drum_id      UUID NOT NULL REFERENCES drums (id) ON DELETE RESTRICT,
  drum_number  TEXT NOT NULL,
  diameter     TEXT NOT NULL DEFAULT '',
  length       TEXT NOT NULL DEFAULT '',
  type         TEXT NOT NULL DEFAULT 'XB',
  location     TEXT NOT NULL DEFAULT '',
  remark       TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_coated_frp_stock_version ON coated_frp_stock (version_id);

CREATE TABLE IF NOT EXISTS filler_stock (
  id           UUID PRIMARY KEY,
  version_id   UUID NOT NULL REFERENCES stock_versions (id) ON DELETE CASCADE,
  drum_id      UUID NOT NULL REFERENCES drums (id) ON DELETE RESTRICT,
  drum_number  TEXT NOT NULL,
  diameter     TEXT NOT NULL DEFAULT '',
  length       TEXT NOT NULL DEFAULT '',
  color        TEXT NOT NULL DEFAULT 'GRAY',
  flameproof   BOOLEAN NOT NULL DEFAULT FALSE,
  location     TEXT NOT NULL DEFAULT '',
  remark       TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_filler_stock_version ON filler_stock (version_id);
