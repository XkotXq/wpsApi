// Regression check for editing and deleting one's own order: only while
// nobody has started it, only by the person who placed it, and hidden from
// the forklift queue (and untakeable) while the form is open.
// See startOrderEdit/updateOrder/deleteOrder in src/orders.js.
// Run (dev API up): node scripts/check-order-edit.mjs
import { config } from "dotenv";
config({ path: ".env" });
const { pool } = await import("../src/db.js");

const BASE = "http://localhost:4000/api";
const TOKEN = process.env.API_TOKEN;
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text ? JSON.parse(text) : null };
}
const must = async (p, o) => {
  const r = await api(p, o);
  if (!r.ok) throw new Error(`${o?.method ?? "GET"} ${p} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`);
};

const REQ = "T-EDIT";
const made = [];
try {
  const { rows: cat } = await pool.query("SELECT item_no, item_name FROM sm_catalog ORDER BY item_no LIMIT 2");

  // --- editing a material order: places, note and the item list ---
  const order = await must("/orders", {
    method: "POST",
    body: {
      type: "material_order",
      employeeNo: REQ,
      to: "SH02",
      details: { productionOrderNo: "T-EDIT-1" },
      note: "pierwsza wersja",
      items: [{ itemNo: cat[0].item_no, itemName: cat[0].item_name, quantity: "2", unit: "szt." }],
    },
  });
  made.push(order.id);
  check("placed with one item", order.items.length === 1 && order.note === "pierwsza wersja");
  check("not being edited yet", order.editing === false, String(order.editing));

  const locked = await must(`/orders/${order.id}/edit/start`, { method: "POST", body: { employeeNo: REQ } });
  check("taking the lock marks it as being edited", locked.editing === true && locked.editingBy === REQ);

  // The whole point: while it is being edited the forklift cannot take it.
  const blocked = await api(`/orders/${order.id}/take`, { method: "POST", body: { takenBy: "T-FORK" } });
  check("it cannot be taken while being edited", blocked.status === 409, `HTTP ${blocked.status} ${blocked.body?.error ?? ""}`);

  const edited = await must(`/orders/${order.id}`, {
    method: "PATCH",
    body: {
      employeeNo: REQ,
      to: "SH03",
      details: { productionOrderNo: "T-EDIT-2" },
      note: "druga wersja",
      items: [
        { itemNo: cat[0].item_no, itemName: cat[0].item_name, quantity: "5", unit: "szt." },
        { itemNo: cat[1].item_no, itemName: cat[1].item_name, quantity: "1", unit: "szt." },
      ],
    },
  });
  check("the place changed", edited.to === "SH03", edited.to);
  check("the production order changed", edited.details?.productionOrderNo === "T-EDIT-2", edited.details?.productionOrderNo);
  check("the note changed", edited.note === "druga wersja", edited.note);
  check("the item list was replaced", edited.items.length === 2, `${edited.items.length} item(s)`);
  check(
    "including a changed quantity",
    edited.items.find((i) => i.itemNo === cat[0].item_no)?.quantity === "5",
    edited.items.map((i) => `${i.itemNo}:${i.quantity}`).join(", ")
  );
  check("saving releases the lock", edited.editing === false, String(edited.editing));
  check("the number did not change", edited.orderNo === order.orderNo, `${order.orderNo} -> ${edited.orderNo}`);

  // ...and now it can be taken again.
  const takenNow = await must(`/orders/${order.id}/take`, { method: "POST", body: { takenBy: "T-FORK" } });
  check("takeable once the edit is done", takenNow.status === "inProgress", takenNow.status);

  // --- once started, it is frozen ---
  const lateEdit = await api(`/orders/${order.id}`, { method: "PATCH", body: { employeeNo: REQ, to: "SH04" } });
  check("a started order cannot be edited", lateEdit.status === 409, `HTTP ${lateEdit.status}`);
  const lateLock = await api(`/orders/${order.id}/edit/start`, { method: "POST", body: { employeeNo: REQ } });
  check("nor locked for editing", lateLock.status === 409, `HTTP ${lateLock.status}`);
  const lateDelete = await api(`/orders/${order.id}`, { method: "DELETE", body: { employeeNo: REQ } });
  check("nor deleted", lateDelete.status === 409, `HTTP ${lateDelete.status}`);

  // --- only the person who placed it ---
  const other = await must("/orders", {
    method: "POST",
    body: { type: "water_refill", employeeNo: REQ, to: "SH05", details: { water: "clean" } },
  });
  made.push(other.id);
  const notMine = await api(`/orders/${other.id}`, { method: "PATCH", body: { employeeNo: "SOMEBODY", to: "SH06" } });
  check("somebody else cannot edit it", notMine.status === 403, `HTTP ${notMine.status}`);
  const notMineDelete = await api(`/orders/${other.id}`, { method: "DELETE", body: { employeeNo: "SOMEBODY" } });
  check("nor delete it", notMineDelete.status === 403, `HTTP ${notMineDelete.status}`);

  // --- abandoning an edit releases the lock ---
  await must(`/orders/${other.id}/edit/start`, { method: "POST", body: { employeeNo: REQ } });
  const released = await must(`/orders/${other.id}/edit/stop`, { method: "POST", body: { employeeNo: REQ } });
  check("leaving the form releases the lock", released.editing === false, String(released.editing));

  // --- a material order cannot be emptied by an edit ---
  const mat = await must("/orders", {
    method: "POST",
    body: {
      type: "material_order",
      employeeNo: REQ,
      to: "SH02",
      details: { productionOrderNo: "T-EDIT-3" },
      items: [{ itemNo: cat[0].item_no, itemName: cat[0].item_name, quantity: "1", unit: "szt." }],
    },
  });
  made.push(mat.id);
  const emptied = await api(`/orders/${mat.id}`, {
    method: "PATCH",
    body: { employeeNo: REQ, to: "SH02", details: { productionOrderNo: "T-EDIT-3" }, items: [] },
  });
  check("an edit may not leave it with no items", emptied.status === 400, `HTTP ${emptied.status}`);
  const stillThere = await must(`/orders/${mat.id}`);
  check("and the original items survived", stillThere.items.length === 1, `${stillThere.items.length} item(s)`);

  // --- deleting one's own, untouched order ---
  const doomed = await must("/orders", {
    method: "POST",
    body: { type: "waste_removal", employeeNo: REQ, from: "SH07" },
  });
  await must(`/orders/${doomed.id}`, { method: "DELETE", body: { employeeNo: REQ } });
  const gone = await api(`/orders/${doomed.id}`);
  check("a deleted order is really gone", gone.status === 404, `HTTP ${gone.status}`);
  const { rows: leftover } = await pool.query("SELECT count(*)::int AS n FROM order_items WHERE order_id = $1", [doomed.id]);
  check("and took its items with it", leftover[0].n === 0, String(leftover[0].n));

  // --- a stale lock stops hiding it ---
  const stale = await must("/orders", {
    method: "POST",
    body: { type: "water_refill", employeeNo: REQ, to: "SH06", details: { water: "dirty" } },
  });
  made.push(stale.id);
  await must(`/orders/${stale.id}/edit/start`, { method: "POST", body: { employeeNo: REQ } });
  // Six minutes ago - past EDIT_LOCK_MINUTES, which is what stops an app
  // killed mid-edit from hiding an order for good.
  await pool.query("UPDATE orders SET editing_at = now() - interval '6 minutes' WHERE id = $1", [stale.id]);
  const afterStale = await must(`/orders/${stale.id}`);
  check("a stale lock does not count", afterStale.editing === false, String(afterStale.editing));
  const takeStale = await must(`/orders/${stale.id}/take`, { method: "POST", body: { takenBy: "T-FORK" } });
  check("and the order can be taken again", takeStale.status === "inProgress", takeStale.status);
} finally {
  for (const id of made) await pool.query("DELETE FROM orders WHERE id = $1", [id]);
  await pool.query("DELETE FROM orders WHERE requested_by = $1", [REQ]);
  console.log("\ncleaned up the test orders");
  await pool.end();
  console.log(failures ? `${failures} CHECK(S) FAILED` : "ALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}
