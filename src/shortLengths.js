import { pool } from "./db.js";
import { ApiError } from "./errors.js";
import { photosByShortLengthIds } from "./orderPhotos.js";

// "Krótkie odcinki" - the forklift operator reporting, from inside a task,
// that what he is bringing is short lengths rather than a full drum.
//
// **A report, not a stock movement.** Nothing here touches sm_items, CIP or
// the order's own progress: a remnant was already issued from the warehouse
// once (see sm_operations.source = 'floor' for the issue side of the same
// reality). This is the record the office asked for - what was taken, how
// much, and a photo of it - so a short length reaching a line can be
// accounted for afterwards instead of being somebody's memory.
//
// Tied to an order because that is where it is reported from, and because
// "which transport was this" is the first question anybody reading the list
// will have.

function rowToApi(row, photos = []) {
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    // Carried along so the list in wps reads as "order + material" without
    // a second request per row.
    orderNo: row.order_no ?? "",
    orderTo: row.to_location ?? "",
    itemNo: row.item_no,
    itemName: row.item_name ?? "",
    // Free text on purpose: "2 odcinki po ~15 m" is a truer answer than a
    // number nobody measured, and the warehouse unit for FRP is a drum
    // count that a remnant does not fit.
    quantity: row.quantity ?? "",
    reportedBy: row.reported_by,
    createdAt: row.created_at,
    photos,
  };
}

const LIST_SQL = `
  SELECT r.*, o.order_no, o.to_location
    FROM short_length_reports r
    JOIN orders o ON o.id = r.order_id`;

/** Newest first - this is a log somebody reviews, not a queue they work. */
export async function listShortLengthReports({ limit } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const { rows } = await pool.query(`${LIST_SQL} ORDER BY r.created_at DESC LIMIT $1`, [capped]);
  const photos = await photosByShortLengthIds(rows.map((r) => r.id));
  return rows.map((row) => rowToApi(row, photos.get(String(row.id)) ?? []));
}

export async function createShortLengthReport({ orderId, itemNo, itemName, quantity, reportedBy }) {
  const by = String(reportedBy ?? "").trim();
  if (!by) throw new ApiError("Brak numeru pracownika - zaloguj się ponownie.", 400);
  const item = String(itemNo ?? "").trim();
  if (!item) throw new ApiError("Wybierz materiał.", 400);

  const { rows: order } = await pool.query("SELECT id FROM orders WHERE id = $1", [orderId]);
  if (!order.length) throw new ApiError("Nie znaleziono zamówienia.", 404);

  // The name comes from the order's own line when it is there, so the list
  // in wps never shows a bare number for a material the order already
  // named. Falls back to whatever the caller sent.
  const { rows: line } = await pool.query(
    "SELECT item_name FROM order_items WHERE order_id = $1 AND item_no = $2 LIMIT 1",
    [orderId, item]
  );

  const { rows: created } = await pool.query(
    `INSERT INTO short_length_reports (order_id, item_no, item_name, quantity, reported_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orderId, item, line[0]?.item_name ?? String(itemName ?? "").trim(), String(quantity ?? "").trim(), by]
  );

  const { rows } = await pool.query(`${LIST_SQL} WHERE r.id = $1`, [created[0].id]);
  return rowToApi(rows[0]);
}

export async function getShortLengthReport(id) {
  const { rows } = await pool.query(`${LIST_SQL} WHERE r.id = $1`, [id]);
  if (!rows.length) throw new ApiError("Nie znaleziono zgłoszenia.", 404);
  const photos = await photosByShortLengthIds([rows[0].id]);
  return rowToApi(rows[0], photos.get(String(rows[0].id)) ?? []);
}
