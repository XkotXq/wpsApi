import { pool } from "./db.js";
import { newId } from "./id.js";
import { ApiError } from "./errors.js";
import { resolveDrumId, assertDrumFree } from "./drums.js";

function readField(body, key, def) {
  if (body[key] !== undefined) return body[key];
  for (const alias of def.aliases || []) {
    if (body[alias] !== undefined) return body[alias];
  }
  return undefined;
}

function coerceValue(def, value) {
  if (def.type === "bool") return Boolean(value);
  if (def.type === "enum") {
    const v = String(value ?? "").trim();
    return def.values.includes(v) ? v : def.default;
  }
  return String(value ?? "").trim();
}

function rowToApi(material, row) {
  const out = { id: row.id, position: row.position, createdAt: row.created_at, updatedAt: row.updated_at };
  for (const [key, def] of Object.entries(material.fields)) {
    const raw = row[def.column];
    out[key] = def.type === "bool" ? Boolean(raw) : raw ?? "";
  }
  out.drumNumber = row.drum_number ?? "";
  if (material.catalog) {
    out.type = row.__catalog_type ?? "XB";
    out.mmc = Boolean(row.__catalog_mmc);
    out.frpLabel = row.__catalog_label ?? "";
    out.frpName = row.__catalog_name ?? "";
    // Kept alongside frpItemNumber so older frontend code reading either
    // name still works — both point at the same underlying value.
    out.frpNumber = row.frp_item_number ?? "";
    out.itemNumber = row.frp_item_number ?? "";
  }
  return out;
}

// Reads catalog columns onto each row under __catalog_* keys (via a LEFT
// JOIN) so rowToApi can splice them in — only frp uses this today, but
// any material with a `catalog` config gets the same treatment.
function withCatalogJoin(material, selectSql) {
  if (!material.catalog) return selectSql;
  const { table, catalogKeyColumn, itemKeyColumn } = material.catalog;
  return `
    SELECT t.*, c.type AS __catalog_type, c.mmc AS __catalog_mmc, c.label AS __catalog_label, c.name AS __catalog_name
    FROM (${selectSql}) t
    LEFT JOIN ${table} c ON c.${catalogKeyColumn} = t.${itemKeyColumn}
  `;
}

async function safeRollback(client) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // connection already broken — nothing more we can do here
  }
}

export async function listItems(material) {
  const base = `SELECT * FROM ${material.currentTable} ORDER BY position ASC, created_at ASC`;
  const { rows } = await pool.query(withCatalogJoin(material, base));
  return rows.map((r) => rowToApi(material, r));
}

export async function createItem(material, body) {
  for (const key of material.required) {
    if (key === "drumNumber") {
      if (!String(body?.drumNumber ?? "").trim()) throw new ApiError('Pole "drumNumber" jest wymagane.', 400);
      continue;
    }
    const def = material.fields[key];
    const value = def ? readField(body, key, def) : body?.[key];
    if (!String(value ?? "").trim()) throw new ApiError(`Pole "${key}" jest wymagane.`, 400);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const drumNumber = String(body.drumNumber ?? "").trim();
    const drumId = await resolveDrumId(client, drumNumber, null);
    await assertDrumFree(client, drumId);

    const columns = ["id", "drum_id", "drum_number"];
    const values = [newId(), drumId, drumNumber];
    const placeholders = ["$1", "$2", "$3"];
    let i = 4;
    for (const [key, def] of Object.entries(material.fields)) {
      columns.push(def.column);
      values.push(coerceValue(def, readField(body, key, def) ?? def.default));
      placeholders.push(`$${i++}`);
    }
    const { rows: posRows } = await client.query(`SELECT COALESCE(MAX(position), -1) + 1 AS next FROM ${material.currentTable}`);
    columns.push("position");
    values.push(posRows[0].next);
    placeholders.push(`$${i++}`);

    const { rows } = await client.query(
      `INSERT INTO ${material.currentTable} (${columns.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`,
      values
    );
    await client.query("COMMIT");
    if (!material.catalog) return rowToApi(material, rows[0]);
    const { rows: joined } = await pool.query(withCatalogJoin(material, `SELECT * FROM ${material.currentTable} WHERE id = $1`), [rows[0].id]);
    return rowToApi(material, joined[0]);
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
}

export async function updateItem(material, id, body) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: existingRows } = await client.query(`SELECT * FROM ${material.currentTable} WHERE id = $1 FOR UPDATE`, [id]);
    if (!existingRows.length) {
      await safeRollback(client);
      throw new ApiError("Nie znaleziono wpisu.", 404);
    }
    const existing = existingRows[0];

    const sets = [];
    const values = [];
    let i = 1;

    if (body.drumNumber !== undefined) {
      const drumNumber = String(body.drumNumber ?? "").trim();
      const drumId = await resolveDrumId(client, drumNumber, existing.drum_id);
      await assertDrumFree(client, drumId, { excludeTable: material.currentTable, excludeId: id });
      sets.push(`drum_id = $${i++}`);
      values.push(drumId);
      sets.push(`drum_number = $${i++}`);
      values.push(drumNumber);
    }

    for (const [key, def] of Object.entries(material.fields)) {
      const value = readField(body, key, def);
      if (value === undefined) continue;
      sets.push(`${def.column} = $${i++}`);
      values.push(coerceValue(def, value));
    }
    if (!sets.length) {
      await safeRollback(client);
      throw new ApiError("Brak pól do aktualizacji.", 400);
    }
    sets.push("updated_at = now()");
    values.push(id);

    const { rows: updatedRows } = await client.query(`UPDATE ${material.currentTable} SET ${sets.join(", ")} WHERE id = $${i} RETURNING *`, values);
    await client.query("COMMIT");
    if (!material.catalog) return rowToApi(material, updatedRows[0]);
    const { rows: joined } = await pool.query(withCatalogJoin(material, `SELECT * FROM ${material.currentTable} WHERE id = $1`), [id]);
    return rowToApi(material, joined[0]);
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteItem(material, id) {
  const { rowCount } = await pool.query(`DELETE FROM ${material.currentTable} WHERE id = $1`, [id]);
  if (!rowCount) throw new ApiError("Nie znaleziono wpisu.", 404);
}

