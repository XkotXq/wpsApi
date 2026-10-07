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
    // Which kind of transport this is about, or null for "any" - see
    // schema.sql's order_type column. A rule can name a line, a material, a
    // type, or any combination of them.
    orderType: row.order_type,
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
export async function upsertLineMaterialRule({ lineName, itemNo, orderType, note }) {
  // All three scopes are optional on their own - a guideline can be about a
  // line, a material, a kind of transport, or any combination - but a rule
  // with none of them would apply to every transport in the plant, which is
  // not a standing instruction, it is noise on every screen.
  const line = String(lineName ?? "").trim().toUpperCase() || null;
  const item = String(itemNo ?? "").trim() || null;
  const type = String(orderType ?? "").trim() || null;
  const text = String(note ?? "").trim();
  if (!line && !item && !type) throw new ApiError("Podaj linię, materiał albo rodzaj transportu.", 400);
  if (!text) throw new ApiError("Podaj treść wytycznej.", 400);

  let row;
  try {
    // One upsert for every combination, since the unique index covers the
    // whole triple with NULLS NOT DISTINCT (see schema.sql). This used to be
    // two statements with different conflict targets, because the old plain
    // UNIQUE could not catch a repeated line-wide rule - Postgres treated
    // its NULL item_no as distinct and ON CONFLICT never fired.
    ({ rows: [row] } = await pool.query(
      `INSERT INTO line_material_rules (line_name, item_no, order_type, note)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (line_name, item_no, order_type) DO UPDATE SET note = EXCLUDED.note
       RETURNING *`,
      [line, item, type, text]
    ));
  } catch (err) {
    if (err.code === "P0001") throw new ApiError(err.message, 400);
    // An order type the schema does not know (FK on order_types).
    if (err.code === "23503") throw new ApiError("Nieprawidłowy rodzaj transportu.", 400);
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
