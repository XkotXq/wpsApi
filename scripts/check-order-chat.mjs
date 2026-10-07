// Regression check for the chat on an order: the thread, incremental
// polling (?afterId=), the message count on the order, and the refusals.
// See listOrderMessages/createOrderMessage in src/orders.js.
// Run (dev API up): node scripts/check-order-chat.mjs
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

let id;
try {
  const order = await must("/orders", {
    method: "POST",
    body: { type: "water_refill", employeeNo: "T-REQ", to: "ST13", details: { water: "clean" } },
  });
  id = order.id;
  check("a new order has no messages", order.messageCount === 0, String(order.messageCount));
  check("and an empty thread", (await must(`/orders/${id}/messages`)).length === 0);

  const first = await must(`/orders/${id}/messages`, {
    method: "POST",
    body: { author: "T-FORK", body: "Zastawione paletami" },
  });
  check("a message keeps its author and text", first.author === "T-FORK" && first.body === "Zastawione paletami");
  const second = await must(`/orders/${id}/messages`, { method: "POST", body: { author: "T-REQ", body: "Już zwalniam" } });

  const thread = await must(`/orders/${id}/messages`);
  check("the thread is oldest first", thread.map((m) => m.author).join(" > ") === "T-FORK > T-REQ", thread.map((m) => m.author).join(" > "));

  // What the chat screen polls with every second: only what is newer.
  const after = await must(`/orders/${id}/messages?afterId=${first.id}`);
  check("afterId returns only what is newer", after.length === 1 && after[0].id === second.id, `${after.length} message(s)`);
  check("afterId at the end returns nothing", (await must(`/orders/${id}/messages?afterId=${second.id}`)).length === 0);

  check("the order carries the count", (await must(`/orders/${id}`)).messageCount === 2);
  check(
    "and so does the list",
    (await must("/orders?scope=active")).find((o) => o.id === id)?.messageCount === 2
  );
  // An action's own response must carry it too, or a client's badge blinks
  // back to nothing the moment somebody presses a button.
  const taken = await must(`/orders/${id}/take`, { method: "POST", body: { takenBy: "T-FORK" } });
  check("an action response carries the count", taken.messageCount === 2, String(taken.messageCount));

  const blank = await api(`/orders/${id}/messages`, { method: "POST", body: { author: "T-FORK", body: "   " } });
  check("an empty message is refused", blank.status === 400, `HTTP ${blank.status}`);
  const noAuthor = await api(`/orders/${id}/messages`, { method: "POST", body: { body: "hej" } });
  check("a message with no author is refused", noAuthor.status === 400, `HTTP ${noAuthor.status}`);
  const badCursor = await api(`/orders/${id}/messages?afterId=abc`);
  check("a nonsense cursor is refused", badCursor.status === 400, `HTTP ${badCursor.status}`);
  const tooLong = await api(`/orders/${id}/messages`, { method: "POST", body: { author: "T-FORK", body: "x".repeat(2001) } });
  check("an overlong message is refused", tooLong.status === 400, `HTTP ${tooLong.status}`);
  const noOrder = await api("/orders/999999999/messages", { method: "POST", body: { author: "T-FORK", body: "hej" } });
  check("a message to a missing order is refused", noOrder.status === 404, `HTTP ${noOrder.status}`);

  // Chat stays open on a closed order: people explain things after the fact,
  // and a message is not a state change.
  await must(`/orders/${id}/deliver`, { method: "POST", body: { deliveredBy: "T-FORK" } });
  await must(`/orders/${id}/accept`, { method: "POST", body: { acceptedBy: "T-REQ" } });
  const afterClose = await api(`/orders/${id}/messages`, { method: "POST", body: { author: "T-REQ", body: "Dzięki" } });
  check("a closed order can still be written to", afterClose.status === 201, `HTTP ${afterClose.status}`);
} finally {
  if (id) {
    // ON DELETE CASCADE takes the thread with it - asserted here rather than
    // assumed, since the cleanup would hide a missing FK.
    await pool.query("DELETE FROM orders WHERE id = $1", [id]);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM order_messages WHERE order_id = $1", [id]);
    check("deleting the order takes its messages", rows[0].n === 0, String(rows[0].n));
  }
  console.log("\ncleaned up the test order and its thread");
  await pool.end();
  console.log(failures ? `${failures} CHECK(S) FAILED` : "ALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}
