import { pool } from "./db.js";
import { newId } from "./id.js";
import { ApiError } from "./errors.js";
import { getMaterial, MATERIAL_KEYS } from "./materials.js";

async function safeRollback(client) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // connection already broken - nothing more we can do here
  }
}

// Maps a *_stock snapshot row to the shape frontends expect from a
// check-history entry - both the old frp app's generateBalance()
// (.drumNumber/.itemNumber/.name/.length) and wps's mapFrpItem/
// mapCoatedFrpItem/mapFillerItem (materials-data.js), which additionally
// read .id/.frpLabel/.type/.location/.remark for the Stock/Previous
// Stocks tables - hence the frp branch needing label/type/mmc joined in
// from frp_catalog (see the itemsSql queries below and in stocks.js).
export function stockRowToSnapshotApi(materialKey, row) {
  if (materialKey === "frp") {
    return {
      id: row.id,
      drumNumber: row.drum_number,
      itemNumber: row.frp_item_number,
      frpNumber: row.frp_item_number,
      name: row.__catalog_name ?? "",
      frpLabel: row.__catalog_label ?? "",
      type: row.__catalog_type ?? "XB",
      mmc: Boolean(row.__catalog_mmc),
      length: row.length,
      location: row.location,
      remark: row.remark,
    };
  }
  if (materialKey === "coatedFrp") {
    return {
      id: row.id,
      drumNumber: row.drum_number,
      diameter: row.diameter,
      type: row.type,
      length: row.length,
      location: row.location,
      remark: row.remark,
    };
  }
  return {
    id: row.id,
    drumNumber: row.drum_number,
    diameter: row.diameter,
    color: row.color,
    isincendiary: Boolean(row.flameproof),
    length: row.length,
    location: row.location,
    remark: row.remark,
  };
}

// frp_stock only freezes frp_item_number - label/type/mmc are resolved
// from the catalog at read time (see schema.sql), same as frp_current.
export const FRP_STOCK_ITEMS_SQL =
  `SELECT s.*, c.name AS __catalog_name, c.label AS __catalog_label, c.type AS __catalog_type, c.mmc AS __catalog_mmc ` +
  `FROM frp_stock s LEFT JOIN frp_catalog c ON c.item_number = s.frp_item_number WHERE s.version_id = $1`;

// History of finished stock-takes for a material (oldest first), used to
// compute a period-over-period balance/diff - mirrors the existing
// frpStockHistory feature (currently kept in localStorage).
export async function listChecks(materialKey, limit) {
  const material = getMaterial(materialKey);
  if (!material) throw new ApiError("Nieznany materiał.", 404);
  const capped = Math.min(Number(limit) || 5, 50);

  const { rows: versions } = await pool.query(
    "SELECT * FROM stock_versions WHERE material_key = $1 ORDER BY performed_at DESC LIMIT $2",
    [materialKey, capped]
  );

  const results = [];
  for (const v of versions.reverse()) {
    const itemsSql = materialKey === "frp" ? FRP_STOCK_ITEMS_SQL : `SELECT * FROM ${material.stockTable} WHERE version_id = $1`;
    const { rows: items } = await pool.query(itemsSql, [v.id]);
    results.push({
      id: v.id,
      performedBy: v.performed_by,
      performedAt: v.performed_at,
      items: items.map((row) => stockRowToSnapshotApi(materialKey, row)),
      yesCount: v.yes_count,
      noCount: v.no_count,
    });
  }
  return results;
}

export async function getStatus(materialKey) {
  const { rows } = await pool.query("SELECT * FROM stock_status WHERE material = $1", [materialKey]);
  const status = rows[0];
  return { completed: Boolean(status?.completed), updatedAt: status?.updated_at ?? null, updatedBy: status?.updated_by ?? null };
}

