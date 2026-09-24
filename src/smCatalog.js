import { pool } from "./db.js";
import { ApiError } from "./errors.js";

// Reference catalog of every known "Materiały SM" material (category, item
// number, name, unit, remark + whether it's split into individually-tracked
// spools) - see
// schema.sql's sm_catalog comment and wps's lib/smMaterialsCatalog.js,
// which this backs.
function rowToApi(row) {
  return {
    category: row.category,
    itemNo: row.item_no,
    itemName: row.item_name,
    unit: row.unit,
    remark: row.remark,
    individualUnits: Boolean(row.individually_tracked),
  };
}

// The optional free-text columns - the API field name and its column are the same.
const TEXT_FIELDS = ["category", "unit", "remark"];

// Same rule AGENTS.md documents for wps/smpda deciding trackedIndividually:
// a plain "FRP..." item is issued as individual spools, but a "Coated
// FRP..." one (still filed under the "FRP" category in the source
// spreadsheet - the two aren't split into separate categories there)
// or anything else is issued in aggregate. Used only to seed a *new*
// catalog row's individually_tracked on import - see importSmCatalogEntries.
function defaultIndividualUnits(category, itemName) {
  if (String(category ?? "").trim().toLowerCase() !== "frp") return false;
  return !/^coated\b/i.test(String(itemName ?? "").trim());
}

export async function listSmCatalog() {
  const { rows } = await pool.query("SELECT * FROM sm_catalog ORDER BY item_name ASC");
  return rows.map(rowToApi);
}

// One entry, straight from the database - for a caller that needs this
// item's current category/individualUnits right now (e.g. wps's
// ReceiveUnitPanel resolving what to receive) rather than whatever a
// catalog list fetched earlier in the page's lifetime still holds.
export async function getSmCatalogEntry(itemNo) {
  const { rows } = await pool.query("SELECT * FROM sm_catalog WHERE item_no = $1", [String(itemNo ?? "").trim()]);
  return rows.length ? rowToApi(rows[0]) : null;
}

export async function createSmCatalogEntry(body) {
  const itemNo = String(body.itemNo ?? "").trim();
  const itemName = String(body.itemName ?? "").trim();
  const individualUnits = Boolean(body.individualUnits);
  if (!itemNo || !itemName) throw new ApiError("Podaj numer itemu i nazwę.", 400);

  const { rows } = await pool.query(
    `INSERT INTO sm_catalog (item_no, item_name, individually_tracked, category, unit, remark)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (item_no) DO NOTHING RETURNING *`,
    [itemNo, itemName, individualUnits, ...TEXT_FIELDS.map((field) => String(body[field] ?? "").trim())]
  );
  if (!rows.length) throw new ApiError("Ten numer itemu już jest w katalogu.", 409);
  return rowToApi(rows[0]);
}

// Bulk upsert for the wps catalog import (a whole spreadsheet at once): a new
// item number is inserted, an existing one gets category/name/unit/remark
// overwritten. individually_tracked is left alone on update (an operator may
// have corrected it by hand since) but defaulted from category/name on
// insert - see defaultIndividualUnits - rather than always off, so a
// freshly-imported plain FRP item offers spool tracking without a manual
// edit per row afterwards. Rows without item number or name are counted as
// failed rather than aborting the rest. One transaction, so a database error
// leaves the catalog untouched.
export async function importSmCatalogEntries(entries) {
  if (!Array.isArray(entries)) throw new ApiError("Nieprawidłowe dane.", 400);
  const client = await pool.connect();
  let created = 0;
  let updated = 0;
  const failed = [];
  try {
    await client.query("BEGIN");
    for (const entry of entries) {
      const itemNo = String(entry?.itemNo ?? "").trim();
      const itemName = String(entry?.itemName ?? "").trim();
      if (!itemNo || !itemName) {
        failed.push(itemNo);
        continue;
      }
      const category = String(entry.category ?? "").trim();
      const { rows } = await client.query(
        `INSERT INTO sm_catalog (item_no, item_name, category, unit, remark, individually_tracked)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (item_no) DO UPDATE SET
           item_name = EXCLUDED.item_name, category = EXCLUDED.category, unit = EXCLUDED.unit,
           remark = EXCLUDED.remark, updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [itemNo, itemName, category, String(entry.unit ?? "").trim(), String(entry.remark ?? "").trim(), defaultIndividualUnits(category, itemName)]
      );
      if (rows[0].inserted) created += 1;
      else updated += 1;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return { created, updated, failed };
}

export async function updateSmCatalogEntry(itemNo, body) {
  const sets = [];
  const values = [];
  let i = 1;
  if (body.itemName !== undefined) {
    sets.push(`item_name = $${i++}`);
    values.push(String(body.itemName).trim());
  }
  for (const field of TEXT_FIELDS) {
    if (body[field] === undefined) continue;
    sets.push(`${field} = $${i++}`);
    values.push(String(body[field]).trim());
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

// Sets one unit of measure on every entry of a category at once (the catalog
// page's "Jednostki kategorii") instead of editing each item on its own.
// `category` is matched exactly; an empty one means the entries that have
// no category. Returns how many entries changed.
export async function setSmCatalogCategoryUnit(category, unit) {
  const trimmedUnit = String(unit ?? "").trim();
  if (!trimmedUnit) throw new ApiError("Podaj jednostkę.", 400);
  const { rowCount } = await pool.query(
    "UPDATE sm_catalog SET unit = $1, updated_at = now() WHERE category = $2",
    [trimmedUnit, String(category ?? "").trim()]
  );
  return { updated: rowCount };
}

export async function deleteSmCatalogEntry(itemNo) {
  const { rowCount } = await pool.query("DELETE FROM sm_catalog WHERE item_no = $1", [itemNo]);
  if (!rowCount) throw new ApiError("Nie znaleziono wpisu.", 404);
}
