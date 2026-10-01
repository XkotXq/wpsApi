// Regression check: **every** order type goes through the same
// delivered -> confirm / report-problem path, not just the ones with items.
// An order with no items (water_refill, goods_transport, waste_removal,
// warehouse_return) is deliverable as soon as it is taken; one with items
// still needs them all issued first. See deliverOrder in src/orders.js.
// Run (dev API up): node scripts/check-delivery-flow.mjs
import { config } from "dotenv";
import { randomUUID } from "node:crypto";
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
const must = async (path, opts) => {
  const r = await api(path, opts);
  if (!r.ok) throw new Error(`${opts?.method ?? "GET"} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`);
};

// One case per type offered in wps's "Nowe zamówienie" menu.
const CASES = [
  { type: "water_refill", body: { to: "SH01", details: { water: "clean" } } },
  { type: "goods_transport", body: { from: "ST04", to: "SH02" } },
  { type: "waste_removal", body: { from: "SH03" } },
  { type: "warehouse_return", body: { from: "SH04" } },
  { type: "spool_order", body: { to: "SH05" }, items: [{ itemNo: "1610", itemName: "Szpula 1610", quantity: "2", unit: "szt." }] },
  { type: "material_order", body: { to: "SH06", details: { productionOrderNo: "T-FLOW" } }, fromCatalog: true },
];

const made = [];
try {
  const { rows: cat } = await pool.query("SELECT item_no, item_name FROM sm_catalog ORDER BY item_no LIMIT 1");

  for (const c of CASES) {
    const items = c.fromCatalog
      ? [{ itemNo: cat[0].item_no, itemName: cat[0].item_name, quantity: "1", unit: "szt." }]
      : (c.items ?? []);
    const order = await must("/orders", {
      method: "POST",
      body: { type: c.type, employeeNo: "T-FLOW", ...c.body, items },
    });
    made.push(order.id);

    await must(`/orders/${order.id}/take`, { method: "POST", body: { takenBy: "T-FORK" } });

    if (items.length) {
      // With items, delivery must still be refused until they are issued.
      const early = await api(`/orders/${order.id}/deliver`, { method: "POST", body: { deliveredBy: "T-FORK" } });
      check(`${c.type}: delivery refused while items are unissued`, early.status === 400, `HTTP ${early.status}`);
      for (const item of items) {
        await pool.query(
          `INSERT INTO sm_operations (id, operation, item_no, item_name, quantity, order_id, performed_by)
           VALUES ($1, 'issue', $2, $3, $4, $5, 'T-FORK')`,
          [randomUUID(), item.itemNo, item.itemName, item.quantity, order.id]
        );
      }
    }

    const delivered = await must(`/orders/${order.id}/deliver`, { method: "POST", body: { deliveredBy: "T-FORK" } });
    check(`${c.type}: can be delivered`, delivered.status === "delivered", delivered.status);
    check(`${c.type}: starts the confirmation countdown`, delivered.autoAcceptInSeconds > 0, `${delivered.autoAcceptInSeconds}s`);

    // The requester's half, the same for every type.
    const closed = await must(`/orders/${order.id}/accept`, { method: "POST", body: { acceptedBy: "T-REQ" } });
    check(`${c.type}: the requester can confirm it`, closed.status === "done", closed.status);
    check(`${c.type}: credited to the forklift operator`, closed.fulfilledBy === "T-FORK", closed.fulfilledBy);
  }

  // And the other half of the requester's choice, once, on an item-less type.
  const problem = await must("/orders", {
    method: "POST",
    body: { type: "water_refill", employeeNo: "T-FLOW", to: "SH07", details: { water: "dirty" }, items: [] },
  });
  made.push(problem.id);
  await must(`/orders/${problem.id}/take`, { method: "POST", body: { takenBy: "T-FORK" } });
  await must(`/orders/${problem.id}/deliver`, { method: "POST", body: { deliveredBy: "T-FORK" } });
  // Reporting a problem on an item-less type goes through the same loop as
  // everything else - and must **not** cancel the order (it did until
  // 2026-10-01, which is the bug this asserts against).
  const reported = await must(`/orders/${problem.id}/problem`, {
    method: "POST",
    body: { reportedBy: "T-REQ", note: "Rozlane" },
  });
  check("report-problem works on an item-less type too", reported.status === "problem", reported.status);
  check("and keeps the description", reported.problemNote === "Rozlane", reported.problemNote);
  check("it is not cancelled", reported.cancelledAt == null, String(reported.cancelledAt));
  // Cancelling a started order is refused outright, whoever asks.
  const refused = await api(`/orders/${problem.id}/cancel`, { method: "POST", body: { reason: "mimo wszystko" } });
  check("a started order cannot be cancelled", refused.status === 400, `HTTP ${refused.status}`);
} finally {
  for (const id of made) {
    await pool.query("DELETE FROM sm_operations WHERE order_id = $1", [id]);
    await pool.query("DELETE FROM order_items WHERE order_id = $1", [id]);
    await pool.query("DELETE FROM orders WHERE id = $1", [id]);
  }
  console.log(`\ncleaned up ${made.length} test orders`);
  await pool.end();
}

console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