async function insertStockSnapshotRow(client, materialKey, versionId, drumId, drumNumber, item) {
  const id = newId();
  if (materialKey === "frp") {
    await client.query(
      `INSERT INTO frp_stock (id, version_id, frp_item_number, drum_id, drum_number, length, location, remark)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        versionId,
        String(item.itemNumber ?? item.frpItemNumber ?? item.frpNumber ?? ""),
        drumId,
        drumNumber,
        String(item.length ?? ""),
        String(item.location ?? ""),
        String(item.remark ?? ""),
      ]
    );
  } else if (materialKey === "coatedFrp") {
    await client.query(
      `INSERT INTO coated_frp_stock (id, version_id, drum_id, drum_number, diameter, type, length, location, remark)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, versionId, drumId, drumNumber, String(item.diameter ?? ""), String(item.type ?? "XB"), String(item.length ?? ""), String(item.location ?? ""), String(item.remark ?? "")]
    );
  } else {
    await client.query(
      `INSERT INTO filler_stock (id, version_id, drum_id, drum_number, diameter, length, color, flameproof, location, remark)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        versionId,
        drumId,
        drumNumber,
        String(item.diameter ?? ""),
        String(item.length ?? ""),
        String(item.color ?? "GRAY"),
        Boolean(item.isincendiary ?? item.flameproof),
        String(item.location ?? ""),
        String(item.remark ?? ""),
      ]
    );
  }
}

const STOCKS_VERSION_COLUMN = { frp: "frp_version_id", coatedFrp: "coated_frp_version_id", filler: "filler_version_id" };

// Starts a brand-new "stocks" round containing just this version, carrying
// forward the latest existing version for the other two materials so
// every stocks row always covers all three categories - see the "Tuesday
// frp+filler / Wednesday coatedFrp / Friday frp+filler" example this was
// designed against. Used when the person doing the check picks "new
// stock" instead of attaching to an existing round (GET /stocks lists the
// candidates for that choice).
async function createNewStocksBundle(client, materialKey, versionId) {
  const stockId = newId();
  const columnValues = { frp: null, coatedFrp: null, filler: null };
  columnValues[materialKey] = versionId;
  for (const key of MATERIAL_KEYS) {
    if (key === materialKey) continue;
    const { rows } = await client.query("SELECT id FROM stock_versions WHERE material_key = $1 ORDER BY performed_at DESC LIMIT 1", [key]);
    columnValues[key] = rows[0]?.id ?? null;
  }
  await client.query(
    "INSERT INTO stocks (id, frp_version_id, coated_frp_version_id, filler_version_id) VALUES ($1, $2, $3, $4)",
    [stockId, columnValues.frp, columnValues.coatedFrp, columnValues.filler]
  );
  return stockId;
}

// Attaches this version to a specific, already-existing "stocks" round -
// the person doing the check chose it explicitly (see GET /stocks).
async function attachToStocksBundle(client, materialKey, versionId, stocksId) {
  const { rows } = await client.query(
    `UPDATE stocks SET ${STOCKS_VERSION_COLUMN[materialKey]} = $1, updated_at = now() WHERE id = $2 RETURNING id`,
    [versionId, stocksId]
  );
  if (!rows.length) throw new ApiError("Nie znaleziono wskazanego stocku.", 404);
  return rows[0].id;
}

// Submits the final result of a stock-take (the frontend keeps "jest/brak"
// statuses local while counting and only calls this once, at the end).
// items = the positions marked "jest" (found) - "brak" (missing) ones
// leave no item-level trace, only counted in noCount.
export async function submitCheck(materialKey, body) {
  const material = getMaterial(materialKey);
  if (!material) throw new ApiError("Nieznany materiał.", 404);
  const { items, yesCount, noCount, performedBy, stocksId } = body;
  if (!Array.isArray(items)) throw new ApiError('Wymagana tablica "items".', 400);

  const by = String(performedBy ?? "").trim() || null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const versionId = newId();
    await client.query(
      `INSERT INTO stock_versions (id, material_key, performed_by, yes_count, no_count) VALUES ($1, $2, $3, $4, $5)`,
      [versionId, materialKey, by, Number(yesCount) || 0, Number(noCount) || 0]
    );

    for (const item of items) {
      const drumNumber = String(item.drumNumber ?? "").trim();
      let drumId = null;
      if (drumNumber) {
        const { rows } = await client.query("SELECT id FROM drums WHERE drum_number = $1", [drumNumber]);
        drumId = rows[0]?.id ?? null;
      }
      await insertStockSnapshotRow(client, materialKey, versionId, drumId, drumNumber, item);
    }

    const stockId = stocksId
      ? await attachToStocksBundle(client, materialKey, versionId, stocksId)
      : await createNewStocksBundle(client, materialKey, versionId);

    await client.query(
      `INSERT INTO stock_status (material, completed, updated_at, updated_by) VALUES ($1, TRUE, now(), $2)
       ON CONFLICT (material) DO UPDATE SET completed = TRUE, updated_at = now(), updated_by = $2`,
      [materialKey, by]
    );

    await client.query("COMMIT");
    return { id: versionId, stockId };
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
}

export async function resetStatus(materialKey, performedBy) {
  const by = String(performedBy ?? "").trim() || null;
  await pool.query(
    `INSERT INTO stock_status (material, completed, updated_at, updated_by) VALUES ($1, FALSE, now(), $2)
     ON CONFLICT (material) DO UPDATE SET completed = FALSE, updated_at = now(), updated_by = $2`,
    [materialKey, by]
  );
  return { completed: false };
}
