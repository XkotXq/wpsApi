import { pool } from "./db.js";
import { newId } from "./id.js";
import { getMaterial } from "./materials.js";
import { ApiError } from "./errors.js";
import { applyItemSync, listItems } from "./items.js";

async function safeRollback(client) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // connection already broken — nothing more we can do here
  }
}

const STOCKS_VERSION_COLUMN = {
  frp: "frp_version_id",
  coatedFrp: "coated_frp_version_id",
  filler: "filler_version_id",
};

// One "remanent" (stock-take) session ties together the three
// per-material tallies via stocks.{material}_version_id — a session is
// created up front, then each material is submitted into it as it's
// counted, so the three end up grouped under one stocks row.
const SESSION_SELECT = `
  SELECT s.id, s.performed_at, s.created_at, s.updated_at,
    vf.id  AS frp_version_id,        vf.performed_by  AS frp_performed_by,        vf.performed_at  AS frp_performed_at,        vf.yes_count  AS frp_yes_count,        vf.no_count  AS frp_no_count,
    vc.id  AS coated_frp_version_id, vc.performed_by  AS coated_frp_performed_by, vc.performed_at  AS coated_frp_performed_at, vc.yes_count  AS coated_frp_yes_count, vc.no_count  AS coated_frp_no_count,
    vfi.id AS filler_version_id,     vfi.performed_by AS filler_performed_by,     vfi.performed_at AS filler_performed_at,     vfi.yes_count AS filler_yes_count,     vfi.no_count AS filler_no_count
  FROM stocks s
  LEFT JOIN stock_versions vf  ON vf.id = s.frp_version_id
  LEFT JOIN stock_versions vc  ON vc.id = s.coated_frp_version_id
  LEFT JOIN stock_versions vfi ON vfi.id = s.filler_version_id
`;

function versionPart(row, prefix) {
  const id = row[`${prefix}_version_id`];
  if (!id) return null;
  return {
    versionId: id,
    performedBy: row[`${prefix}_performed_by`],
    performedAt: row[`${prefix}_performed_at`],
    yesCount: row[`${prefix}_yes_count`],
    noCount: row[`${prefix}_no_count`],
  };
}

function sessionRowToApi(row) {
  return {
    id: row.id,
    performedAt: row.performed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    frp: versionPart(row, "frp"),
    coatedFrp: versionPart(row, "coated_frp"),
    filler: versionPart(row, "filler"),
  };
}

export async function createStockSession() {
  const id = newId();
  await pool.query("INSERT INTO stocks (id) VALUES ($1)", [id]);
  return getStockSession(id);
}

export async function listStockSessions({ limit = 50 } = {}) {
  const { rows } = await pool.query(`${SESSION_SELECT} ORDER BY s.performed_at DESC LIMIT $1`, [limit]);
  return rows.map(sessionRowToApi);
}

export async function getStockSession(stocksId) {
  const { rows } = await pool.query(`${SESSION_SELECT} WHERE s.id = $1`, [stocksId]);
  if (!rows.length) throw new ApiError("Nie znaleziono sesji remanentu.", 404);
  return sessionRowToApi(rows[0]);
}

