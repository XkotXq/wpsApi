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
-- a snapshot row in <material>_stock below - "no" (missing) items leave
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
-- Tuesday: frp+filler checked, coatedFrp not - its column points at
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

-- ── Materiały SM (Stock Manager concept) ────────────────────────────
-- Reference catalog of every known material (item number + name), used
-- to autofill a material's name when receiving stock in the "Materiały
-- SM" concept (see wps's lib/smMaterialsCatalog.js) - not tied to CIP or
-- any other table here, and no FK to a current-stock table: a material
-- can be in the catalog with nothing currently on hand, or (in theory)
-- be received before someone adds it here.
-- individually_tracked: whether this material is split into separate,
-- numbered physical units (spools) instead of one combined quantity -
-- only plain FRP items are, seeded via NULL-safe DEFAULT FALSE so an
-- unspecified/NULL value always means "not tracked", never an error.
CREATE TABLE IF NOT EXISTS sm_catalog (
  item_no               TEXT PRIMARY KEY,
  item_name             TEXT NOT NULL DEFAULT '',
  individually_tracked  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Added after the first version of the table (CREATE TABLE IF NOT EXISTS
-- won't touch an existing one): free-text category, unit of measure and
-- remark shown next to item number/name in the catalog.
ALTER TABLE sm_catalog ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT '';
ALTER TABLE sm_catalog ADD COLUMN IF NOT EXISTS unit     TEXT NOT NULL DEFAULT '';
ALTER TABLE sm_catalog ADD COLUMN IF NOT EXISTS remark   TEXT NOT NULL DEFAULT '';

-- A version counter for the whole catalog, bumped by a trigger on ANY change
-- (insert, update, delete - also a direct SQL edit or, later, a Hasura
-- mutation, not just this API's own routes). A client keeps a copy of the
-- catalog and asks GET /api/sm-catalog/version (a single number) to find out
-- whether that copy is stale, instead of downloading the whole list to compare.
CREATE TABLE IF NOT EXISTS sm_catalog_meta (
  id      BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  version BIGINT NOT NULL DEFAULT 0
);
INSERT INTO sm_catalog_meta (id, version) VALUES (TRUE, 0) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION bump_sm_catalog_version() RETURNS trigger AS $$
BEGIN
  UPDATE sm_catalog_meta SET version = version + 1 WHERE id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sm_catalog_version_bump ON sm_catalog;
CREATE TRIGGER sm_catalog_version_bump
  AFTER INSERT OR UPDATE OR DELETE ON sm_catalog
  FOR EACH STATEMENT EXECUTE PROCEDURE bump_sm_catalog_version();

-- Current stock for "Materiały SM" (Lista materiałów SM) - mirrors the
-- wps mock's own item shape exactly (see lib/smMaterialsSeed.js before it
-- moved server-side): trackedIndividually items keep their per-unit
-- detail in sm_units below and leave total_quantity blank; everything
-- else uses total_quantity and has no sm_units rows. pending_quantity is
-- the order-receipt workflow's holding area - quantity already received
-- but not yet split into labeled units (see AssignSpoolNumbersPanel) -
-- only ever set for a trackedIndividually item.
CREATE TABLE IF NOT EXISTS sm_items (
  item_no               TEXT PRIMARY KEY,
  item_name             TEXT NOT NULL DEFAULT '',
  location_code         TEXT NOT NULL DEFAULT '',
  note                  TEXT NOT NULL DEFAULT '',
  tracked_individually  BOOLEAN NOT NULL DEFAULT FALSE,
  total_quantity        TEXT NOT NULL DEFAULT '',
  pending_quantity       TEXT NOT NULL DEFAULT '',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per physical spool - only exists for a trackedIndividually
-- sm_items row. Whole rows get replaced together with their parent
-- item on every save (see src/smItems.js's upsertSmItem) rather than
-- edited field-by-field, same "just resend the current state" approach
-- sm_catalog's frontend caller doesn't need but this one does, since a
-- single mutation (issue/receive/assign/edit) can touch several units
-- at once.
CREATE TABLE IF NOT EXISTS sm_units (
  id             TEXT PRIMARY KEY,
  item_no        TEXT NOT NULL REFERENCES sm_items(item_no) ON DELETE CASCADE,
  unit_id        TEXT NOT NULL DEFAULT '',
  quantity       TEXT NOT NULL DEFAULT '',
  product_batch  TEXT NOT NULL DEFAULT '',
  note           TEXT NOT NULL DEFAULT '',
  cip_status     TEXT NOT NULL DEFAULT 'match' CHECK (cip_status IN ('match', 'mismatch')),
  position       INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sm_units_item ON sm_units (item_no);

-- Append-only receipt/issue log backing Historia operacji SM - replaces
-- the old localStorage-only history (see lib/smOperationHistory.js
-- before it moved server-side). unit_id/product_batch are blank for an
-- operation on an aggregate (non-individually-tracked) material.
CREATE TABLE IF NOT EXISTS sm_operations (
  id             UUID PRIMARY KEY,
  operation      TEXT NOT NULL CHECK (operation IN ('receipt', 'issue', 'labeling')),
  item_no        TEXT NOT NULL,
  item_name      TEXT NOT NULL DEFAULT '',
  unit_id        TEXT NOT NULL DEFAULT '',
  quantity       TEXT NOT NULL DEFAULT '',
  location_code  TEXT NOT NULL DEFAULT '',
  product_batch  TEXT NOT NULL DEFAULT '',
  performed_by   TEXT,
  performed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sm_operations_time ON sm_operations (performed_at DESC);

-- Small key/value store for Materiały SM settings. Currently one key,
-- "spoolSeries": the ordered list of spool-number series smpda's FRP module
-- hands out from (see src/smSpools.js) - absent means the built-in default.
CREATE TABLE IF NOT EXISTS sm_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
