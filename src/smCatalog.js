import { pool } from "./db.js";
import { ApiError } from "./errors.js";

// Reference catalog of every known "Materiały SM" material (item number +
// name + whether it's split into individually-tracked spools) - see
// schema.sql's sm_catalog comment and wps's lib/smMaterialsCatalog.js,
// which this backs.
function rowToApi(row) {
  return { itemNo: row.item_no, itemName: row.item_name, individualUnits: Boolean(row.individually_tracked) };
}

export async function listSmCatalog() {
  const { rows } = await pool.query("SELECT * FROM sm_catalog ORDER BY item_name ASC");
  return rows.map(rowToApi);
}

export async function createSmCatalogEntry(body) {
  const itemNo = String(body.itemNo ?? "").trim();
  const itemName = String(body.itemName ?? "").trim();
  const individualUnits = Boolean(body.individualUnits);
  if (!itemNo || !itemName) throw new ApiError("Podaj numer itemu i nazwę.", 400);

  const { rows } = await pool.query(
    `INSERT INTO sm_catalog (item_no, item_name, individually_tracked) VALUES ($1, $2, $3)
     ON CONFLICT (item_no) DO NOTHING RETURNING *`,
    [itemNo, itemName, individualUnits]
  );
  if (!rows.length) throw new ApiError("Ten numer itemu już jest w katalogu.", 409);
  return rowToApi(rows[0]);
}

export async function updateSmCatalogEntry(itemNo, body) {
  const sets = [];
  const values = [];
  let i = 1;
  if (body.itemName !== undefined) {
    sets.push(`item_name = $${i++}`);
    values.push(String(body.itemName).trim());
  }
  if (body.individualUnits !== undefined) {
    sets.push(`individually_tracked = $${i++}`);
    values.push(Boolean(body.individualUnits));
  }
  if (!sets.length) throw new ApiError("Brak pól do aktualizacji.", 400);
  sets.push("updated_at = now()");
  values.push(itemNo);

  const { rows } = await pool.query(`UPDATE sm_catalog SET ${sets.join(", ")} WHERE item_no = $${i} RETURNING *`, values);
  if (!rows.length) throw new ApiError("Nie znaleziono wpisu.", 404);
  return rowToApi(rows[0]);
}

export async function deleteSmCatalogEntry(itemNo) {
  const { rowCount } = await pool.query("DELETE FROM sm_catalog WHERE item_no = $1", [itemNo]);
  if (!rowCount) throw new ApiError("Nie znaleziono wpisu.", 404);
}
