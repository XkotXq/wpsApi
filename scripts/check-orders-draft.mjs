// Check of src/orders.draft.sql (run: node scripts/check-orders-draft.mjs): runs it inside a transaction against
// the dev database, asserts the rules, then ROLLS BACK - nothing is kept.
import { config } from "dotenv";
import fs from "fs";
config({ path: ".env" });
const { pool } = await import("../src/db.js");

const sql = fs.readFileSync(new URL("../src/orders.draft.sql", import.meta.url), "utf8");
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
  check("order number format", /^C415\/260924\/\d{3}$/.test(water.order_no), water.order_no);
  check("shift columns", water.shift_code === "C" && String(water.shift_date.toLocaleDateString("sv")) === "2026-09-24");

  const many = new Set();
  for (let i = 0; i < 300; i += 1) {
    many.add((await insert("waste_removal", { from_location: "ST02", created_at: "2026-09-24T14:37:00+02:00" })).rows[0].order_no);
  }
  check("300 orders in the same minute all unique", many.size === 300, `${many.size} distinct`);

  // --- required fields per type ---
  await fails("water without kind refused", () => insert("water_refill", { to_location: "SH01" }), "orders_type_fields");
  await fails("water with bad kind refused", () => insert("water_refill", { to_location: "SH01", details: { water: "muddy" } }), "orders_type_fields");
  await fails("transport needs from and to", () => insert("goods_transport", { from_location: "SH01" }), "orders_type_fields");
  await fails("waste must not have a destination", () => insert("waste_removal", { from_location: "SH01", to_location: "SH02" }), "orders_type_fields");
  await fails("unknown line refused", () => insert("machine_transport", { from_location: "XX99", to_location: "SH02" }), "violates foreign key");
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
  check("item name/unit filled from catalog", items[0].item_name === cat[0].item_name && items[0].unit === cat[0].unit, `${items[0].item_name} / ${items[0].unit}`);
  await fails("unknown item refused", () => client.query("INSERT INTO order_items (order_id, item_no, quantity) VALUES ($1, '000', 1)", [mat.id]), "Nieznany item");
  await fails("items only on material orders", () => client.query("INSERT INTO order_items (order_id, item_no, quantity) VALUES ($1, $2, 1)", [water.id, cat[0].item_no]), "tylko do zamówienia materiału");

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
