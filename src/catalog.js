import { pool } from "./db.js";
import { ApiError } from "./errors.js";

function rowToApi(row) {
  return {
    itemNumber: row.item_number,
    name: row.name,
    label: row.label,
    type: row.type,
    mmc: Boolean(row.mmc),
  };
}

export async function listCatalog() {
  const { rows } = await pool.query("SELECT * FROM frp_catalog ORDER BY item_number ASC");
  return rows.map(rowToApi);
}

export async function createCatalogEntry(body) {
  const itemNumber = String(body?.itemNumber ?? "").trim();
  if (!itemNumber) throw new ApiError('Pole "itemNumber" jest wymagane.', 400);
  const { rows } = await pool.query(
    `INSERT INTO frp_catalog (item_number, name, label, type, mmc) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [
      itemNumber,
      String(body.name ?? "").trim(),
      String(body.label ?? "").trim(),
      ["XB", "Z"].includes(body.type) ? body.type : "XB",
      Boolean(body.mmc),
    ]
  );
  return rowToApi(rows[0]);
}

// Supports renaming the primary key itself (item_number) — frp_current
// rows referencing it follow along via ON UPDATE CASCADE.
export async function updateCatalogEntry(itemNumber, body) {
  const sets = [];
  const values = [];
  let i = 1;

  if (body.itemNumber !== undefined) {
    const next = String(body.itemNumber ?? "").trim();
    if (!next) throw new ApiError('Pole "itemNumber" nie może być puste.', 400);
    sets.push(`item_number = $${i++}`);
    values.push(next);
  }
  if (body.name !== undefined) {
    sets.push(`name = $${i++}`);
    values.push(String(body.name ?? "").trim());
  }
  if (body.label !== undefined) {
    sets.push(`label = $${i++}`);
    values.push(String(body.label ?? "").trim());
  }
  if (body.type !== undefined) {
    sets.push(`type = $${i++}`);
    values.push(["XB", "Z"].includes(body.type) ? body.type : "XB");
  }
  if (body.mmc !== undefined) {
    sets.push(`mmc = $${i++}`);
    values.push(Boolean(body.mmc));
  }
  if (!sets.length) throw new ApiError("Brak pól do aktualizacji.", 400);
  values.push(itemNumber);

  const { rows } = await pool.query(`UPDATE frp_catalog SET ${sets.join(", ")} WHERE item_number = $${i} RETURNING *`, values);
  if (!rows.length) throw new ApiError("Nie znaleziono wpisu w bazie FRP.", 404);
  return rowToApi(rows[0]);
}

export async function deleteCatalogEntry(itemNumber) {
  const { rowCount } = await pool.query("DELETE FROM frp_catalog WHERE item_number = $1", [itemNumber]);
  if (!rowCount) throw new ApiError("Nie znaleziono wpisu w bazie FRP.", 404);
}
