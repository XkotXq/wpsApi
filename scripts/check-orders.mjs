// Regression check for the transport-orders tables (orders/order_items/...,
// now folded into src/schema.sql for real - see wpsapi/AGENTS.md's
// "Transport orders" section). Run: node scripts/check-orders.mjs - applies
// the whole schema inside a transaction against the dev database (a no-op
// against one already migrated, since every statement in schema.sql is
// idempotent by design), asserts the rules below, then ROLLS BACK so
// nothing this script inserts is kept.
import { config } from "dotenv";
import fs from "fs";
config({ path: ".env" });
const { pool } = await import("../src/db.js");

const sql = fs.readFileSync(new URL("../src/schema.sql", import.meta.url), "utf8");
const client = await pool.connect();
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (!ok) failures += 1;
};
const fails = async (name, fn, mustContain) => {
  await client.query("SAVEPOINT s");
  try {
    await fn();
    await client.query("RELEASE SAVEPOINT s");
    check(name, false, "did not fail");
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT s");
    check(name, !mustContain || err.message.includes(mustContain), err.message.slice(0, 90));
  }
};

try {
  await client.query("BEGIN");
  await client.query(sql);

  // --- shifts (Europe/Warsaw wall clock) ---
  const shiftOf = async (local) => {
    const { rows } = await client.query(
      "SELECT * FROM order_shift(($1::timestamp) AT TIME ZONE 'Europe/Warsaw')", [local]);
    const r = rows[0];
    return `${r.shift_code}${r.shift_hour}${String(r.minute_of_hour).padStart(2, "0")}/${r.shift_date.toISOString ? r.shift_date.toLocaleDateString("sv") : r.shift_date}`;
  };
  const expectShift = async (local, expected) => {
    const got = await shiftOf(local);
    check(`shift ${local}`, got === expected, `${got} (expected ${expected})`);
  };
  await expectShift("2026-09-24 14:37", "B137/2026-09-24");
  await expectShift("2026-09-24 21:59", "B859/2026-09-24");
  await expectShift("2026-09-24 22:00", "C100/2026-09-24");
  await expectShift("2026-09-25 01:15", "C415/2026-09-24");
  await expectShift("2026-09-25 05:59", "C859/2026-09-24");
  await expectShift("2026-09-25 06:00", "A100/2026-09-25");
  await expectShift("2026-09-25 13:59", "A859/2026-09-25");
  await expectShift("2026-10-25 03:30", "C630/2026-10-24"); // fall-back night: 22:00 -> 03:30 wall clock = 6th hour, digit stays 1-8

  // --- numbers ---
  const { rows: cat } = await client.query("SELECT item_no, item_name, unit FROM sm_catalog WHERE unit <> '' ORDER BY item_no LIMIT 2");
  const insert = (type, extra = {}) => {
    const o = { requested_by: "4601260", from_location: null, to_location: null, details: {}, created_at: "2026-09-25T01:15:00+02:00", ...extra };
    return client.query(
      `INSERT INTO orders (type, requested_by, from_location, to_location, details, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [type, o.requested_by, o.from_location, o.to_location, JSON.stringify(o.details), o.created_at]);
  };
  const water = (await insert("water_refill", { to_location: "SH01", details: { water: "clean" } })).rows[0];
  // The suffix counts orders within the minute and restarts at 1 in the
  // next one (it used to be 3 random digits) - see orders_before_insert.
  check("order number format", /^C415\/260924\/\d+$/.test(water.order_no), water.order_no);
  check("first order of its minute is /1", water.order_no.endsWith("/1"), water.order_no);
  check("shift columns", water.shift_code === "C" && String(water.shift_date.toLocaleDateString("sv")) === "2026-09-24");

  const sameMinute = (await insert("water_refill", { to_location: "SH01", details: { water: "clean" } })).rows[0];
  check("the next order that minute is /2", sameMinute.order_no.endsWith("/2"), sameMinute.order_no);
  const nextMinute = (
    await insert("water_refill", { to_location: "SH01", details: { water: "clean" }, created_at: "2026-09-25T01:16:00+02:00" })
  ).rows[0];
  check("a new minute restarts at /1", nextMinute.order_no === "C416/260924/1", nextMinute.order_no);

  const many = new Set();
  for (let i = 0; i < 300; i += 1) {
    many.add((await insert("waste_removal", { from_location: "ST02", created_at: "2026-09-24T14:37:00+02:00" })).rows[0].order_no);
  }
  check("300 orders in the same minute all unique", many.size === 300, `${many.size} distinct`);
  // A contiguous 1..300 run, not just 300 distinct values - that is what
  // says the counter is really counting and not skipping or re-drawing.
  const suffixes = new Set([...many].map((n) => Number(n.split("/")[2])));
  check(
    "and they are numbered 1..300 with no gaps",
    suffixes.size === 300 && Math.min(...suffixes) === 1 && Math.max(...suffixes) === 300,
    `${Math.min(...suffixes)}..${Math.max(...suffixes)}`
  );

  // --- required fields per type ---
  await fails("water without kind refused", () => insert("water_refill", { to_location: "SH01" }), "orders_type_fields");
  await fails("water with bad kind refused", () => insert("water_refill", { to_location: "SH01", details: { water: "muddy" } }), "orders_type_fields");
  await fails("transport needs from and to", () => insert("goods_transport", { from_location: "SH01" }), "orders_type_fields");
  await fails("waste must not have a destination", () => insert("waste_removal", { from_location: "SH01", to_location: "SH02" }), "orders_type_fields");
  await fails("unknown place refused for a non-transport type", () => insert("machine_transport", { from_location: "XX99", to_location: "SH02" }), "linii produkcyjnych");
  await fails("waste removal takes lines only", () => insert("waste_removal", { from_location: "Hala X" }), "linii produkcyjnych");

  // --- goods_transport: free-text places, shared suggestions ---
  const trip = (await insert("goods_transport", { from_location: "Hala magazynowa 2", to_location: "sh01" })).rows[0];
  check("transport keeps a new place as typed and canonicalises a known one", trip.from_location === "Hala magazynowa 2" && trip.to_location === "SH01", `${trip.from_location} -> ${trip.to_location}`);
  const { rows: reg } = await client.query("SELECT name, is_line FROM locations WHERE lower(name) IN ('hala magazynowa 2', 'sh01') ORDER BY name");
  check("new place registered (not a line), known one not duplicated", reg.length === 2 && reg.some((r) => r.name === "Hala magazynowa 2" && !r.is_line) && reg.some((r) => r.name === "SH01" && r.is_line), JSON.stringify(reg));
  const trip2 = (await insert("goods_transport", { from_location: "HALA MAGAZYNOWA 2", to_location: "Rampa 4" })).rows[0];
  check("second order reuses the registered spelling", trip2.from_location === "Hala magazynowa 2", trip2.from_location);
  await fails("transport from a place to itself refused", () => insert("goods_transport", { from_location: "SH01", to_location: "sh01" }), "orders_type_fields");
  const { rows: sugg } = await client.query("SELECT name FROM locations WHERE name ILIKE '%' || $1 || '%' ORDER BY is_line DESC, name LIMIT 8", ["hala"]);
  check("suggestions filter by typed text", sugg.length === 1 && sugg[0].name === "Hala magazynowa 2", JSON.stringify(sugg));
  await insert("warehouse_return", { from_location: "FC01" });
  await insert("machine_transport", { from_location: "ST01", to_location: "ST02" });
  check("valid return + machine transport accepted", true);

  // --- material order + items (name/unit from the catalog) ---
  await client.query("SET CONSTRAINTS orders_require_items IMMEDIATE");
  await fails("material order without items refused",
    () => insert("material_order", { to_location: "SH03", details: { production_order_no: "ZP-1" } }), "co najmniej jedną pozycję");
  await client.query("SET CONSTRAINTS orders_require_items DEFERRED");
  const mat = (await insert("material_order", { to_location: "SH03", details: { production_order_no: "ZP-1" } })).rows[0];
  await client.query("INSERT INTO order_items (order_id, item_no, item_name, quantity, unit) VALUES ($1, $2, 'zla nazwa', 5, 'zla')", [mat.id, cat[0].item_no]);
  await client.query("SET CONSTRAINTS orders_require_items IMMEDIATE");
  const { rows: items } = await client.query("SELECT * FROM order_items WHERE order_id = $1", [mat.id]);
  check("item name filled from catalog, unit forced to szt. (not the catalog's own)", items[0].item_name === cat[0].item_name && items[0].unit === "szt.", `${items[0].item_name} / ${items[0].unit}`);
  await fails("unknown item refused", () => client.query("INSERT INTO order_items (order_id, item_no, quantity) VALUES ($1, '000', 1)", [mat.id]), "Nieznany item");
  await fails("items only on material orders", () => client.query("INSERT INTO order_items (order_id, item_no, quantity) VALUES ($1, $2, 1)", [water.id, cat[0].item_no]), "tylko do zamówienia materiału lub szpul");

  // --- spool order: line + items, no production order number ---
  await fails("spool order must not have a 'from'", () => insert("spool_order", { from_location: "SH01", to_location: "SH02" }), "orders_type_fields");
  await client.query("SET CONSTRAINTS orders_require_items IMMEDIATE");
  await fails("spool order without items refused", () => insert("spool_order", { to_location: "SH04" }), "co najmniej jedną pozycję");
  await client.query("SET CONSTRAINTS orders_require_items DEFERRED");
  const spool = (await insert("spool_order", { to_location: "SH04" })).rows[0];
  // "1610" is not an sm_catalog item number - proves the catalog isn't
  // consulted for spool orders (unlike material orders, which would refuse
  // an unknown one).
  await client.query("INSERT INTO order_items (order_id, item_no, item_name, quantity) VALUES ($1, '1610', 'Szpula 1610', 10)", [spool.id]);
  await client.query("SET CONSTRAINTS orders_require_items IMMEDIATE");
  const { rows: spoolItems } = await client.query("SELECT * FROM order_items WHERE order_id = $1", [spool.id]);
  check("spool order item: unit forced to szt., name kept as sent (no catalog lookup)", spoolItems.length === 1 && spoolItems[0].unit === "szt." && spoolItems[0].item_name === "Szpula 1610", JSON.stringify(spoolItems[0]));
  await fails("spool order item needs a name", () => client.query("INSERT INTO order_items (order_id, item_no, quantity) VALUES ($1, '1611', 5)", [spool.id]), "nazwę/typ szpuli");
  await client.query("SET CONSTRAINTS orders_require_items DEFERRED");

  // --- client_order_no: a separate, optional field from order_no (ours) and
  // details->>'production_order_no' (material_order's own, for CIP) ---
  const withClientRef = (await insert("waste_removal", { from_location: "SH05" })).rows[0];
  await client.query("UPDATE orders SET client_order_no = 'KL-2026-0042' WHERE id = $1", [withClientRef.id]);
  const { rows: refRow } = await client.query("SELECT client_order_no FROM orders WHERE id = $1", [withClientRef.id]);
  check("client_order_no stored independently of order_no", refRow[0].client_order_no === "KL-2026-0042" && withClientRef.order_no !== "KL-2026-0042", refRow[0].client_order_no);

  // --- line_material_rules: a standing "issue short lengths first" style note ---
  await fails("rule refused on a non-line place", () => client.query("INSERT INTO line_material_rules (line_name, item_no, note) VALUES ('Hala magazynowa 2', $1, 'x')", [cat[0].item_no]), "nie jest linią produkcyjną");
  await client.query("INSERT INTO line_material_rules (line_name, item_no, note) VALUES ('SH02', $1, 'Krótkie odcinki - wydawaj w pierwszej kolejności')", [cat[0].item_no]);
  const ruled = (await insert("material_order", { to_location: "SH02", details: { production_order_no: "ZP-2" } })).rows[0];
  await client.query("INSERT INTO order_items (order_id, item_no, quantity) VALUES ($1, $2, 4)", [ruled.id, cat[0].item_no]);
  const unruled = (await insert("material_order", { to_location: "SH03", details: { production_order_no: "ZP-3" } })).rows[0];
  await client.query("INSERT INTO order_items (order_id, item_no, quantity) VALUES ($1, $2, 4)", [unruled.id, cat[0].item_no]);
  await client.query("SET CONSTRAINTS orders_require_items IMMEDIATE");
  const { rows: notes } = await client.query(
    "SELECT order_id, rule_note FROM order_items_with_notes WHERE order_id = ANY($1) ORDER BY order_id",
    [[ruled.id, unruled.id]]
  );
  check(
    "order_items_with_notes: same item shows the note only on the line the rule is for",
    notes.find((n) => n.order_id === ruled.id)?.rule_note?.startsWith("Krótkie odcinki") && notes.find((n) => n.order_id === unruled.id)?.rule_note === null,
    JSON.stringify(notes)
  );
  await client.query("SET CONSTRAINTS orders_require_items DEFERRED");

  // --- status flow ---
  await fails("done needs completed_by", () => client.query("UPDATE orders SET status = 'done' WHERE id = $1", [water.id]), "orders_status_fields");
  await client.query("UPDATE orders SET status = 'in_progress', taken_by = '4605021' WHERE id = $1", [water.id]);
  const { rows: done } = await client.query(
    "UPDATE orders SET status = 'done', completed_by = '4605021', completed_at = ($2::timestamp) AT TIME ZONE 'Europe/Warsaw' WHERE id = $1 RETURNING *",
    [water.id, "2026-09-25 07:20"]);
  check("done: fulfilling shift derived from completion time", done[0].completed_shift_code === "A", `${done[0].completed_shift_code} ${done[0].completed_shift_date.toLocaleDateString("sv")}`);
  await fails("closed order is frozen", () => client.query("UPDATE orders SET note = 'x' WHERE id = $1", [water.id]), "zamknięte");
  const other = (await insert("warehouse_return", { from_location: "FC02" })).rows[0];
  await fails("cannot go back to new", () => client.query("UPDATE orders SET status = 'new' WHERE id = $1", [done[0].id]), "Niedozwolona zmiana statusu");
  await client.query("UPDATE orders SET status = 'cancelled', cancel_reason = 'test' WHERE id = $1", [other.id]);
  check("new -> cancelled allowed, timestamp filled", true);
  await fails("immutable fields", () => client.query("UPDATE orders SET requested_by = 'x' WHERE id = $1", [mat.id]), "nie można zmienić");

  await client.query("SET CONSTRAINTS orders_require_items DEFERRED");
} catch (err) {
  console.error("SCRIPT ERROR:", err.message);
  failures += 1;
} finally {
  await client.query("ROLLBACK");
  client.release();
  await pool.end();
}
console.log(failures === 0 ? "\nALL CHECKS PASSED (transaction rolled back)" : `\n${failures} CHECK(S) FAILED (transaction rolled back)`);
process.exit(failures === 0 ? 0 : 1);
