-- DRAFT - transport orders ("Lista zamówień" / "Historia zamówień").
-- NOT wired into `npm run migrate` (src/schema.sql): the design is still
-- moving. Idempotent like schema.sql, so it can be folded in unchanged once
-- it settles. The tables are meant to be exposed through Hasura later; every
-- rule that must hold (statuses, required fields per type, order numbers) lives
-- here in the database, not in a client.
--
-- Order number: [shift A/B/C][hour of the shift 1-8][minute 00-59]/[yymmdd of
-- the shift's START day]/[3 random digits], e.g. B137/260924/482 - the time
-- is read in Europe/Warsaw wall-clock, so the hour digit is always 1-8 even on
-- a daylight-saving night. Uniqueness: the random suffix is re-drawn until free.

-- ---------------------------------------------------------------- reference
-- Places an order can go to / come from: the production lines.
CREATE TABLE IF NOT EXISTS lines (
  code TEXT PRIMARY KEY
);
INSERT INTO lines (code)
  SELECT 'SH' || lpad(g::text, 2, '0') FROM generate_series(1, 7) g
  UNION ALL SELECT 'ST' || lpad(g::text, 2, '0') FROM generate_series(1, 13) g
  UNION ALL SELECT 'FC' || lpad(g::text, 2, '0') FROM generate_series(1, 3) g
  UNION ALL SELECT 'FL01'
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS order_types (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
INSERT INTO order_types (code, name) VALUES
  ('water_refill',      'Dolewanie wody'),
  ('material_order',    'Zamówienie materiału'),
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

-- ------------------------------------------------------------------- orders
CREATE TABLE IF NOT EXISTS orders (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_no      TEXT NOT NULL UNIQUE,               -- set by the trigger below
  type          TEXT NOT NULL REFERENCES order_types (code),
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'done', 'cancelled')),
  requested_by  TEXT NOT NULL,                      -- employee number
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  shift_code    TEXT NOT NULL,                      -- shift it was placed in (trigger)
  shift_date    DATE NOT NULL,                      -- day that shift started (trigger)
  from_location TEXT REFERENCES lines (code),       -- where to pick up
  to_location   TEXT REFERENCES lines (code),       -- where to deliver
  note          TEXT NOT NULL DEFAULT '',
  -- Type-specific fields: {"water": "clean"|"dirty"} for water_refill,
  -- {"production_order_no": "..."} for material_order. Kept loose on purpose -
  -- the inputs per type are still being decided.
  details       JSONB NOT NULL DEFAULT '{}',
  taken_by      TEXT,
  taken_at      TIMESTAMPTZ,
  completed_by  TEXT,                               -- "Zrealizował" (forklift operator)
  completed_at  TIMESTAMPTZ,
  completed_shift_code TEXT,                        -- shift that fulfilled it (trigger)
  completed_shift_date DATE,
  cancelled_at  TIMESTAMPTZ,
  cancel_reason TEXT,
  CONSTRAINT orders_type_fields CHECK (
    CASE type
      WHEN 'water_refill'      THEN to_location IS NOT NULL AND from_location IS NULL
                                    AND coalesce(details ->> 'water', '') IN ('clean', 'dirty')
      WHEN 'material_order'    THEN to_location IS NOT NULL AND from_location IS NULL
                                    AND coalesce(details ->> 'production_order_no', '') <> ''
      WHEN 'goods_transport'   THEN from_location IS NOT NULL AND to_location IS NOT NULL
      WHEN 'waste_removal'     THEN from_location IS NOT NULL AND to_location IS NULL
      WHEN 'warehouse_return'  THEN from_location IS NOT NULL AND to_location IS NULL
      WHEN 'machine_transport' THEN from_location IS NOT NULL AND to_location IS NOT NULL
      ELSE false
    END
  ),
  CONSTRAINT orders_status_fields CHECK (
    (status = 'new'         AND taken_at IS NULL AND completed_at IS NULL AND cancelled_at IS NULL)
 OR (status = 'in_progress' AND taken_at IS NOT NULL AND taken_by IS NOT NULL
                            AND completed_at IS NULL AND cancelled_at IS NULL)
 OR (status = 'done'        AND completed_at IS NOT NULL AND completed_by IS NOT NULL AND cancelled_at IS NULL)
 OR (status = 'cancelled'   AND cancelled_at IS NOT NULL AND completed_at IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS orders_status_created_idx ON orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_requested_by_idx ON orders (requested_by);

-- Material orders only: what is ordered. Name and unit come from the catalog
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
-- Number + shift on insert. Concurrent orders of the same minute are
-- serialized by an advisory lock on the number's prefix, so the "is it free"
-- check below cannot race.
CREATE OR REPLACE FUNCTION orders_before_insert() RETURNS trigger AS $$
DECLARE
  s RECORD;
  base TEXT;
  candidate TEXT;
  tries INT := 0;
BEGIN
  SELECT * INTO s FROM order_shift(NEW.created_at);
  NEW.shift_code := s.shift_code;
  NEW.shift_date := s.shift_date;
  base := s.shift_code || s.shift_hour::text || lpad(s.minute_of_hour::text, 2, '0')
          || '/' || to_char(s.shift_date, 'YYMMDD');
  PERFORM pg_advisory_xact_lock(hashtext(base));
  LOOP
    candidate := base || '/' || lpad(floor(random() * 1000)::int::text, 3, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM orders WHERE order_no = candidate);
    tries := tries + 1;
    IF tries > 100 THEN
      RAISE EXCEPTION 'Nie udało się nadać numeru zamówienia (%).', base;
    END IF;
  END LOOP;
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
    IF NOT ((OLD.status = 'new' AND NEW.status IN ('in_progress', 'done', 'cancelled'))
         OR (OLD.status = 'in_progress' AND NEW.status IN ('done', 'cancelled'))) THEN
      RAISE EXCEPTION 'Niedozwolona zmiana statusu: % -> %.', OLD.status, NEW.status;
    END IF;
    IF NEW.status = 'in_progress' THEN
      NEW.taken_at := COALESCE(NEW.taken_at, now());
    ELSIF NEW.status = 'done' THEN
      NEW.completed_at := COALESCE(NEW.completed_at, now());
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

-- A material order needs at least one item - checked when the transaction
-- commits, so the order and its items can be inserted together.
CREATE OR REPLACE FUNCTION orders_require_items() RETURNS trigger AS $$
BEGIN
  IF NEW.type = 'material_order' AND NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = NEW.id) THEN
    RAISE EXCEPTION 'Zamówienie materiału musi mieć co najmniej jedną pozycję.';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_require_items ON orders;
CREATE CONSTRAINT TRIGGER orders_require_items AFTER INSERT ON orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE PROCEDURE orders_require_items();

-- Items: only on material orders, name/unit taken from the catalog.
CREATE OR REPLACE FUNCTION order_items_before_write() RETURNS trigger AS $$
DECLARE
  c RECORD;
BEGIN
  IF (SELECT type FROM orders WHERE id = NEW.order_id) <> 'material_order' THEN
    RAISE EXCEPTION 'Pozycje można dodać tylko do zamówienia materiału.';
  END IF;
  SELECT item_name, unit INTO c FROM sm_catalog WHERE item_no = NEW.item_no;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nieznany item % - nie ma go w katalogu materiałów.', NEW.item_no;
  END IF;
  NEW.item_name := c.item_name;
  NEW.unit := c.unit;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS order_items_before_write ON order_items;
CREATE TRIGGER order_items_before_write BEFORE INSERT OR UPDATE ON order_items
  FOR EACH ROW EXECUTE PROCEDURE order_items_before_write();
