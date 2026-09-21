import { pool } from "./db.js";
import { newId } from "./id.js";
import { ApiError } from "./errors.js";

// FRP spool labeling (smpda's "FRP" module): FRP that was received without a
// spool number sits in sm_items.pending_quantity; labeling turns a piece of
// it into a numbered sm_units row. This file owns
//   - the spool-number series (which numbers get handed out, in what order),
//   - the list of FRP still waiting for a number,
//   - the labeling itself, atomically.
// See schema.sql's sm_settings for where the series config lives.

const SERIES_KEY = "spoolSeries";

// Y001..Y999, then Z001..Z999 - overridable through PUT /sm-spools/settings.
export const DEFAULT_SERIES = [
  { prefix: "Y", digits: 3, from: 1, to: 999 },
  { prefix: "Z", digits: 3, from: 1, to: 999 },
];

function assertValidSeries(series) {
  if (!Array.isArray(series) || !series.length || series.length > 20) {
    throw new ApiError("Podaj od 1 do 20 zakresów numeracji.", 400);
  }
  return series.map((raw, index) => {
    const prefix = String(raw?.prefix ?? "").trim().toUpperCase();
    const digits = Number(raw?.digits);
    const from = Number(raw?.from);
    const to = Number(raw?.to);
    const label = `Zakres ${index + 1}`;
    if (!/^[A-Z0-9]{1,5}$/.test(prefix)) throw new ApiError(`${label}: prefiks to 1-5 liter lub cyfr.`, 400);
    if (!Number.isInteger(digits) || digits < 1 || digits > 8) throw new ApiError(`${label}: liczba cyfr od 1 do 8.`, 400);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
      throw new ApiError(`${label}: podaj poprawny zakres numerów (od ≤ do).`, 400);
    }
    if (to > 10 ** digits - 1) throw new ApiError(`${label}: "do" nie mieści się w ${digits} cyfrach.`, 400);
    return { prefix, digits, from, to };
  });
}

export async function getSpoolSeries(db = pool) {
  const { rows } = await db.query("SELECT value FROM sm_settings WHERE key = $1", [SERIES_KEY]);
  return rows.length ? rows[0].value : DEFAULT_SERIES;
}

