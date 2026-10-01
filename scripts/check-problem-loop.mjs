// Regression check for the problem loop: the forklift operator gets stuck,
// the requester sorts it out, work resumes - possibly more than once - and
// the whole episode stays reconstructible from order_events.
// See reportOrderProblem/resolveOrderProblem in src/orders.js.
// Run (dev API up): node scripts/check-problem-loop.mjs
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

let id = null;
try {
  const order = await must("/orders", {
    method: "POST",
    body: { type: "water_refill", employeeNo: "T-REQ", to: "SH01", details: { water: "clean" } },
  });
  id = order.id;
  await must(`/orders/${id}/take`, { method: "POST", body: { takenBy: "T-FORK" } });

  // --- the forklift operator is stuck ---
  const stuck = await must(`/orders/${id}/problem`, {
    method: "POST",
    body: { reportedBy: "T-FORK", note: "Zastawione paletami" },
  });
  check("order is flagged as a problem, not cancelled", stuck.status === "problem", stuck.status);
  check("what is wrong is on the order", stuck.problemNote === "Zastawione paletami", stuck.problemNote);
  check("who reported it", stuck.problemReportedBy === "T-FORK", stuck.problemReportedBy);
  // Who has to answer it. The row looks the same whichever side reported,
  // so this is the only thing a client can tell them apart by - and getting
  // it wrong means offering the resolve button to the person who reported.
  check("the requester is the one who must answer", stuck.problemReportedFrom === "inProgress", stuck.problemReportedFrom);
  check("it stays on the active list", (await must("/orders?scope=active")).some((o) => o.id === id));

  const blank = await api(`/orders/${id}/problem`, { method: "POST", body: { reportedBy: "T-FORK" } });
  check("a problem without a description is refused", blank.status === 400, `HTTP ${blank.status}`);

  // Delivery must be impossible while a problem is open.
  const earlyDeliver = await api(`/orders/${id}/deliver`, { method: "POST", body: { deliveredBy: "T-FORK" } });
  check("cannot deliver while a problem is open", earlyDeliver.status === 400, `HTTP ${earlyDeliver.status}`);

  // --- the requester sorts it out ---
  const resumed = await must(`/orders/${id}/problem/resolve`, {
    method: "POST",
    body: { resolvedBy: "T-REQ", note: "Przejazd zwolniony" },
  });
  check("resolving puts it back to work", resumed.status === "inProgress", resumed.status);
  check("the blocking note is cleared", resumed.problemNote === "", JSON.stringify(resumed.problemNote));
  check("who resolved it is kept", resumed.problemResolvedBy === "T-REQ", resumed.problemResolvedBy);
  check("nothing is pending any more", resumed.problemReportedFrom === "", JSON.stringify(resumed.problemReportedFrom));

  // --- and again, because this can loop ---
  await must(`/orders/${id}/problem`, { method: "POST", body: { reportedBy: "T-FORK", note: "Znowu zastawione" } });
  await must(`/orders/${id}/problem/resolve`, { method: "POST", body: { resolvedBy: "T-REQ" } });

  // --- the other direction: the requester rejects what arrived ---
  // This used to be a cancellation (POST /:id/cancel), which ended the order
  // and left nobody to answer. It is the same loop as above, mirrored: the
  // *operator* is the one who has to answer it.
  const delivered = await must(`/orders/${id}/deliver`, { method: "POST", body: { deliveredBy: "T-FORK" } });
  check("delivery works once nothing is blocking", delivered.status === "delivered", delivered.status);

  const rejected = await must(`/orders/${id}/problem`, {
    method: "POST",
    body: { reportedBy: "T-REQ", note: "Nie ten materiał" },
  });
  check("a rejected delivery is a problem, not a cancellation", rejected.status === "problem", rejected.status);
  check("the operator is the one who must answer", rejected.problemReportedFrom === "delivered", rejected.problemReportedFrom);
  // The handover is disputed, so it did not happen - which also takes the
  // order out of the auto-accept sweep, or it would close a delivery that
  // was just rejected.
  check("the delivery is undone", rejected.deliveredAt == null && rejected.deliveredBy == null, `${rejected.deliveredAt} / ${rejected.deliveredBy}`);
  check("no auto-accept countdown while blocked", rejected.autoAcceptInSeconds == null, String(rejected.autoAcceptInSeconds));
  check("it is still open", (await must("/orders?scope=active")).some((o) => o.id === id));

  const corrected = await must(`/orders/${id}/problem/resolve`, {
    method: "POST",
    body: { resolvedBy: "T-FORK", note: "Wymieniony na właściwy" },
  });
  check("the operator's answer resumes the work", corrected.status === "inProgress", corrected.status);
  const redelivered = await must(`/orders/${id}/deliver`, { method: "POST", body: { deliveredBy: "T-FORK" } });
  check("and it is delivered again", redelivered.status === "delivered", redelivered.status);

  // --- then the normal ending ---
  await must(`/orders/${id}/accept`, { method: "POST", body: { acceptedBy: "T-REQ" } });

  // --- is the whole thing reconstructible? ---
  const events = await must(`/orders/${id}/events`);
  const kinds = events.map((e) => e.kind).join(" > ");
  check(
    "every step is in the timeline, in order",
    kinds ===
      "created > inProgress > problem > inProgress > problem > inProgress > delivered > problem > inProgress > delivered > done",
    kinds
  );
  check(
    "every problem description survives, from both sides",
    events.filter((e) => e.kind === "problem").map((e) => e.note).join(" | ") ===
      "Zastawione paletami | Znowu zastawione | Nie ten materiał"
  );
  check(
    "the timeline says who reported each problem",
    events.filter((e) => e.kind === "problem").map((e) => e.actor).join(" | ") === "T-FORK | T-FORK | T-REQ"
  );
  check("the resolution note survives", events.some((e) => e.kind === "inProgress" && e.note === "Przejazd zwolniony"));
  check("the timeline names who did what", events.find((e) => e.kind === "delivered")?.actor === "T-FORK");
  check("timestamps are ascending", events.every((e, i, a) => i === 0 || new Date(a[i - 1].at) <= new Date(e.at)));
} finally {
  if (id) {
    await pool.query("DELETE FROM order_events WHERE order_id = $1", [id]);
    await pool.query("DELETE FROM orders WHERE id = $1", [id]);
  }
  console.log("\ncleaned up the test order and its events");
  await pool.end();
}

console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
