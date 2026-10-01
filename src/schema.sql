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

-- Places a transport order can go to/come from - pulled in early from the
-- still-draft transport-orders module (src/orders.draft.sql) because
-- line_material_rules below needs a real table of production lines to
-- reference; the rest of that module (orders/order_items/...) stays draft.
-- The production lines are fixed (is_line); a future goods_transport
-- order's free-text "skąd"/"dokąd" would register any other place here too
-- (not built yet - see orders.draft.sql).
CREATE TABLE IF NOT EXISTS locations (
  name       TEXT PRIMARY KEY CHECK (btrim(name) <> ''),
  is_line    BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- "sh01" must not become a second place next to "SH01".
CREATE UNIQUE INDEX IF NOT EXISTS locations_lower_name_idx ON locations (lower(name));
INSERT INTO locations (name, is_line)
  SELECT 'SH' || lpad(g::text, 2, '0'), true FROM generate_series(1, 7) g
  UNION ALL SELECT 'ST' || lpad(g::text, 2, '0'), true FROM generate_series(1, 13) g
  UNION ALL SELECT 'FC' || lpad(g::text, 2, '0'), true FROM generate_series(1, 3) g
  UNION ALL SELECT 'FL01', true
ON CONFLICT DO NOTHING;

-- "Wytyczne do transportów" (wps nav): a standing instruction for a
-- production line, either about one material on it - e.g. line SH02 needs
-- Glass Yarn/600tex delivered as short lengths first - or about the line
-- itself whatever is being brought ("item_no IS NULL", e.g. "wjazd od
-- strony hali B"). item_no is deliberately NOT a whole sm_catalog category
-- either way: real data shows the relevant distinction (600tex vs 1200tex
-- Glass Yarn) lives inside one category as separate item numbers, so a
-- category-wide rule would either miss the 600tex item or wrongly catch
-- the 1200tex one. A small, manually-maintained reference table, not
-- derived from anything - see src/lineMaterialRules.js.
--
-- One row per (line, item), and at most one line-wide row per line: the
-- plain UNIQUE below cannot enforce the latter, because Postgres treats
-- NULLs as distinct and would happily take five line-wide rules for the
-- same line - hence the partial unique index after the table.
CREATE TABLE IF NOT EXISTS line_material_rules (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  line_name  TEXT NOT NULL REFERENCES locations (name),
  item_no    TEXT,
  note       TEXT NOT NULL CHECK (btrim(note) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (line_name, item_no)
);
-- Migrating an existing installation (the CREATE TABLE above only ran
-- once): item_no used to be NOT NULL, before a guideline could apply to a
-- whole line.
ALTER TABLE line_material_rules ALTER COLUMN item_no DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS line_material_rules_line_only_idx
  ON line_material_rules (line_name) WHERE item_no IS NULL;

-- A rule only makes sense against a real production line, not some other
-- registered place.
CREATE OR REPLACE FUNCTION line_material_rules_before_write() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM locations WHERE name = NEW.line_name AND is_line) THEN
    RAISE EXCEPTION '% nie jest linią produkcyjną.', NEW.line_name;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS line_material_rules_before_write ON line_material_rules;
CREATE TRIGGER line_material_rules_before_write BEFORE INSERT OR UPDATE ON line_material_rules
  FOR EACH ROW EXECUTE PROCEDURE line_material_rules_before_write();

-- ── Transport orders ("Lista zamówień" / "Historia zamówień") ──────────
-- Folded in from src/orders.draft.sql (was a draft kept out of this file
-- while the design moved - see wpsapi/AGENTS.md's "Transport orders"
-- section for the full field-by-field writeup; that draft file is now
-- gone, this block is byte-for-byte what it held). People on the lines
-- ask forklift operators ("wózkowi", 3 shifts A/B/C) for a transport.
-- Our database is the source of truth; orders are NOT mirrored to CIP
-- (for now - see the roadmap in AGENTS.md).
--
-- Order number: [shift A/B/C][hour of the shift 1-8][minute 00-59]/[yymmdd of
-- the shift's START day]/[3 random digits], e.g. B137/260924/482 - the time
-- is read in Europe/Warsaw wall-clock, so the hour digit is always 1-8 even on
-- a daylight-saving night. Uniqueness: the random suffix is re-drawn until free.

-- The known spelling of a typed place (any capitals), or the trimmed text itself
-- when it is new; NULL for blank.
CREATE OR REPLACE FUNCTION canonical_location(txt TEXT) RETURNS TEXT AS $$
  SELECT COALESCE((SELECT name FROM locations WHERE lower(name) = lower(btrim(txt))), NULLIF(btrim(txt), ''))
$$ LANGUAGE sql STABLE;

CREATE TABLE IF NOT EXISTS order_types (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
INSERT INTO order_types (code, name) VALUES
  ('water_refill',      'Dolewanie wody'),
  ('material_order',    'Zamówienie materiału'),
  ('spool_order',       'Zamówienie szpul'),
  ('goods_transport',   'Transport półproduktów i wyrobów gotowych'),
  ('waste_removal',     'Wywóz odpadu'),
  ('warehouse_return',  'Zwrot na magazyn'),
  ('machine_transport', 'Transport maszyny')
ON CONFLICT DO NOTHING;

-- Three 8-hour shifts covering the whole day; a shift is defined by its start.
CREATE TABLE IF NOT EXISTS shifts (
  code      TEXT PRIMARY KEY CHECK (code IN ('A', 'B', 'C')),
  starts_at TIME NOT NULL
);
INSERT INTO shifts (code, starts_at) VALUES ('A', '06:00'), ('B', '14:00'), ('C', '22:00')
ON CONFLICT DO NOTHING;

-- Which shift a moment falls in: its code, the date the shift STARTED on
-- (for C after midnight that is the day before), the hour of the shift
-- (1-8, by the wall clock) and the minute.
CREATE OR REPLACE FUNCTION order_shift(ts timestamptz)
RETURNS TABLE (shift_code TEXT, shift_date DATE, shift_hour INT, minute_of_hour INT) AS $$
  WITH local AS (SELECT ts AT TIME ZONE 'Europe/Warsaw' AS t),
  starts AS (
    SELECT s.code,
           CASE WHEN (l.t::date + s.starts_at) > l.t
                THEN (l.t::date - 1) + s.starts_at
                ELSE l.t::date + s.starts_at END AS started
    FROM shifts s, local l
  )
  SELECT st.code,
         st.started::date,
         floor(extract(epoch FROM (l.t - st.started)) / 3600)::int + 1,
         extract(minute FROM l.t)::int
  FROM starts st, local l
  ORDER BY st.started DESC
  LIMIT 1
$$ LANGUAGE sql STABLE;

CREATE TABLE IF NOT EXISTS orders (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_no      TEXT NOT NULL UNIQUE,               -- set by the trigger below
  type          TEXT NOT NULL REFERENCES order_types (code),
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'problem', 'delivered', 'done', 'cancelled')),
  requested_by  TEXT NOT NULL,                      -- employee number
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  shift_code    TEXT NOT NULL,                      -- shift it was placed in (trigger)
  shift_date    DATE NOT NULL,                      -- day that shift started (trigger)
  from_location TEXT REFERENCES locations (name),   -- where to pick up
  to_location   TEXT REFERENCES locations (name),   -- where to deliver
  -- The company's own client order (what fiber-optic products a customer
  -- ordered, e.g. from an ERP) - a separate thing from order_no above (our
  -- own generated code) and from details->>'production_order_no' below (the
  -- production order material_order queries CIP with). Optional, not tied to
  -- a particular type yet - scope this down once it's clearer which types
  -- actually carry one.
  client_order_no TEXT,
  note          TEXT NOT NULL DEFAULT '',
  -- Type-specific fields: {"water": "clean"|"dirty"} for water_refill,
  -- {"production_order_no": "..."} for material_order. Kept loose on purpose -
  -- the inputs per type are still being decided.
  details       JSONB NOT NULL DEFAULT '{}',
  taken_by      TEXT,
  taken_at      TIMESTAMPTZ,
  -- "Dostarczone" (material_order only, set from smVendor once every
  -- order_item is fully issued - see order_items_progress) - the working
  -- part is done, but the requester hasn't confirmed receipt yet.
  delivered_by  TEXT,
  delivered_at  TIMESTAMPTZ,
  -- Who/what closed a delivered order: the requester themselves (accept),
  -- or 'auto' when nobody acted within the 10-minute window (see
  -- autoAcceptDeliveredOrders in orders.js). Null for an order that never
  -- passed through 'delivered' (most types still just go straight to
  -- 'done' - see orders_before_update).
  accepted_by   TEXT,
  accepted_at   TIMESTAMPTZ,
  completed_by  TEXT,                               -- "Zrealizował" (forklift operator)
  completed_at  TIMESTAMPTZ,
  completed_shift_code TEXT,                        -- shift that fulfilled it (trigger)
  completed_shift_date DATE,
  cancelled_at  TIMESTAMPTZ,
  -- Also doubles as "problem zgłoszony przez zamawiającego" when cancelled
  -- straight from 'delivered' (see orders_before_update) - the requester's
  -- own problem note, not just an office-side cancellation reason.
  cancel_reason TEXT,
  CONSTRAINT orders_type_fields CHECK (
    CASE type
      WHEN 'water_refill'      THEN to_location IS NOT NULL AND from_location IS NULL
                                    AND coalesce(details ->> 'water', '') IN ('clean', 'dirty')
      WHEN 'material_order'    THEN to_location IS NOT NULL AND from_location IS NULL
                                    AND coalesce(details ->> 'production_order_no', '') <> ''
      -- no agreed inputs yet: asks like a material order, minus the production order number
      WHEN 'spool_order'       THEN to_location IS NOT NULL AND from_location IS NULL
      WHEN 'goods_transport'   THEN from_location IS NOT NULL AND to_location IS NOT NULL
                                    AND lower(from_location) <> lower(to_location)
      WHEN 'waste_removal'     THEN from_location IS NOT NULL AND to_location IS NULL
      WHEN 'warehouse_return'  THEN from_location IS NOT NULL AND to_location IS NULL
      WHEN 'machine_transport' THEN from_location IS NOT NULL AND to_location IS NOT NULL
      ELSE false
    END
  ),
  CONSTRAINT orders_status_fields CHECK (
    (status = 'new'         AND taken_at IS NULL AND delivered_at IS NULL AND completed_at IS NULL AND cancelled_at IS NULL)
 OR (status = 'in_progress' AND taken_at IS NOT NULL AND taken_by IS NOT NULL
                            AND delivered_at IS NULL AND completed_at IS NULL AND cancelled_at IS NULL)
 OR (status = 'problem'     AND taken_at IS NOT NULL AND taken_by IS NOT NULL
                            AND delivered_at IS NULL AND completed_at IS NULL AND cancelled_at IS NULL)
 OR (status = 'delivered'   AND taken_at IS NOT NULL AND taken_by IS NOT NULL
                            AND delivered_at IS NOT NULL AND delivered_by IS NOT NULL
                            AND completed_at IS NULL AND cancelled_at IS NULL)
 OR (status = 'done'        AND completed_at IS NOT NULL AND completed_by IS NOT NULL AND cancelled_at IS NULL)
 OR (status = 'cancelled'   AND cancelled_at IS NOT NULL AND completed_at IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS orders_status_created_idx ON orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_requested_by_idx ON orders (requested_by);

-- Migrating an existing installation: the CREATE TABLE above only ran once
-- (IF NOT EXISTS), so an already-migrated `orders` table needs these added
-- by hand - new columns, then DROP+ADD for the two CHECK constraints
-- widened above (a column-level/named CHECK's definition can't be altered
-- in place, only replaced). Idempotent: safe to run again unchanged.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_by TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS accepted_by TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
-- The problem the forklift operator is currently stuck on, if any (status
-- 'problem'): what is wrong, who said so, when, and when it was resolved.
-- problem_note is cleared on resolution - it answers "what is blocking this
-- now" - while order_events keeps every episode for the timeline.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS problem_note TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS problem_reported_by TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS problem_reported_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS problem_resolved_by TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS problem_resolved_at TIMESTAMPTZ;
-- Which status the problem was reported from, and therefore **whose turn it
-- is to answer it**: 'in_progress' = the forklift operator got stuck, so the
-- requester answers; 'delivered' = the requester disputes what arrived, so
-- the operator answers. Both resolve back to in_progress. Without this a
-- client cannot tell the two apart - the row looks identical - and would
-- offer the resolve button to the person who reported it.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS problem_reported_from TEXT NOT NULL DEFAULT '';
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN ('new', 'in_progress', 'problem', 'delivered', 'done', 'cancelled'));
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_fields;
ALTER TABLE orders ADD CONSTRAINT orders_status_fields CHECK (
    (status = 'new'         AND taken_at IS NULL AND delivered_at IS NULL AND completed_at IS NULL AND cancelled_at IS NULL)
 OR (status = 'in_progress' AND taken_at IS NOT NULL AND taken_by IS NOT NULL
                            AND delivered_at IS NULL AND completed_at IS NULL AND cancelled_at IS NULL)
 OR (status = 'problem'     AND taken_at IS NOT NULL AND taken_by IS NOT NULL
                            AND delivered_at IS NULL AND completed_at IS NULL AND cancelled_at IS NULL)
 OR (status = 'delivered'   AND taken_at IS NOT NULL AND taken_by IS NOT NULL
                            AND delivered_at IS NOT NULL AND delivered_by IS NOT NULL
                            AND completed_at IS NULL AND cancelled_at IS NULL)
 OR (status = 'done'        AND completed_at IS NOT NULL AND completed_by IS NOT NULL AND cancelled_at IS NULL)
 OR (status = 'cancelled'   AND cancelled_at IS NOT NULL AND completed_at IS NULL)
);
-- Swept every minute by autoAcceptDeliveredOrders (orders.js) - only
-- delivered orders are ever candidates, so this index keeps that query
-- (and the plain "is this order awaiting acceptance" ones) off a full scan.
CREATE INDEX IF NOT EXISTS orders_delivered_at_idx ON orders (delivered_at) WHERE status = 'delivered';

-- Everything that ever happened to an order, in order - what makes a
-- situation reconstructible afterwards instead of only its latest state
-- being knowable. The columns on `orders` keep *when each stage was last
-- reached*; this keeps the whole sequence, which matters as soon as a stage
-- can repeat: a problem may be reported, resolved and reported again, and
-- "there were three problems, the second one took 40 minutes" is not
-- answerable from a single cancel_reason column.
--
-- Written by orders_after_update below, not by the application: a status
-- change cannot then be made without the event being recorded, whichever
-- client or SQL did it.
CREATE TABLE IF NOT EXISTS order_events (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id   BIGINT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  -- The status the order moved **to**, plus 'created' for the very first
  -- row. Deliberately the same vocabulary as orders.status rather than a
  -- separate set of event names - one less mapping to keep in step.
  kind       TEXT NOT NULL,
  -- Who caused it, as that stage's own actor (taken_by, delivered_by,
  -- accepted_by...) - '' when the row was written by something with no
  -- person behind it, e.g. the auto-accept sweep, which records 'auto'.
  actor      TEXT NOT NULL DEFAULT '',
  -- Free text that belongs to this event: a problem's description, a
  -- cancellation reason. '' when the event carries none.
  note       TEXT NOT NULL DEFAULT '',
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_events_order_idx ON order_events (order_id, at);

-- The note for the *next* event, set by the caller in the same transaction
-- as the UPDATE (see orders.js's withEventNote). A trigger cannot see a
-- function argument, and adding a "pending note" column to `orders` would
-- leave dead data on the row, so this rides on a transaction-local GUC.
CREATE OR REPLACE FUNCTION orders_after_update() RETURNS trigger AS $$
DECLARE
  who TEXT;
BEGIN
  IF NEW.status = OLD.status THEN RETURN NULL; END IF;
  who := CASE NEW.status
           -- Resuming after a problem is not the same person as taking the
           -- order in the first place: it is whoever answered the problem.
           WHEN 'in_progress' THEN CASE WHEN OLD.status = 'problem'
                                        THEN COALESCE(NEW.problem_resolved_by, '')
                                        ELSE COALESCE(NEW.taken_by, '') END
           WHEN 'problem'     THEN COALESCE(NEW.problem_reported_by, '')
           WHEN 'delivered'   THEN COALESCE(NEW.delivered_by, '')
           WHEN 'done'        THEN COALESCE(NEW.accepted_by, NEW.completed_by, '')
           ELSE ''
         END;
  INSERT INTO order_events (order_id, kind, actor, note)
  VALUES (
    NEW.id,
    NEW.status,
    who,
    COALESCE(NULLIF(current_setting('wps.event_note', true), ''), '')
  );
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_after_update ON orders;
CREATE TRIGGER orders_after_update AFTER UPDATE ON orders
  FOR EACH ROW EXECUTE PROCEDURE orders_after_update();

-- The order being placed is the first event, so a timeline starts where the
-- order does.
CREATE OR REPLACE FUNCTION orders_after_insert() RETURNS trigger AS $$
BEGIN
  INSERT INTO order_events (order_id, kind, actor) VALUES (NEW.id, 'created', COALESCE(NEW.requested_by, ''));
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_after_insert ON orders;
CREATE TRIGGER orders_after_insert AFTER INSERT ON orders
  FOR EACH ROW EXECUTE PROCEDURE orders_after_insert();

-- Material and spool orders only: what is ordered. Name and unit come from the catalog
-- (sm_catalog) whatever the caller sends; an item the catalog doesn't know is
-- refused, so a unit always exists.
CREATE TABLE IF NOT EXISTS order_items (
  order_id  BIGINT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  item_no   TEXT NOT NULL,
  item_name TEXT NOT NULL DEFAULT '',
  quantity  NUMERIC NOT NULL CHECK (quantity > 0),
  unit      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (order_id, item_no)
);

-- Photos: only a storage key here (where the file lives is still open - disk
-- or object storage); a download link is generated on demand from it.
CREATE TABLE IF NOT EXISTS order_photos (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id     BIGINT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  storage_key  TEXT NOT NULL,
  content_type TEXT NOT NULL,
  uploaded_by  TEXT NOT NULL,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_photos_order_idx ON order_photos (order_id);

-- ------------------------------------------------------------------ triggers
-- Places, number and shift on insert. Concurrent orders of the same minute are
-- serialized by an advisory lock on the number's prefix, so the "is it free"
-- check below cannot race.
CREATE OR REPLACE FUNCTION orders_before_insert() RETURNS trigger AS $$
DECLARE
  s RECORD;
  base TEXT;
  candidate TEXT;
  next_seq INT;
BEGIN
  -- Places. A typed place takes its known spelling; goods_transport accepts any
  -- text (a new place is registered and becomes a suggestion), every other type
  -- only the production lines.
  NEW.from_location := canonical_location(NEW.from_location);
  NEW.to_location := canonical_location(NEW.to_location);
  IF NEW.type = 'goods_transport' THEN
    INSERT INTO locations (name)
      SELECT p FROM unnest(ARRAY[NEW.from_location, NEW.to_location]) AS p WHERE p IS NOT NULL
    ON CONFLICT DO NOTHING;
  ELSIF EXISTS (
    SELECT 1 FROM unnest(ARRAY[NEW.from_location, NEW.to_location]) AS p
    WHERE p IS NOT NULL AND NOT EXISTS (SELECT 1 FROM locations l WHERE l.name = p AND l.is_line)
  ) THEN
    RAISE EXCEPTION 'To miejsce musi być jedną z linii produkcyjnych.';
  END IF;

  SELECT * INTO s FROM order_shift(NEW.created_at);
  NEW.shift_code := s.shift_code;
  NEW.shift_date := s.shift_date;
  base := s.shift_code || s.shift_hour::text || lpad(s.minute_of_hour::text, 2, '0')
          || '/' || to_char(s.shift_date, 'YYMMDD');
  -- Serializes same-minute orders, so the MAX+1 below cannot race: two
  -- concurrent inserts in the same minute queue instead of both reading the
  -- same maximum.
  PERFORM pg_advisory_xact_lock(hashtext(base));
  -- The suffix counts orders **within this minute** and starts over at 1 in
  -- the next one (the minute is already in `base`, so that reset is what
  -- keeps the whole number unique). It used to be 3 random digits, which
  -- made a number needlessly long - "/124" for the only order in its
  -- minute - and meant two numbers from the same minute sorted
  -- arbitrarily. Counting instead: usually "/1", and ascending within a
  -- minute.
  --
  -- MAX+1 rather than count+1: a deleted row would make count+1 re-issue a
  -- number that already existed. Old-format numbers share the same base, so
  -- in a minute that already holds one, counting simply continues past it
  -- (e.g. after "/124" the next is "/125") - no collision, and nothing has
  -- to be migrated.
  SELECT COALESCE(MAX(NULLIF(split_part(o.order_no, '/', 3), '')::int), 0) + 1
    INTO next_seq
    FROM orders o
   WHERE o.order_no LIKE base || '/%';
  candidate := base || '/' || next_seq::text;
  -- Belt and braces: the lock above makes a clash impossible, but order_no
  -- is UNIQUE and a surprise here must not become a 23505 the caller cannot
  -- read.
  IF EXISTS (SELECT 1 FROM orders WHERE order_no = candidate) THEN
    RAISE EXCEPTION 'Nie udało się nadać numeru zamówienia (%).', candidate;
  END IF;
  NEW.order_no := candidate;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_before_insert ON orders;
CREATE TRIGGER orders_before_insert BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE PROCEDURE orders_before_insert();

-- Status changes: who may go where, timestamps filled in, the shift that
-- fulfilled it worked out from the completion time. A closed order is frozen.
CREATE OR REPLACE FUNCTION orders_before_update() RETURNS trigger AS $$
DECLARE
  s RECORD;
BEGIN
  IF NEW.order_no <> OLD.order_no OR NEW.type <> OLD.type
     OR NEW.requested_by <> OLD.requested_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Numeru, typu, zamawiającego i daty utworzenia nie można zmienić.';
  END IF;

  IF NEW.status <> OLD.status THEN
    -- 'delivered' (set from smVendor once every item is issued, or straight
    -- away for a type with no items - see wpsApi's AGENTS.md) sits between
    -- in_progress and done: the requester then has a 10-minute window to
    -- accept (-> done) or report a problem (-> cancelled) before
    -- autoAcceptDeliveredOrders (orders.js) accepts it for them.
    --
    -- 'problem' is a report that **the other side has to answer**, from
    -- either direction, and in neither case is the order cancelled:
    --   in_progress -> problem : the forklift operator cannot finish
    --     ("Zgłoś problem" in smVendor); the requester answers.
    --   delivered   -> problem : the requester disputes what arrived
    --     ("Zgłoś problem" in smOrder/wps); the operator answers.
    -- Either way "Problem rozwiązany" puts it back to in_progress, so the
    -- work carries on from where it was. It can loop - a problem may be
    -- reported, resolved and reported again, from both sides - which is why
    -- every transition is logged to order_events rather than only the latest
    -- one being kept. problem_reported_from records which of the two it is,
    -- i.e. whose turn it is to answer.
    --
    -- **An order can only be cancelled while nobody has started it**
    -- (`new -> cancelled`). Once a forklift operator has taken it, the only
    -- ways out are "zrealizowane" or the problem loop - never a
    -- cancellation. Enforced here, in the database, deliberately: this is
    -- the rule that was being broken from the outside (a "Zgłoś problem"
    -- that cancelled), so no client - including an old build still
    -- installed on somebody's phone - can get round it. They get an error
    -- instead, which is also how a stale client makes itself known.
    IF NOT ((OLD.status = 'new' AND NEW.status IN ('in_progress', 'done', 'cancelled'))
         OR (OLD.status = 'in_progress' AND NEW.status IN ('delivered', 'problem', 'done'))
         OR (OLD.status = 'problem' AND NEW.status = 'in_progress')
         OR (OLD.status = 'delivered' AND NEW.status IN ('problem', 'done'))) THEN
      IF NEW.status = 'cancelled' THEN
        RAISE EXCEPTION 'Zamówienia w realizacji nie można anulować - zgłoś problem.';
      END IF;
      RAISE EXCEPTION 'Niedozwolona zmiana statusu: % -> %.', OLD.status, NEW.status;
    END IF;
    IF NEW.status = 'in_progress' THEN
      NEW.taken_at := COALESCE(NEW.taken_at, now());
    ELSIF NEW.status = 'problem' THEN
      -- A problem reported on a delivery **un-delivers** it: the handover is
      -- disputed, so it did not count and has to happen again. Required by
      -- orders_status_fields (a 'problem' row carries no delivered_*), and
      -- right anyway - it also takes the order out of the auto-accept sweep,
      -- which would otherwise close a delivery somebody just rejected.
      NEW.delivered_at := NULL;
      NEW.delivered_by := NULL;
    ELSIF NEW.status = 'delivered' THEN
      NEW.delivered_at := COALESCE(NEW.delivered_at, now());
    ELSIF NEW.status = 'done' THEN
      NEW.completed_at := COALESCE(NEW.completed_at, now());
      IF OLD.status = 'delivered' THEN
        NEW.accepted_at := COALESCE(NEW.accepted_at, now());
      END IF;
      SELECT * INTO s FROM order_shift(NEW.completed_at);
      NEW.completed_shift_code := s.shift_code;
      NEW.completed_shift_date := s.shift_date;
    ELSIF NEW.status = 'cancelled' THEN
      NEW.cancelled_at := COALESCE(NEW.cancelled_at, now());
    END IF;
  ELSIF OLD.status IN ('done', 'cancelled') THEN
    RAISE EXCEPTION 'Zamówienie w statusie % jest zamknięte.', OLD.status;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_before_update ON orders;
CREATE TRIGGER orders_before_update BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE PROCEDURE orders_before_update();

-- A material or spool order needs at least one item - checked when the transaction
-- commits, so the order and its items can be inserted together.
CREATE OR REPLACE FUNCTION orders_require_items() RETURNS trigger AS $$
BEGIN
  IF NEW.type IN ('material_order', 'spool_order') AND NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = NEW.id) THEN
    RAISE EXCEPTION 'Zamówienie materiału lub szpul musi mieć co najmniej jedną pozycję.';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_require_items ON orders;
CREATE CONSTRAINT TRIGGER orders_require_items AFTER INSERT ON orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE PROCEDURE orders_require_items();

-- Items: only on material and spool orders - both counted by piece
-- ("szt."), whatever sm_catalog's own unit for the material is (km, kg...) -
-- an order line here is a count of pieces to hand over, not a length/weight.
--   material_order: the item itself must be real - name comes from the
--     catalog, never what the caller sent; an item number the catalog
--     doesn't know is refused outright.
--   spool_order: empty/new physical spools, which sm_catalog has no notion
--     of at all - not consulted here (for now, per that decision - revisit
--     if spool types end up wanting their own reference list). item_name is
--     whatever the caller sent (e.g. the spool type, "1610"), just required
--     to be non-blank since nothing else backstops it.
CREATE OR REPLACE FUNCTION order_items_before_write() RETURNS trigger AS $$
DECLARE
  order_type TEXT;
  c RECORD;
BEGIN
  SELECT type INTO order_type FROM orders WHERE id = NEW.order_id;
  IF order_type NOT IN ('material_order', 'spool_order') THEN
    RAISE EXCEPTION 'Pozycje można dodać tylko do zamówienia materiału lub szpul.';
  END IF;

  IF order_type = 'material_order' THEN
    SELECT item_name INTO c FROM sm_catalog WHERE item_no = NEW.item_no;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Nieznany item % - nie ma go w katalogu materiałów.', NEW.item_no;
    END IF;
    NEW.item_name := c.item_name;
  ELSE
    IF btrim(coalesce(NEW.item_name, '')) = '' THEN
      RAISE EXCEPTION 'Podaj nazwę/typ szpuli.';
    END IF;
  END IF;
  NEW.unit := 'szt.';
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS order_items_before_write ON order_items;
CREATE TRIGGER order_items_before_write BEFORE INSERT OR UPDATE ON order_items
  FOR EACH ROW EXECUTE PROCEDURE order_items_before_write();

-- order_items with the standing instruction attached, when the order's own
-- to_location (material_order/spool_order only ever deliver, never pick up)
-- and this item match one - computed live off line_material_rules, so an
-- edited/added rule is reflected on every order that matches it right away,
-- not just ones placed after the edit. NULL rule_note is the common case
-- (nothing special about this item on this line).
CREATE OR REPLACE VIEW order_items_with_notes AS
SELECT oi.*, r.note AS rule_note
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
LEFT JOIN line_material_rules r ON r.line_name = o.to_location AND r.item_no = oi.item_no;

-- "Obsługa zamówień" (smpda) - which order an issue was scanned/issued
-- against, so a material_order's own checklist can auto-check an item off
-- the moment it's issued instead of needing a manual mark (see
-- order_items_progress below). Added here (not next to sm_operations' own
-- CREATE TABLE, much earlier in this file) because it references `orders`,
-- which doesn't exist yet at that point in the script. Nullable: an
-- ordinary receipt/issue with no order context (the vast majority) leaves
-- this blank, unchanged from before this column existed.
ALTER TABLE sm_operations ADD COLUMN IF NOT EXISTS order_id BIGINT REFERENCES orders (id);
CREATE INDEX IF NOT EXISTS idx_sm_operations_order ON sm_operations (order_id) WHERE order_id IS NOT NULL;

-- order_items with how much of each has actually been issued so far -
-- summed live off sm_operations' own order_id (see the column just above),
-- same "computed live, nothing stored twice" approach as
-- order_items_with_notes above. Only 'issue' rows count (a 'receipt'/
-- 'labeling' would never carry an order_id in practice, but the filter is
-- explicit rather than assumed). Fully issued when issued_quantity >=
-- quantity - left for the caller to compare rather than a boolean column
-- here, so rounding/partial-issue display stays a display concern.
--
-- FRP (sm_catalog.category = 'FRP') is the one exception to "sum the
-- issued quantity": order_items.quantity for FRP means "N separate drums",
-- but each drum's own real quantity is metres of cable on it (sm_catalog's
-- own unit is "KM") - summing metres could never sensibly reach "2" the
-- way it needs to for a 2-drum order line. Counted by number of issue
-- scans instead (each whole-spool issue is exactly one drum handed over -
-- see smpda's ReceiveIssueController, IssueKind.unit), same idea as
-- schema.sql's own note that a spool is "always issued whole". Every other
-- category keeps the plain sum.
-- issued_unit is what actually labels issued_quantity - "szt." for FRP
-- (it's a drum count, exactly like order_items.unit already is, not a
-- length), the catalog's own unit for everything else (e.g. "kg" - NOT
-- order_items.unit, which is always "szt." regardless of category and
-- would mislabel a real, summed weight). Computed once, here, rather than
-- separately by every client that shows this (wps/smpda both used to look
-- the catalog unit up themselves - see their own git history - which is
-- exactly how the FRP case first got mislabeled "2 KM" for a drum count).
CREATE OR REPLACE VIEW order_items_progress AS
SELECT oi.*,
  CASE WHEN c.category = 'FRP'
    THEN COUNT(op.id) FILTER (WHERE op.operation = 'issue')
    ELSE COALESCE(SUM(op.quantity::numeric) FILTER (WHERE op.operation = 'issue'), 0)
  END AS issued_quantity,
  CASE WHEN c.category = 'FRP' THEN 'szt.' ELSE COALESCE(c.unit, '') END AS issued_unit,
  -- Every distinct batch number the issuing scan(s) carried (see
  -- sm_operations.product_batch - smpda's own ScannedCode, the 5th
  -- "#"-separated field on a supplier label) - usually just one, but an
  -- order line can be filled across more than one scan (partial aggregate
  -- issues, or several FRP drums), each possibly its own batch. Comma-
  -- separated rather than an array/json - every other free-text list this
  -- API already returns (e.g. wps's own unfulfilled-items message in
  -- orders.js) is a plain joined string, not a nested structure a caller
  -- has to unpack.
  STRING_AGG(DISTINCT NULLIF(op.product_batch, ''), ', ') FILTER (WHERE op.operation = 'issue') AS issued_batches,
  -- The catalog's own category/unit, exposed as-is (not just baked into
  -- issued_unit above) - wps's own per-material "Wydano" line formats FRP
  -- differently (one segment per drum: "SZP-1(2.3km) + SZP-2(4.85km)"),
  -- which needs to know *is this FRP* and the real length unit ("KM"), not
  -- issued_unit's own "szt." drum-count label.
  c.category AS item_category,
  c.unit AS catalog_unit,
  -- Every individual issue scan against this line, oldest first - what the
  -- per-drum FRP display above is built from client-side (unit_id + that
  -- scan's own quantity); every other category's own display still just
  -- uses the plain issued_quantity/issued_unit sum above and ignores this.
  -- NULL (not '[]') when nothing's been issued yet - same "absent, not an
  -- empty placeholder" convention json_agg already defaults to.
  json_agg(json_build_object('unitId', NULLIF(op.unit_id, ''), 'quantity', op.quantity) ORDER BY op.performed_at)
    FILTER (WHERE op.operation = 'issue') AS issued_entries,
  -- The standing instruction for *this* material on the line this order is
  -- going to ("Wytyczne do transportów" - see line_material_rules), joined
  -- here so every client shows the same thing without re-deriving the
  -- match: wps used to compute it in the browser from the whole rules
  -- list, which left smpda/smVendor/smOrder showing nothing. NULL for the
  -- ordinary case of nothing special about this material on that line.
  --
  -- Only the material-specific rules (r.item_no = oi.item_no) belong on an
  -- item. A line-wide rule (item_no IS NULL) is about the drive, not about
  -- any one material, so repeating it under every item would be noise -
  -- it rides on the order instead (see orders.js's own lineRuleNote).
  r.note AS rule_note
FROM order_items oi
LEFT JOIN sm_catalog c ON c.item_no = oi.item_no
LEFT JOIN sm_operations op ON op.order_id = oi.order_id AND op.item_no = oi.item_no
JOIN orders o ON o.id = oi.order_id
LEFT JOIN line_material_rules r ON r.line_name = o.to_location AND r.item_no = oi.item_no
GROUP BY oi.order_id, oi.item_no, oi.item_name, oi.quantity, oi.unit, c.category, c.unit, r.note;

-- ── Login history ("Historia logowania", wps's Zamówienia/Transporty nav) ──
-- Which physical forklift ("wózek") a PDA login happened on - smpda has no
-- per-user auth server-side (see AGENTS.md's "Auth": the CIP login itself
-- is the only per-operator check, wpsApi's own routes all share one bearer
-- token), so this is a plain append-only log, not tied to any other table.
-- Written by routes/auth.js's own /login handler whenever the caller sends
-- a `deviceLabel` (smpda's Settings screen, set once per physical PDA/
-- forklift - see smpda's own AppSettings/session_providers.dart) - a
-- browser login (wps/stock) never sends one, so this table only ever fills
-- with smpda logins, deliberately.
CREATE TABLE IF NOT EXISTS login_events (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_no   TEXT NOT NULL,
  device_label  TEXT NOT NULL,
  logged_in_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_events_time ON login_events (logged_in_at DESC);
