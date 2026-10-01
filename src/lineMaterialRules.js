import { pool } from "./db.js";
import { ApiError } from "./errors.js";

// "Wytyczne do transportów" (wps nav) - a standing instruction for one
// material on one production line (e.g. line SH02 needs Glass Yarn/600tex
// delivered as short lengths first), backing schema.sql's
// line_material_rules (promoted early from the still-draft transport-orders
// module - see that table's own comment). A small, manually-maintained
// reference table: nothing here is derived, an operator sets these up by
// hand on this screen.

function rowToApi(row) {
  return {
    id: row.id,
    lineName: row.line_name,
    // null for a guideline that is about the line itself, whatever is
    // brought to it - callers show those differently (see wps's own
    // LineMaterialRulesTable).
    itemNo: row.item_no,
    // Only present when the item is also in sm_catalog - a rule can be set
    // up for an item number before it's catalogued, so this is left blank
    // rather than failing, and the caller falls back to the bare item
    // number for display.
    itemName: row.item_name ?? "",
    note: row.note,
    createdAt: row.created_at,
  };
}

export async function listLineMaterialRules() {
  const { rows } = await pool.query(
    `SELECT r.*, c.item_name
     FROM line_material_rules r
     LEFT JOIN sm_catalog c ON c.item_no = r.item_no
     ORDER BY r.line_name, r.item_no NULLS FIRST`
  );
  return rows.map(rowToApi);
}

// Every production line ("Wytyczne do transportów"'s own line picker) -
// schema.sql seeds these; a name typed anywhere else (goods_transport, once
// built) would add non-line rows here too, so `is_line` still matters even
// though this only ever returns the line ones.
export async function listProductionLines() {
  const { rows } = await pool.query("SELECT name FROM locations WHERE is_line ORDER BY name");
  return rows.map((r) => r.name);
}

// One row per (line, item), or one per line when no material is given - a
// second save for the same target replaces its
// note (ON CONFLICT ... DO UPDATE) rather than erroring, so the same form
// serves both "add" and "edit". `line_material_rules_before_write` (the
// trigger) refuses a line_name that isn't a real production line; its
// P0001 is turned into an ApiError here instead of a bare 500.
export async function upsertLineMaterialRule({ lineName, itemNo, note }) {
  const line = String(lineName ?? "").trim().toUpperCase();
  // The material is optional: without one the guideline is about the line
  // itself, whatever is being brought to it (item_no IS NULL - see
  // schema.sql's own comment on the table).
  const item = String(itemNo ?? "").trim() || null;
  const text = String(note ?? "").trim();
  if (!line) throw new ApiError("Podaj linię.", 400);
  if (!text) throw new ApiError("Podaj treść wytycznej.", 400);

  let row;
  try {
    // Two upserts, because the conflict target differs: `(line_name,
    // item_no)` cannot catch a repeat line-wide rule (Postgres treats NULLs
    // as distinct, so ON CONFLICT never fires on it) - that one is caught
    // by the partial unique index on line_name WHERE item_no IS NULL.
    ({ rows: [row] } = item
      ? await pool.query(
          `INSERT INTO line_material_rules (line_name, item_no, note)
           VALUES ($1, $2, $3)
           ON CONFLICT (line_name, item_no) DO UPDATE SET note = EXCLUDED.note
           RETURNING *`,
          [line, item, text]
        )
      : await pool.query(
          `INSERT INTO line_material_rules (line_name, item_no, note)
           VALUES ($1, NULL, $2)
           ON CONFLICT (line_name) WHERE item_no IS NULL DO UPDATE SET note = EXCLUDED.note
           RETURNING *`,
          [line, text]
        ));
  } catch (err) {
    if (err.code === "P0001") throw new ApiError(err.message, 400);
    throw err;
  }
  if (!item) return rowToApi({ ...row, item_name: null });
  const { rows: named } = await pool.query("SELECT item_name FROM sm_catalog WHERE item_no = $1", [item]);
  return rowToApi({ ...row, item_name: named[0]?.item_name ?? null });
}

export async function deleteLineMaterialRule(id) {
  const { rowCount } = await pool.query("DELETE FROM line_material_rules WHERE id = $1", [id]);
  if (!rowCount) throw new ApiError("Nie znaleziono wytycznej.", 404);
}