// Persists drag-and-drop reordering: `order` is every id in the
// material's table, in the desired display order.
//
// One bulk UPDATE...FROM unnest(), not N round trips — with ~200 rows the
// old loop meant ~200 sequential awaited queries per drag, each paying full
// network latency. A single statement is also atomic on its own, so no
// explicit transaction/rollback is needed here.
export async function reorderItems(material, order) {
  if (!Array.isArray(order) || !order.length) throw new ApiError('Wymagana tablica "order".', 400);
  await pool.query(
    `UPDATE ${material.currentTable} AS t
     SET position = v.position
     FROM (SELECT * FROM unnest($1::uuid[], $2::int[]) AS v(id, position)) AS v
     WHERE t.id = v.id`,
    [order, order.map((_, idx) => idx)]
  );
  return listItems(material);
}

// Moves an existing drum (found by drumNumber) so it sits just before
// targetId, updating length/location/remark — mirrors handleTransfer() in
// the frontend.
export async function transferItem(material, body) {
  const { drumNumber, targetId, length, location, remark } = body;
  const drum = String(drumNumber ?? "").trim();
  if (!drum) throw new ApiError("Wpisz numer szpuli.", 400);
  if (!String(length ?? "").trim()) throw new ApiError("Uzupełnij długość.", 400);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: srcRows } = await client.query(`SELECT * FROM ${material.currentTable} WHERE drum_number = $1 FOR UPDATE`, [drum]);
    if (!srcRows.length) {
      await safeRollback(client);
      throw new ApiError("Taki numer szpuli nie istnieje na liście.", 404);
    }
    const src = srcRows[0];

    await client.query(
      `UPDATE ${material.currentTable} SET length = $1, location = $2, remark = $3, updated_at = now() WHERE id = $4`,
      [String(length ?? "").trim(), String(location ?? "").trim(), String(remark ?? "").trim(), src.id]
    );

    if (targetId && targetId !== src.id) {
      const { rows: allRows } = await client.query(`SELECT id FROM ${material.currentTable} ORDER BY position ASC`);
      const ids = allRows.map((r) => r.id).filter((rid) => rid !== src.id);
      const targetIdx = ids.indexOf(targetId);
      ids.splice(targetIdx >= 0 ? targetIdx : ids.length, 0, src.id);
      // Same bulk unnest() UPDATE as reorderItems, instead of one query per row.
      await client.query(
        `UPDATE ${material.currentTable} AS t
         SET position = v.position
         FROM (SELECT * FROM unnest($1::uuid[], $2::int[]) AS v(id, position)) AS v
         WHERE t.id = v.id`,
        [ids, ids.map((_, idx) => idx)]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
  return listItems(material);
}
