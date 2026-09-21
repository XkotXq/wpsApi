import { pool } from "./db.js";
import { newId } from "./id.js";
import { ApiError } from "./errors.js";
import { assertValidReceiptItem } from "./smItemValidation.js";

// Materiały SM current stock - see schema.sql's sm_items/sm_units
// comments. Whole-item upsert (not field-by-field PATCH): the frontend
// already computes the next full item state for every mutation kind
// (receive/issue/assign/edit) via its own reducers, so this just persists
// whatever it sends - replacing that item's units wholesale is simpler
// and safer than trying to diff individual units server-side too.

function rowToApi(item, units) {
  const base = {
    itemNo: item.item_no,
    itemName: item.item_name,
    locationCode: item.location_code,
    note: item.note,
    trackedIndividually: item.tracked_individually,
  };
  if (!item.tracked_individually) {
    return { ...base, totalQuantity: item.total_quantity };
  }
  const out = {
    ...base,
    units: units.map((u) => ({ id: u.id, unitId: u.unit_id, quantity: u.quantity, productBatch: u.product_batch, note: u.note, cipStatus: u.cip_status })),
  };
  if (item.pending_quantity) out.pendingQuantity = item.pending_quantity;
  return out;
}

export async function listSmItems() {
  const { rows: items } = await pool.query("SELECT * FROM sm_items ORDER BY created_at DESC");
  const { rows: units } = await pool.query("SELECT * FROM sm_units ORDER BY position ASC, created_at ASC");
  const unitsByItem = new Map();
  for (const u of units) {
    if (!unitsByItem.has(u.item_no)) unitsByItem.set(u.item_no, []);
    unitsByItem.get(u.item_no).push(u);
  }
  return items.map((item) => rowToApi(item, unitsByItem.get(item.item_no) ?? []));
}

// One item with its units, or null - what the PDA reads right after a scan
// so the stock it shows is the database's, not a list fetched earlier.
export async function getSmItem(itemNo) {
  const { rows: items } = await pool.query("SELECT * FROM sm_items WHERE item_no = $1", [itemNo.trim()]);
  if (!items.length) return null;
  const { rows: units } = await pool.query("SELECT * FROM sm_units WHERE item_no = $1 ORDER BY position ASC, created_at ASC", [items[0].item_no]);
  return rowToApi(items[0], units);
}

export async function upsertSmItem(itemNo, body) {
  if (!body || typeof body !== "object") throw new ApiError("Nieprawidłowe dane.", 400);
  const trimmedItemNo = itemNo.trim();
  const itemName = String(body.itemName ?? "").trim();
  const locationCode = String(body.locationCode ?? "").trim();
  const note = String(body.note ?? "-").trim() || "-";
  const trackedIndividually = Boolean(body.trackedIndividually);
  if (!trimmedItemNo || !itemName) throw new ApiError("Uzupełnij numer itemu i nazwę.", 400);
  await assertValidReceiptItem(trimmedItemNo, itemName);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO sm_items (item_no, item_name, location_code, note, tracked_individually, total_quantity, pending_quantity)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (item_no) DO UPDATE SET
         item_name = EXCLUDED.item_name, location_code = EXCLUDED.location_code, note = EXCLUDED.note,
         tracked_individually = EXCLUDED.tracked_individually, total_quantity = EXCLUDED.total_quantity,
         pending_quantity = EXCLUDED.pending_quantity, updated_at = now()`,
      [
        trimmedItemNo,
        itemName,
        locationCode,
        note,
        trackedIndividually,
        trackedIndividually ? "" : String(body.totalQuantity ?? "").trim(),
        trackedIndividually ? String(body.pendingQuantity ?? "").trim() : "",
      ]
    );

    // Whole-array replace: delete every existing unit for this item, then
    // reinsert whatever the caller sent (empty for an aggregate item).
    await client.query("DELETE FROM sm_units WHERE item_no = $1", [trimmedItemNo]);
    const units = trackedIndividually && Array.isArray(body.units) ? body.units : [];
    let position = 0;
    for (const unit of units) {
      await client.query(
        `INSERT INTO sm_units (id, item_no, unit_id, quantity, product_batch, note, cip_status, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          String(unit.id ?? "").trim() || newId(),
          trimmedItemNo,
          String(unit.unitId ?? "").trim(),
          String(unit.quantity ?? "").trim(),
          String(unit.productBatch ?? "").trim(),
          String(unit.note ?? "-").trim() || "-",
          unit.cipStatus === "mismatch" ? "mismatch" : "match",
          position++,
        ]
      );
    }

    const { rows: itemRows } = await client.query("SELECT * FROM sm_items WHERE item_no = $1", [trimmedItemNo]);
    const { rows: unitRows } = await client.query("SELECT * FROM sm_units WHERE item_no = $1 ORDER BY position ASC", [trimmedItemNo]);
    await client.query("COMMIT");
    return rowToApi(itemRows[0], unitRows);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteSmItem(itemNo) {
  const { rowCount } = await pool.query("DELETE FROM sm_items WHERE item_no = $1", [itemNo]);
  if (!rowCount) throw new ApiError("Nie znaleziono wpisu.", 404);
}
