import { pool } from "./db.js";
import { ApiError } from "./errors.js";

function rowToApi(row) {
  return { number: row.item_number, label: row.label, name: row.name, type: row.type, mmc: Boolean(row.mmc) };
}

export async function listCatalog() {
  const { rows } = await pool.query("SELECT * FROM frp_catalog ORDER BY name ASC");
  return rows.map(rowToApi);
}

export async function createCatalogEntry(body) {
  const number = String(body.number ?? "").replace(/\D/g, "");
  const label = String(body.label ?? "").trim();
  const name = String(body.name ?? "").trim();
  const type = ["XB", "Z"].includes(body.type) ? body.type : "XB";
  const mmc = Boolean(body.mmc);
  if (!number || !label || !name) throw new ApiError("Uzupełnij wszystkie pola.", 400);

  const { rows } = await pool.query(
    `INSERT INTO frp_catalog (item_number, label, name, type, mmc) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (item_number) DO NOTHING RETURNING *`,
    [number, label, name, type, mmc]
  );
  if (!rows.length) throw new ApiError("Ten numer FRP już istnieje w bazie.", 409);
  return rowToApi(rows[0]);
}

export async function updateCatalogEntry(number, body) {
  const sets = [];
  const values = [];
  let i = 1;
  // The item number is the primary key but users can still edit it (it's
  // a free-text field in the admin form) - allow changing it here too,
  // rather than silently ignoring edits to that field.
  if (body.number !== undefined) {
    const newNumber = String(body.number).replace(/\D/g, "");
    if (!newNumber) throw new ApiError("Nieprawidłowy numer itemu.", 400);
    sets.push(`item_number = $${i++}`);
    values.push(newNumber);
  }
  if (body.label !== undefined) {
    sets.push(`label = $${i++}`);
    values.push(String(body.label).trim());
  }
  if (body.name !== undefined) {
    sets.push(`name = $${i++}`);
    values.push(String(body.name).trim());
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
  values.push(number);

  let rows;
  try {
    ({ rows } = await pool.query(`UPDATE frp_catalog SET ${sets.join(", ")} WHERE item_number = $${i} RETURNING *`, values));
  } catch (err) {
    if (err.code === "23505") throw new ApiError("Ten numer FRP już istnieje w bazie.", 409);
    throw err;
  }
  if (!rows.length) throw new ApiError("Nie znaleziono wpisu.", 404);
  return rowToApi(rows[0]);
}

export async function deleteCatalogEntry(number) {
  const { rowCount } = await pool.query("DELETE FROM frp_catalog WHERE item_number = $1", [number]);
  if (!rowCount) throw new ApiError("Nie znaleziono wpisu.", 404);
}
