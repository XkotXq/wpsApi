import { newId } from "./id.js";
import { ApiError } from "./errors.js";

const CURRENT_TABLES = ["frp_current", "coated_frp_current", "filler_current"];

// Resolves a drum number to a stable drums.id. If the item already has a
// drum (existingDrumId), this renames that same drum in place instead of
// pointing at a different one — editing the "numer szpuli" field on an
// existing item is a correction of that drum's label, not a swap to a
// different physical drum. Must run inside the caller's transaction
// (client, not pool) so it rolls back together with the rest of the write.
export async function resolveDrumId(client, drumNumber, existingDrumId) {
  const trimmed = String(drumNumber ?? "").trim();
  if (!trimmed) return null;

  if (existingDrumId) {
    try {
      const { rows } = await client.query(
        `UPDATE drums SET drum_number = $1, updated_at = now() WHERE id = $2 RETURNING id`,
        [trimmed, existingDrumId]
      );
      if (rows.length) return rows[0].id;
    } catch (err) {
      if (err.code === "23505") throw new ApiError("Taki numer szpuli już istnieje.", 409);
      throw err;
    }
  }

  const { rows: existing } = await client.query("SELECT id FROM drums WHERE drum_number = $1", [trimmed]);
  if (existing.length) return existing[0].id;

  const id = newId();
  await client.query("INSERT INTO drums (id, drum_number) VALUES ($1, $2)", [id, trimmed]);
  return id;
}

// Cross-material uniqueness: a drum may only be attached to one current
// item at a time. Mirrors the old assertDrumAvailable (which looped
// drum_number over three tables), now checking drum_id instead.
export async function assertDrumFree(client, drumId, { excludeTable, excludeId } = {}) {
  if (!drumId) return;
  for (const table of CURRENT_TABLES) {
    let sql = `SELECT id FROM ${table} WHERE drum_id = $1`;
    const params = [drumId];
    if (table === excludeTable && excludeId) {
      sql += " AND id <> $2";
      params.push(excludeId);
    }
    const { rows } = await client.query(sql, params);
    if (rows.length) throw new ApiError("Taki numer szpuli już istnieje.", 409);
  }
}
