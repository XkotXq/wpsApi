-- yfoc-frp-api schema
-- Ids are generated in application code (crypto.randomUUID()), so no
-- pgcrypto/uuid-ossp extension is required on the database.

-- Replaced by the drums/*_current/*_stock/stocks model below.
DROP TABLE IF EXISTS stock_checks CASCADE;
DROP TABLE IF EXISTS frp_items CASCADE;
DROP TABLE IF EXISTS coated_frp_items CASCADE;
DROP TABLE IF EXISTS filler_items CASCADE;
DROP TABLE IF EXISTS frp_catalog CASCADE;

-- ── catalog ──────────────────────────────────────────────────────────
-- FRP item-number -> name/label/type/mmc lookup ("Baza FRP" in the UI).
CREATE TABLE IF NOT EXISTS frp_catalog (
  item_number TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'XB' CHECK (type IN ('XB', 'Z')),
  mmc         BOOLEAN NOT NULL DEFAULT FALSE
);

-- ── drums ────────────────────────────────────────────────────────────
-- Stable identity for a physical drum, independent of its (editable)
-- number/label. *_current and *_stock rows reference drums.id so a
-- renumbering doesn't break the link between old and new records; the
-- denormalized drum_number columns elsewhere are just a display copy
-- (frozen at snapshot time in *_stock, kept in sync in *_current).
CREATE TABLE IF NOT EXISTS drums (
  id          UUID PRIMARY KEY,
  drum_number TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── current stock (live, editable) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS frp_current (
  id                 UUID PRIMARY KEY,
  frp_item_number    TEXT NOT NULL DEFAULT '',
  drum_id            UUID REFERENCES drums(id),
  drum_number        TEXT NOT NULL DEFAULT '',
  length             TEXT NOT NULL DEFAULT '',
  location           TEXT NOT NULL DEFAULT '',
  reserved_for_order BOOLEAN NOT NULL DEFAULT FALSE,
  remark             TEXT NOT NULL DEFAULT '',
  position           INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coated_frp_current (
  id                 UUID PRIMARY KEY,
  drum_id            UUID REFERENCES drums(id),
  drum_number        TEXT NOT NULL DEFAULT '',
  diameter           TEXT NOT NULL DEFAULT '',
  type               TEXT NOT NULL DEFAULT 'XB' CHECK (type IN ('XB', 'Z')),
  length             TEXT NOT NULL DEFAULT '',
  location           TEXT NOT NULL DEFAULT '',
  reserved_for_order BOOLEAN NOT NULL DEFAULT FALSE,
  remark             TEXT NOT NULL DEFAULT '',
  position           INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS filler_current (
  id                 UUID PRIMARY KEY,
  drum_id            UUID REFERENCES drums(id),
  drum_number        TEXT NOT NULL DEFAULT '',
  diameter           TEXT NOT NULL DEFAULT '',
  length             TEXT NOT NULL DEFAULT '',
  color              TEXT NOT NULL DEFAULT 'GRAY' CHECK (color IN ('GRAY', 'WHITE', 'BLACK')),
  flameproof         BOOLEAN NOT NULL DEFAULT FALSE,
  location           TEXT NOT NULL DEFAULT 'PRZED' CHECK (location IN ('PRZED', 'ZA')),
  reserved_for_order BOOLEAN NOT NULL DEFAULT FALSE,
  remark             TEXT NOT NULL DEFAULT '',
  position           INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_frp_current_drum ON frp_current (drum_id);
CREATE INDEX IF NOT EXISTS idx_coated_frp_current_drum ON coated_frp_current (drum_id);
CREATE INDEX IF NOT EXISTS idx_filler_current_drum ON filler_current (drum_id);

-- ── stock-take history ──────────────────────────────────────────────
-- One row per material check (e.g. "FRP checked Tuesday"). yes_count/
-- no_count are the totals from that check; only "yes" (found) items get
-- a snapshot row in <material>_stock below — "no" (missing) items leave
-- no item-level trace, which is why the count has to be stored here.
CREATE TABLE IF NOT EXISTS stock_versions (
  id           UUID PRIMARY KEY,
  material_key TEXT NOT NULL CHECK (material_key IN ('frp', 'coatedFrp', 'filler')),
  performed_by TEXT,
  performed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  yes_count    INTEGER NOT NULL DEFAULT 0,
  no_count     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_stock_versions_material_time ON stock_versions (material_key, performed_at DESC);

-- A "stock" bundles one version per material for a given round (e.g.
-- Tuesday: frp+filler checked, coatedFrp not — its column points at
-- Wednesday's still-current coatedFrp version instead of a fresh one).
CREATE TABLE IF NOT EXISTS stocks (
  id                    UUID PRIMARY KEY,
  performed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  frp_version_id        UUID REFERENCES stock_versions(id),
  coated_frp_version_id UUID REFERENCES stock_versions(id),
  filler_version_id     UUID REFERENCES stock_versions(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS frp_stock (
  id              UUID PRIMARY KEY,
  version_id      UUID NOT NULL REFERENCES stock_versions(id) ON DELETE CASCADE,
  frp_item_number TEXT NOT NULL DEFAULT '',
  drum_id         UUID REFERENCES drums(id),
  drum_number     TEXT NOT NULL DEFAULT '',
  length          TEXT NOT NULL DEFAULT '',
  location        TEXT NOT NULL DEFAULT '',
  remark          TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS coated_frp_stock (
  id           UUID PRIMARY KEY,
  version_id   UUID NOT NULL REFERENCES stock_versions(id) ON DELETE CASCADE,
  drum_id      UUID REFERENCES drums(id),
  drum_number  TEXT NOT NULL DEFAULT '',
  diameter     TEXT NOT NULL DEFAULT '',
  type         TEXT NOT NULL DEFAULT 'XB' CHECK (type IN ('XB', 'Z')),
  length       TEXT NOT NULL DEFAULT '',
  location     TEXT NOT NULL DEFAULT '',
  remark       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS filler_stock (
  id           UUID PRIMARY KEY,
  version_id   UUID NOT NULL REFERENCES stock_versions(id) ON DELETE CASCADE,
  drum_id      UUID REFERENCES drums(id),
  drum_number  TEXT NOT NULL DEFAULT '',
  diameter     TEXT NOT NULL DEFAULT '',
  length       TEXT NOT NULL DEFAULT '',
  color        TEXT NOT NULL DEFAULT 'GRAY' CHECK (color IN ('GRAY', 'WHITE', 'BLACK')),
  flameproof   BOOLEAN NOT NULL DEFAULT FALSE,
  location     TEXT NOT NULL DEFAULT '',
  remark       TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_frp_stock_version ON frp_stock (version_id);
CREATE INDEX IF NOT EXISTS idx_frp_stock_drum ON frp_stock (drum_id);
CREATE INDEX IF NOT EXISTS idx_coated_frp_stock_version ON coated_frp_stock (version_id);
CREATE INDEX IF NOT EXISTS idx_coated_frp_stock_drum ON coated_frp_stock (drum_id);
CREATE INDEX IF NOT EXISTS idx_filler_stock_version ON filler_stock (version_id);
CREATE INDEX IF NOT EXISTS idx_filler_stock_drum ON filler_stock (drum_id);

-- ── unchanged from the previous schema ──────────────────────────────
-- One row per material while it is being edited by someone; TTL-based
-- expiry is enforced in application code (locked_at + LOCK_TTL_SECONDS).
CREATE TABLE IF NOT EXISTS category_locks (
  material    TEXT PRIMARY KEY,
  locked_by   TEXT NOT NULL,
  locked_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Whether a material's stock-take was already finalized/exported.
CREATE TABLE IF NOT EXISTS stock_status (
  material     TEXT PRIMARY KEY,
  completed    BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   TEXT
);
