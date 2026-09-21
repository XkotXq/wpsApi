import { pool } from "./db.js";
import { newId } from "./id.js";
import { ApiError } from "./errors.js";
import { assertValidReceiptItem } from "./smItemValidation.js";

// Historia operacji SM - append-only log backing SmMaterialsHistoryTable,
// written by SmMaterialsPanel's logOperation. See schema.sql's
// sm_operations comment.
const HISTORY_LIMIT = 500;
const OPERATIONS = ["receipt", "issue", "labeling"];

// The user's text goes into a LIKE pattern - its own % and _ must match literally.
function escapeLike(text) {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function rowToApi(row) {
  return {
    id: row.id,
    operation: row.operation,
    itemNo: row.item_no,
    itemName: row.item_name,
    unitId: row.unit_id,
    quantity: row.quantity,
    location: row.location_code,
    productBatch: row.product_batch,
    operator: row.performed_by,
    time: row.performed_at,
  };
}

// Page size is still capped at HISTORY_LIMIT (a client can ask for fewer,
// never more), but this is now one page of a paginated list rather than a
// hard "last 500, the rest is unreachable" cutoff - see routes/smOperations.js
// and SmMaterialsHistoryTable.js's own page state. `total` lets the client
// know whether a next page actually exists without a second round-trip.
//
// `filter` (all optional, combined with AND):
//   operator      exactly this employee number (smpda's "my issues"/"my labelings")
//   operatorLike  the text anywhere in the employee number (wps's search box)
//   itemNo        the text anywhere in the item number
//   operation     one kind: receipt | issue | labeling
export async function listSmOperations(limit, offset, filter = {}) {
  const capped = Math.min(Number(limit) || HISTORY_LIMIT, HISTORY_LIMIT);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const conditions = [];
  const params = [];
  const operator = String(filter.operator ?? "").trim();
  if (operator) {
    params.push(operator);
    conditions.push(`performed_by = $${params.length}`);
  }
  const operatorLike = String(filter.operatorLike ?? "").trim();
  if (operatorLike) {
    params.push(`%${escapeLike(operatorLike)}%`);
    conditions.push(`performed_by ILIKE $${params.length}`);
  }
  const itemNo = String(filter.itemNo ?? "").trim();
  if (itemNo) {
    params.push(`%${escapeLike(itemNo)}%`);
    conditions.push(`item_no ILIKE $${params.length}`);
  }
  if (OPERATIONS.includes(filter.operation)) {
    params.push(filter.operation);
    conditions.push(`operation = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const [{ rows }, { rows: countRows }] = await Promise.all([
    // A whole bulk receive/issue inserts several rows in one transaction
    // with the same now() - `id` (a UUID, not chronological, but stable)
    // is only here to break that tie deterministically, so two paginated
    // queries never disagree on where one page ends and the next begins.
    pool.query(
      `SELECT * FROM sm_operations ${where} ORDER BY performed_at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, capped, safeOffset]
    ),
    pool.query(`SELECT count(*)::int AS total FROM sm_operations ${where}`, params),
  ]);
  return { rows: rows.map(rowToApi), total: countRows[0].total };
}

// One item's full operation history, oldest first - powers the "Stan w
// czasie" chart on Lista materiałów SM (see SmMaterialStockChart.js). Not
// paginated/capped like listSmOperations above - one item's own history is
// always a small slice of the whole log, so there's no need for a limit
// here the way there is for the global, cross-item list.
export async function listSmOperationsForItem(itemNo) {
  const { rows } = await pool.query(
    "SELECT * FROM sm_operations WHERE item_no = $1 ORDER BY performed_at ASC, id ASC",
    [itemNo]
  );
  return rows.map(rowToApi);
}

// entries: array of { operation, itemNo, itemName, unitId?, quantity,
// location, productBatch?, operator }, same shape logOperation already
// builds client-side - inserted as one batch per call (a bulk issue/
// receive logs several units at once).
export async function createSmOperations(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new ApiError('Wymagana niepusta tablica "entries".', 400);
  // Defense in depth: the client already skips a zero/blank quantity
  // before ever calling this (see SmMaterialsPanel's BulkIssuePanel), but
  // a "moved 0" row is never a real event no matter which caller sends
  // it - drop it here too rather than logging noise into sm_operations.
  const toInsert = entries.filter((entry) => Number(entry.quantity) > 0);
  if (!toInsert.length) return [];

  // Same backstop as upsertSmItem (src/smItems.js) - only for "receipt"
  // entries, since issue/labeling reference an item that's already on the
  // shelf (and so already went through this check on its own receipt).
  for (const entry of toInsert) {
    const operation = OPERATIONS.includes(entry.operation) ? entry.operation : "receipt";
    if (operation === "receipt") {
      await assertValidReceiptItem(String(entry.itemNo ?? "").trim(), String(entry.itemName ?? "").trim());
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const created = [];
    for (const entry of toInsert) {
      const operation = OPERATIONS.includes(entry.operation) ? entry.operation : "receipt";
      const id = newId();
      const { rows } = await client.query(
        `INSERT INTO sm_operations (id, operation, item_no, item_name, unit_id, quantity, location_code, product_batch, performed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [
          id,
          operation,
          String(entry.itemNo ?? "").trim(),
          String(entry.itemName ?? "").trim(),
          String(entry.unitId ?? "").trim(),
          String(entry.quantity ?? "").trim(),
          String(entry.location ?? "").trim(),
          String(entry.productBatch ?? "").trim(),
          entry.operator ? String(entry.operator).trim() : null,
        ]
      );
      created.push(rows[0]);
    }
    await client.query("COMMIT");
    return created.map(rowToApi);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