async function insertSnapshotRow(client, materialKey, versionId, row) {
  if (materialKey === "frp") {
    await client.query(
      `INSERT INTO frp_stock (id, version_id, frp_item_number, drum_id, drum_number, length, location, remark)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [newId(), versionId, row.frp_item_number, row.drum_id, row.drum_number, row.length, row.location, row.remark]
    );
  } else if (materialKey === "coatedFrp") {
    await client.query(
      `INSERT INTO coated_frp_stock (id, version_id, drum_id, drum_number, diameter, length, type, location, remark)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [newId(), versionId, row.drum_id, row.drum_number, row.diameter, row.length, row.type, row.location, row.remark]
    );
  } else {
    await client.query(
      `INSERT INTO filler_stock (id, version_id, drum_id, drum_number, diameter, length, color, flameproof, location, remark)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [newId(), versionId, row.drum_id, row.drum_number, row.diameter, row.length, row.color, row.flameproof, row.location, row.remark]
    );
  }
}

// Submits a finished stock-take for one material within an existing
// session: writes a tally (stock_versions) plus a full snapshot of that
// material's *_current rows (*_stock), then points the session's
// {material}_version_id at it. Never touches *_current itself. Per-drum
// found/not-found status is counted client-side — only the final
// yes/no tally is sent here. Re-submitting the same material in the
// same session replaces its version (new snapshot, old one orphaned).
export async function submitStockTake(stocksId, materialKey, { performedBy, yesCount, noCount }) {
  const material = getMaterial(materialKey);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: sessionRows } = await client.query("SELECT id FROM stocks WHERE id = $1 FOR UPDATE", [stocksId]);
    if (!sessionRows.length) {
      await safeRollback(client);
      throw new ApiError("Nie znaleziono sesji remanentu.", 404);
    }

    const versionId = newId();
    await client.query(
      `INSERT INTO stock_versions (id, material_key, performed_by, yes_count, no_count)
       VALUES ($1, $2, $3, $4, $5)`,
      [versionId, materialKey, performedBy ? String(performedBy).trim() : null, Number(yesCount) || 0, Number(noCount) || 0]
    );

    const { rows: currentRows } = await client.query(`SELECT * FROM ${material.table} ORDER BY position ASC`);
    for (const row of currentRows) {
      await insertSnapshotRow(client, materialKey, versionId, row);
    }

    const column = STOCKS_VERSION_COLUMN[materialKey];
    await client.query(`UPDATE stocks SET ${column} = $1, updated_at = now() WHERE id = $2`, [versionId, stocksId]);

    await client.query("COMMIT");
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
  return getStockSession(stocksId);
}

// Finishes a stock-take that was counted and edited entirely
// client-side: applies the local item list to *_current (create/update/
// delete diff, see applyItemSync in items.js), then — in the SAME
// transaction — writes the tally and a snapshot and either creates a new
// session or attaches to an existing one (`stocksId`, from the
// "Sesje remanentu" panel at /stock/menu — grouping frp/coatedFrp/filler
// under one stocks row is only ever manual, never inferred by time).
// All-or-nothing: either the whole thing lands, or nothing does and the
// client's local state is still the only copy.
export async function finishStock(materialKey, { items, performedBy, yesCount, noCount, stocksId: targetStocksId }) {
  const material = getMaterial(materialKey);
  const client = await pool.connect();
  let stocksId = targetStocksId || null;
  try {
    await client.query("BEGIN");

    if (stocksId) {
      const { rows: sessionRows } = await client.query("SELECT id FROM stocks WHERE id = $1 FOR UPDATE", [stocksId]);
      if (!sessionRows.length) {
        await safeRollback(client);
        throw new ApiError("Nie znaleziono wybranej sesji remanentu.", 404);
      }
    }

    await applyItemSync(client, materialKey, items);

    const versionId = newId();
    await client.query(
      `INSERT INTO stock_versions (id, material_key, performed_by, yes_count, no_count)
       VALUES ($1, $2, $3, $4, $5)`,
      [versionId, materialKey, performedBy ? String(performedBy).trim() : null, Number(yesCount) || 0, Number(noCount) || 0]
    );

    const { rows: currentRows } = await client.query(`SELECT * FROM ${material.table} ORDER BY position ASC`);
    for (const row of currentRows) {
      await insertSnapshotRow(client, materialKey, versionId, row);
    }

    const column = STOCKS_VERSION_COLUMN[materialKey];
    if (stocksId) {
      await client.query(`UPDATE stocks SET ${column} = $1, updated_at = now() WHERE id = $2`, [versionId, stocksId]);
    } else {
      stocksId = newId();
      await client.query(`INSERT INTO stocks (id, ${column}) VALUES ($1, $2)`, [stocksId, versionId]);
    }

    await client.query("COMMIT");
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }

  const [session, savedItems] = await Promise.all([getStockSession(stocksId), listItems(materialKey)]);
  return { ok: true, session, items: savedItems, itemCount: savedItems.length };
}

export async function getSessionMaterialSnapshot(stocksId, materialKey) {
  const column = STOCKS_VERSION_COLUMN[materialKey];
  const { rows } = await pool.query(`SELECT ${column} AS version_id FROM stocks WHERE id = $1`, [stocksId]);
  if (!rows.length) throw new ApiError("Nie znaleziono sesji remanentu.", 404);
  const versionId = rows[0].version_id;
  if (!versionId) throw new ApiError("Ten materiał nie został jeszcze policzony w tej sesji.", 404);

  const material = getMaterial(materialKey);
  let itemRows;
  if (materialKey === "frp") {
    const { rows: snapRows } = await pool.query(
      `SELECT s.*, k.name AS cat_name, k.label AS cat_label, k.type AS cat_type, k.mmc AS cat_mmc
       FROM frp_stock s LEFT JOIN frp_catalog k ON k.item_number = s.frp_item_number
       WHERE s.version_id = $1`,
      [versionId]
    );
    itemRows = snapRows.map((row) => ({
      id: row.id,
      frpItemNumber: row.frp_item_number,
      itemNumber: row.frp_item_number,
      frpLabel: row.cat_label ?? "",
      frpName: row.cat_name ?? "",
      type: row.cat_type ?? "XB",
      mmc: Boolean(row.cat_mmc),
      drumNumber: row.drum_number,
      length: row.length,
      location: row.location,
      remark: row.remark,
    }));
  } else {
    const { rows: snapRows } = await pool.query(`SELECT * FROM ${material.stockTable} WHERE version_id = $1`, [versionId]);
    itemRows = snapRows.map((row) => {
      const out = { id: row.id, drumNumber: row.drum_number };
      for (const [key, def] of Object.entries(material.fields)) {
        const raw = row[def.column];
        out[key] = def.type === "bool" ? Boolean(raw) : raw ?? "";
      }
      return out;
    });
  }

  return { versionId, items: itemRows };
}
