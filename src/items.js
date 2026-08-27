import { pool } from "./db.js";
import { newId } from "./id.js";
import { getMaterial } from "./materials.js";
import { ApiError } from "./errors.js";
import { getOrCreateDrum, assertDrumFree } from "./drums.js";

function coerceValue(def, value) {
  if (def.type === "bool") return Boolean(value);
  if (def.type === "enum") {
    const v = String(value ?? "").trim();
    return def.values.includes(v) ? v : def.default;
  }
  return String(value ?? "").trim();
}

function commonToApi(row) {
  return {
    id: row.id,
    drumNumber: row.drum_number,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToApi(materialKey, material, row) {
  const out = commonToApi(row);
  if (materialKey === "frp") {
    out.frpItemNumber = row.frp_item_number;
    out.itemNumber = row.frp_item_number;
    out.frpNumber = row.frp_item_number;
    out.frpLabel = row.cat_label ?? "";
    out.frpName = row.cat_name ?? "";
    out.type = row.cat_type ?? "XB";
    out.mmc = Boolean(row.cat_mmc);
    out.length = row.length ?? "";
    out.location = row.location ?? "";
    out.remark = row.remark ?? "";
    out.reservedForOrder = Boolean(row.reserved_for_order);
    return out;
  }
  for (const [key, def] of Object.entries(material.fields)) {
    const raw = row[def.column];
    out[key] = def.type === "bool" ? Boolean(raw) : raw ?? "";
  }
  return out;
}

async function safeRollback(client) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // connection already broken — nothing more we can do here
  }
}

function selectSql(materialKey, material) {
  if (materialKey === "frp") {
    return `SELECT c.*, k.name AS cat_name, k.label AS cat_label, k.type AS cat_type, k.mmc AS cat_mmc
            FROM frp_current c JOIN frp_catalog k ON k.item_number = c.frp_item_number`;
  }
  return `SELECT c.* FROM ${material.table} c`;
}

export async function listItems(materialKey) {
  const material = getMaterial(materialKey);
  const { rows } = await pool.query(`${selectSql(materialKey, material)} ORDER BY c.position ASC, c.created_at ASC`);
  return rows.map((r) => rowToApi(materialKey, material, r));
}