export async function setSpoolSeries(series) {
  const valid = assertValidSeries(series);
  await pool.query(
    `INSERT INTO sm_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [SERIES_KEY, JSON.stringify(valid)]
  );
  return valid;
}

function formatNumber(series, n) {
  return `${series.prefix}${String(n).padStart(series.digits, "0")}`;
}

// Every spool number ever in use: old FRP-app drums, spools currently in
// Materiały SM, and any number that ever appeared in the SM history (an
// issued spool leaves sm_units but its number must never be handed out again).
async function loadUsedNumbers(db) {
  const { rows } = await db.query(
    `SELECT drum_number AS n FROM drums
     UNION SELECT unit_id FROM sm_units
     UNION SELECT unit_id FROM sm_operations WHERE unit_id <> ''`
  );
  return new Set(rows.map((r) => String(r.n ?? "").trim().toUpperCase()));
}

// The next number: in the first series that isn't used up, one above the
// highest number already used in that series - it never fills gaps, since a
// gap can be a physical spool that's simply not in the system. A series with
// nothing used yet starts at its `from`. All series used up -> 409.
export async function nextSpoolNumber(db = pool) {
  const [series, used] = await Promise.all([getSpoolSeries(db), loadUsedNumbers(db)]);
  for (const s of series) {
    const pattern = new RegExp(`^${s.prefix}(\\d{${s.digits}})$`);
    let highest = s.from - 1;
    for (const number of used) {
      const match = pattern.exec(number);
      if (match) highest = Math.max(highest, Number(match[1]));
    }
    if (highest + 1 <= s.to) return formatNumber(s, highest + 1);
  }
  throw new ApiError("Wyczerpano wszystkie zakresy numeracji szpul - dodaj kolejny w ustawieniach.", 409);
}

function parseQuantity(value) {
  const n = Number(String(value ?? "").trim().replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

// Same formatting rule as wps's/smpda's formatQuantity: whole numbers without
// a decimal point, everything else with 3 decimals.
function formatQuantity(n) {
  return n % 1 === 0 ? String(Math.trunc(n)) : n.toFixed(3);
}

// FRP (by sm_catalog.category) that has quantity without a spool number.
export async function listUnlabeledFrp() {
  const { rows } = await pool.query(
    `SELECT i.item_no, i.item_name, i.location_code, i.pending_quantity
     FROM sm_items i
     JOIN sm_catalog c ON c.item_no = i.item_no
     WHERE lower(c.category) = 'frp' AND i.pending_quantity <> ''
     ORDER BY i.item_name ASC`
  );
  return rows
    .filter((r) => parseQuantity(r.pending_quantity) > 0)
    .map((r) => ({ itemNo: r.item_no, itemName: r.item_name, locationCode: r.location_code, pendingQuantity: r.pending_quantity }));
}

// Turns `quantity` of an item's unnumbered stock into one numbered spool, in
// one transaction: the number is checked/issued under a lock (two PDAs can't
// get the same one), the unit is added, pending shrinks and a "labeling"
// operation is logged. `unitId` is what the PDA showed the operator (they may
// already have written it on the spool) - if it's been taken meanwhile this
// throws 409 with the number to use instead, rather than silently changing it.
export async function labelSpool({ itemNo, quantity, unitId, productBatch, operator }) {
  const trimmedItemNo = String(itemNo ?? "").trim();
  const qty = parseQuantity(quantity);
  if (!trimmedItemNo) throw new ApiError("Podaj numer itemu.", 400);
  if (!(qty > 0)) throw new ApiError("Podaj długość większą od zera.", 400);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // One labeling at a time, so "next number" can't be issued twice.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('sm_spool_numbers'))");

    const { rows: items } = await client.query("SELECT * FROM sm_items WHERE item_no = $1 FOR UPDATE", [trimmedItemNo]);
    if (!items.length) throw new ApiError("Nie ma takiego materiału na stanie.", 404);
    const item = items[0];
    const pending = parseQuantity(item.pending_quantity) || 0;
    if (!item.tracked_individually || pending <= 0) {
      throw new ApiError("Ten materiał nie ma ilości bez numeru szpuli.", 409);
    }
    if (qty > pending + 1e-9) {
      throw new ApiError(`Do oznaczenia zostało tylko ${formatQuantity(pending)}.`, 409);
    }

    const requested = String(unitId ?? "").trim().toUpperCase();
    let number;
    if (requested) {
      const used = await loadUsedNumbers(client);
      if (used.has(requested)) {
        const err = new ApiError(`Numer ${requested} jest już zajęty.`, 409);
        err.next = await nextSpoolNumber(client);
        throw err;
      }
      number = requested;
    } else {
      number = await nextSpoolNumber(client);
    }

    const batch = String(productBatch ?? "").trim();
    const { rows: positions } = await client.query("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM sm_units WHERE item_no = $1", [trimmedItemNo]);
    const unit = { id: newId(), unitId: number, quantity: formatQuantity(qty), productBatch: batch };
    await client.query(
      `INSERT INTO sm_units (id, item_no, unit_id, quantity, product_batch, note, cip_status, position)
       VALUES ($1, $2, $3, $4, $5, '-', 'match', $6)`,
      [unit.id, trimmedItemNo, unit.unitId, unit.quantity, batch, positions[0].p]
    );

    const remaining = pending - qty;
    await client.query("UPDATE sm_items SET pending_quantity = $2, updated_at = now() WHERE item_no = $1", [
      trimmedItemNo,
      remaining > 1e-9 ? formatQuantity(remaining) : "",
    ]);

    await client.query(
      `INSERT INTO sm_operations (id, operation, item_no, item_name, unit_id, quantity, location_code, product_batch, performed_by)
       VALUES ($1, 'labeling', $2, $3, $4, $5, $6, $7, $8)`,
      [newId(), trimmedItemNo, item.item_name, unit.unitId, unit.quantity, item.location_code, batch, operator ? String(operator).trim() : null]
    );

    await client.query("COMMIT");
    return { unitId: unit.unitId, quantity: unit.quantity, productBatch: batch, itemNo: trimmedItemNo, itemName: item.item_name };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
