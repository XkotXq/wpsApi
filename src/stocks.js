import { pool } from "./db.js";
import { ApiError } from "./errors.js";
import { getMaterial, MATERIAL_KEYS } from "./materials.js";
import { stockRowToSnapshotApi, FRP_STOCK_ITEMS_SQL } from "./checks.js";

const VERSION_COLUMN = { frp: "frp_version_id", coatedFrp: "coated_frp_version_id", filler: "filler_version_id" };

async function loadVersionsById(rows) {
  const versionIds = rows.flatMap((row) => MATERIAL_KEYS.map((key) => row[VERSION_COLUMN[key]])).filter(Boolean);
  const versionsById = new Map();
  if (versionIds.length) {
    const { rows: versions } = await pool.query("SELECT * FROM stock_versions WHERE id = ANY($1)", [versionIds]);
    for (const v of versions) versionsById.set(v.id, v);
  }
  return versionsById;
}

function rowToApi(row, versionsById) {
  const out = { id: row.id, performedAt: row.performed_at };
  for (const key of MATERIAL_KEYS) {
    const versionId = row[VERSION_COLUMN[key]];
    const version = versionId ? versionsById.get(versionId) : null;
    out[key] = version
      ? {
          versionId: version.id,
          performedAt: version.performed_at,
          performedBy: version.performed_by,
          yesCount: version.yes_count,
          noCount: version.no_count,
        }
      : null;
  }
  return out;
}

// "stocks" rounds (bundles) - used by the checking UI to let the person
// pick which round to attach a just-finished material check to, and by
// the Stock dashboard page to show the latest complete picture across
// all 3 materials even when they weren't all checked on the same day.
export async function listStocksBundles(limit) {
  const capped = Math.min(Number(limit) || 20, 100);
  const { rows } = await pool.query("SELECT * FROM stocks ORDER BY performed_at DESC LIMIT $1", [capped]);
  const versionsById = await loadVersionsById(rows);
  return rows.map((row) => rowToApi(row, versionsById));
}

export async function getStocksBundle(id) {
  const { rows } = await pool.query("SELECT * FROM stocks WHERE id = $1", [id]);
  if (!rows.length) throw new ApiError("Nie znaleziono stocku.", 404);
  const versionsById = await loadVersionsById(rows);
  return rowToApi(rows[0], versionsById);
}

const TREND_QUERIES = {
  // frp_stock only freezes the item number - label/name/mmc are resolved
  // from the catalog, and mmc doubles as the split dimension (mirrors
  // frp_current's design; see schema.sql).
  frp: `
    SELECT sv.id AS version_id, sv.performed_at,
           fs.frp_item_number AS group_key, c.label AS group_label, c.name AS group_sub_label,
           CASE WHEN c.mmc THEN 'mmc' ELSE 'standard' END AS split_value,
           SUM(NULLIF(fs.length, '')::numeric) AS total_length,
           COUNT(*) AS drum_count
    FROM stock_versions sv
    JOIN frp_stock fs ON fs.version_id = sv.id
    LEFT JOIN frp_catalog c ON c.item_number = fs.frp_item_number
    WHERE sv.material_key = 'frp'
    GROUP BY sv.id, sv.performed_at, fs.frp_item_number, c.label, c.name, c.mmc
    ORDER BY sv.performed_at ASC
  `,
  // No catalog for coated FRP - diameter is the closest thing to an
  // "item" identity, and type (XB/Z) is the split dimension.
  coatedFrp: `
    SELECT sv.id AS version_id, sv.performed_at,
           (cs.diameter || '|' || cs.type) AS group_key, cs.diameter AS group_label, cs.type AS group_sub_label,
           cs.type AS split_value,
           SUM(NULLIF(cs.length, '')::numeric) AS total_length,
           COUNT(*) AS drum_count
    FROM stock_versions sv
    JOIN coated_frp_stock cs ON cs.version_id = sv.id
    WHERE sv.material_key = 'coatedFrp'
    GROUP BY sv.id, sv.performed_at, cs.diameter, cs.type
    ORDER BY sv.performed_at ASC
  `,
  // Filler's identity is diameter+color; color is also the split
  // dimension (3 values instead of frp/coatedFrp's 2).
  filler: `
    SELECT sv.id AS version_id, sv.performed_at,
           (fl.color || '|' || fl.diameter) AS group_key, fl.diameter AS group_label, fl.color AS group_sub_label,
           fl.color AS split_value,
           SUM(NULLIF(fl.length, '')::numeric) AS total_length,
           COUNT(*) AS drum_count
    FROM stock_versions sv
    JOIN filler_stock fl ON fl.version_id = sv.id
    WHERE sv.material_key = 'filler'
    GROUP BY sv.id, sv.performed_at, fl.diameter, fl.color
    ORDER BY sv.performed_at ASC
  `,
};

// Per-(round, item) totals across every historical check for one
// material, aggregated in SQL (GROUP BY) instead of the frontend
// fetching every round's full item list and summing in JS - one query
// instead of N, and a payload sized to (rounds × distinct items) rather
// than (rounds × drums). Powers the Reports page's trend/split-count
// charts and the per-item breakdown table, for any of the 3 materials -
// see TREND_QUERIES above for what "item identity" and "split" mean per
// material (frp: item number / mmc; coatedFrp: diameter / XB-Z; filler:
// diameter+color / color).
export async function getMaterialTrend(materialKey) {
  const sql = TREND_QUERIES[materialKey];
  if (!sql) throw new ApiError("Nieznany materiał.", 404);
  const { rows } = await pool.query(sql);
  return rows.map((row) => ({
    versionId: row.version_id,
    performedAt: row.performed_at,
    groupKey: row.group_key,
    groupLabel: row.group_label ?? "",
    groupSubLabel: row.group_sub_label ?? "",
    splitValue: row.split_value ?? "",
    totalLength: Number(row.total_length) || 0,
    drumCount: Number(row.drum_count) || 0,
  }));
}

export async function getBundleMaterialSnapshot(id, materialKey) {
  const material = getMaterial(materialKey);
  if (!material) throw new ApiError("Nieznany materiał.", 404);

  const { rows } = await pool.query(`SELECT ${VERSION_COLUMN[materialKey]} AS version_id FROM stocks WHERE id = $1`, [id]);
  if (!rows.length) throw new ApiError("Nie znaleziono stocku.", 404);
  const versionId = rows[0].version_id;
  if (!versionId) return { versionId: null, performedAt: null, performedBy: null, items: [] };

  const { rows: versionRows } = await pool.query("SELECT * FROM stock_versions WHERE id = $1", [versionId]);
  const version = versionRows[0];

  const itemsSql = materialKey === "frp" ? FRP_STOCK_ITEMS_SQL : `SELECT * FROM ${material.stockTable} WHERE version_id = $1`;
  const { rows: items } = await pool.query(itemsSql, [versionId]);

  return {
    versionId,
    performedAt: version?.performed_at ?? null,
    performedBy: version?.performed_by ?? null,
    items: items.map((row) => stockRowToSnapshotApi(materialKey, row)),
  };
}