export async function createItem(materialKey, body) {
  const material = getMaterial(materialKey);
  for (const key of material.required) {
    if (!String(body?.[key] ?? "").trim()) throw new ApiError(`Pole "${key}" jest wymagane.`, 400);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assertDrumFree(client, body.drumNumber);
    const drum = await getOrCreateDrum(client, body.drumNumber);

    const columns = ["id", "drum_id", "drum_number"];
    const values = [newId(), drum.id, drum.drum_number];
    const placeholders = ["$1", "$2", "$3"];
    let i = 4;
    for (const [key, def] of Object.entries(material.fields)) {
      columns.push(def.column);
      values.push(coerceValue(def, body[key] ?? def.default));
      placeholders.push(`$${i++}`);
    }
    const { rows: posRows } = await client.query(`SELECT COALESCE(MAX(position), -1) + 1 AS next FROM ${material.table}`);
    columns.push("position");
    values.push(posRows[0].next);
    placeholders.push(`$${i++}`);

    const { rows } = await client.query(
      `INSERT INTO ${material.table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING id`,
      values
    );
    await client.query("COMMIT");
    return getItem(materialKey, rows[0].id);
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
}

export async function getItem(materialKey, id) {
  const material = getMaterial(materialKey);
  const { rows } = await pool.query(`${selectSql(materialKey, material)} WHERE c.id = $1`, [id]);
  if (!rows.length) throw new ApiError("Nie znaleziono wpisu.", 404);
  return rowToApi(materialKey, material, rows[0]);
}

export async function updateItem(materialKey, id, body) {
  const material = getMaterial(materialKey);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: existingRows } = await client.query(`SELECT id FROM ${material.table} WHERE id = $1 FOR UPDATE`, [id]);
    if (!existingRows.length) {
      await safeRollback(client);
      throw new ApiError("Nie znaleziono wpisu.", 404);
    }

    const sets = [];
    const values = [];
    let i = 1;

    if (body.drumNumber !== undefined) {
      await assertDrumFree(client, body.drumNumber, { excludeTable: material.table, excludeId: id });
      const drum = await getOrCreateDrum(client, body.drumNumber);
      sets.push(`drum_id = $${i++}`);
      values.push(drum.id);
      sets.push(`drum_number = $${i++}`);
      values.push(drum.drum_number);
    }

    for (const [key, def] of Object.entries(material.fields)) {
      if (body[key] === undefined) continue;
      sets.push(`${def.column} = $${i++}`);
      values.push(coerceValue(def, body[key]));
    }
    if (!sets.length) {
      await safeRollback(client);
      throw new ApiError("Brak pól do aktualizacji.", 400);
    }
    sets.push("updated_at = now()");
    values.push(id);

    await client.query(`UPDATE ${material.table} SET ${sets.join(", ")} WHERE id = $${i}`, values);
    await client.query("COMMIT");
    return getItem(materialKey, id);
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteItem(materialKey, id) {
  const material = getMaterial(materialKey);
  const { rowCount } = await pool.query(`DELETE FROM ${material.table} WHERE id = $1`, [id]);
  if (!rowCount) throw new ApiError("Nie znaleziono wpisu.", 404);
}

export async function reorderItems(materialKey, order) {
  const material = getMaterial(materialKey);
  if (!Array.isArray(order) || !order.length) throw new ApiError('Wymagana tablica "order".', 400);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let idx = 0; idx < order.length; idx++) {
      await client.query(`UPDATE ${material.table} SET position = $1 WHERE id = $2`, [idx, order[idx]]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
  return listItems(materialKey);
}

// Replaces a material's whole *_current list with `items` in one
// transaction: existing rows (matched by id) are updated, rows with no
// matching id are inserted as new, and rows missing from `items`
// entirely are deleted. Position is set from array order. Used by
// finishStock() (yfoc/api/src/stocks.js) to save a stock-take that was
// counted/edited entirely client-side and only synced once at the end
// — `client` must already be inside an open transaction (BEGIN'd by the
// caller), so this itself does not commit/rollback.
export async function applyItemSync(client, materialKey, items) {
  const material = getMaterial(materialKey);
  if (!Array.isArray(items)) throw new ApiError('Wymagana tablica "items".', 400);

  const { rows: existingRows } = await client.query(`SELECT id FROM ${material.table}`);
  const existingIds = new Set(existingRows.map((r) => r.id));
  const incomingIds = new Set(items.map((i) => i.id).filter((id) => existingIds.has(id)));

  const toDelete = [...existingIds].filter((id) => !incomingIds.has(id));
  if (toDelete.length) {
    await client.query(`DELETE FROM ${material.table} WHERE id = ANY($1::uuid[])`, [toDelete]);
  }

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    for (const key of material.required) {
      if (!String(item?.[key] ?? "").trim()) throw new ApiError(`Pole "${key}" jest wymagane (pozycja ${idx + 1}).`, 400);
    }
    const isExisting = Boolean(item.id) && existingIds.has(item.id);

    await assertDrumFree(client, item.drumNumber, isExisting ? { excludeTable: material.table, excludeId: item.id } : {});
    const drum = await getOrCreateDrum(client, item.drumNumber);

    if (isExisting) {
      const sets = ["drum_id = $1", "drum_number = $2", "position = $3", "updated_at = now()"];
      const values = [drum.id, drum.drum_number, idx];
      let i = 4;
      for (const [key, def] of Object.entries(material.fields)) {
        sets.push(`${def.column} = $${i++}`);
        values.push(coerceValue(def, item[key] ?? def.default));
      }
      values.push(item.id);
      await client.query(`UPDATE ${material.table} SET ${sets.join(", ")} WHERE id = $${i}`, values);
    } else {
      const columns = ["id", "drum_id", "drum_number", "position"];
      const values = [newId(), drum.id, drum.drum_number, idx];
      const placeholders = ["$1", "$2", "$3", "$4"];
      let i = 5;
      for (const [key, def] of Object.entries(material.fields)) {
        columns.push(def.column);
        values.push(coerceValue(def, item[key] ?? def.default));
        placeholders.push(`$${i++}`);
      }
      await client.query(`INSERT INTO ${material.table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`, values);
    }
  }
}

// Moves an existing drum (found by drumNumber) so it sits just before
// targetId, updating length/location/remark.
export async function transferItem(materialKey, body) {
  const material = getMaterial(materialKey);
  const { drumNumber, targetId, length, location, remark } = body;
  const drum = String(drumNumber ?? "").trim();
  if (!drum) throw new ApiError("Wpisz numer szpuli.", 400);
  if (!String(length ?? "").trim()) throw new ApiError("Uzupełnij długość.", 400);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: srcRows } = await client.query(`SELECT * FROM ${material.table} WHERE drum_number = $1 FOR UPDATE`, [drum]);
    if (!srcRows.length) {
      await safeRollback(client);
      throw new ApiError("Taki numer szpuli nie istnieje na liście.", 404);
    }
    const src = srcRows[0];

    const locationDef = material.fields.location;
    const locationValue = locationDef ? coerceValue(locationDef, location) : String(location ?? "").trim();

    await client.query(
      `UPDATE ${material.table} SET length = $1, location = $2, remark = $3, updated_at = now() WHERE id = $4`,
      [String(length ?? "").trim(), locationValue, String(remark ?? "").trim(), src.id]
    );

    if (targetId && targetId !== src.id) {
      const { rows: allRows } = await client.query(`SELECT id FROM ${material.table} ORDER BY position ASC`);
      const ids = allRows.map((r) => r.id).filter((rid) => rid !== src.id);
      const targetIdx = ids.indexOf(targetId);
      ids.splice(targetIdx >= 0 ? targetIdx : ids.length, 0, src.id);
      for (let idx = 0; idx < ids.length; idx++) {
        await client.query(`UPDATE ${material.table} SET position = $1 WHERE id = $2`, [idx, ids[idx]]);
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await safeRollback(client);
    throw err;
  } finally {
    client.release();
  }
  return listItems(materialKey);
}
