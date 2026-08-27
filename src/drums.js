import { newId } from "./id.js";
import { MATERIAL_KEYS, getMaterial } from "./materials.js";
import { ApiError } from "./errors.js";

// drums is a permanent registry: one row forever per physical drum
// number, so historical stock snapshots can reference "the same drum"
// (via drum_id) across materials and over time. Call within a
// transaction; `client` must already hold the row lock you need.
export async function getOrCreateDrum(client, drumNumber) {
  const trimmed = String(drumNumber ?? "").trim();
  if (!trimmed) throw new ApiError("Numer szpuli jest wymagany.", 400);

  const { rows: existing } = await client.query("SELECT id, drum_number FROM drums WHERE drum_number = $1", [trimmed]);
  if (existing.length) return existing[0];

  const { rows } = await client.query(
    "INSERT INTO drums (id, drum_number) VALUES ($1, $2) RETURNING id, drum_number",
    [newId(), trimmed]
  );
  return rows[0];
}

// A drum can only be on the floor in one place at a time: this checks
// every material's *_current table, not just the one being written to
// (mirrors the old cross-material drum-number uniqueness rule).
export async function assertDrumFree(client, drumNumber, { excludeTable, excludeId } = {}) {
  const trimmed = String(drumNumber ?? "").trim();
  if (!trimmed) return;
  for (const key of MATERIAL_KEYS) {
    const m = getMaterial(key);
    const params = [trimmed];
    let sql = `SELECT id FROM ${m.table} WHERE drum_number = $1`;
    if (m.table === excludeTable && excludeId) {
      sql += " AND id <> $2";
      params.push(excludeId);
    }
    const { rows } = await client.query(sql, params);
    if (rows.length) throw new ApiError("Taki numer szpuli już istnieje.", 409);
  }
}
