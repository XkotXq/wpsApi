// Regression check for the paged history scope: walking it page by page
// must return every order exactly once, in the same order as the unpaged
// list - which is what smVendor's HistoryNotifier and smOrder's own
// _loadMore do. A paging bug is silent (a row nobody notices is missing),
// so it is worth asserting rather than eyeballing.
// See listOrders in src/orders.js.
// Run (dev API up): node scripts/check-order-paging.mjs
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

const REQ = "T-PAGE";
const PAGE = 4;
const MADE = 11; // not a multiple of PAGE on purpose - the last page is short
try {
  // Closed orders, so they land in the history scope. All in the same
  // minute: created_at ties are exactly where a cursor on the timestamp
  // alone would skip or repeat rows, which is why the cursor carries the id
  // as well.
  const at = "2026-03-02T10:15:00+01:00";
  const ids = [];
  for (let i = 0; i < MADE; i += 1) {
    const { rows } = await pool.query(
      `INSERT INTO orders (type, requested_by, to_location, details, created_at, status, taken_by, taken_at, completed_by, completed_at)
       VALUES ('water_refill', $1, 'SH01', '{"water":"clean"}', $2, 'done', 'T-FORK', $2, 'T-FORK', $2)
       RETURNING id`,
      [REQ, at]
    );
    ids.push(String(rows[0].id));
  }
  check(`${MADE} finished orders in one minute`, ids.length === MADE);

  const all = await must("/orders?scope=history");
  const mineAll = all.filter((o) => o.employeeNo === REQ).map((o) => o.id);
  check("they are all in the unpaged history", mineAll.length === MADE, `${mineAll.length}`);

  // Walk it the way the clients do: cursor = the last order already held.
  const walked = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    const query = cursor
      ? `/orders?scope=history&limit=${PAGE}&beforeCreatedAt=${encodeURIComponent(cursor.createdAt)}&beforeId=${cursor.id}`
      : `/orders?scope=history&limit=${PAGE}`;
    const page = await must(query);
    pages += 1;
    walked.push(...page);
    if (page.length < PAGE) break;
    cursor = page[page.length - 1];
    if (pages > 50) throw new Error("paging did not terminate");
  }
  check("a short page ends the walk", pages >= 3, `${pages} page(s)`);

  const walkedIds = walked.map((o) => o.id);
  check("no duplicates across pages", new Set(walkedIds).size === walkedIds.length, `${walkedIds.length} rows`);
  check(
    "the walk is the unpaged list, in the same order",
    walkedIds.join(",") === all.map((o) => o.id).join(","),
    `${walkedIds.length} vs ${all.length}`
  );
  check(
    "and it contains every one of ours",
    mineAll.every((id) => walkedIds.includes(id))
  );

  // A page is the head of the list, not a random slice.
  const first = await must(`/orders?scope=history&limit=3`);
  check("the first page is the newest three", first.map((o) => o.id).join(",") === all.slice(0, 3).map((o) => o.id).join(","));

  const past = all[all.length - 1];
  const beyond = await must(
    `/orders?scope=history&limit=${PAGE}&beforeCreatedAt=${encodeURIComponent(past.createdAt)}&beforeId=${past.id}`
  );
  check("past the oldest order there is nothing", beyond.length === 0, `${beyond.length}`);

  const refused = await api("/orders?scope=history&limit=0");
  check("a nonsense page size is refused", refused.status === 400, `HTTP ${refused.status}`);
} finally {
  const { rowCount } = await pool.query("DELETE FROM orders WHERE requested_by = $1", [REQ]);
  console.log(`\ncleaned up ${rowCount} test orders`);
  await pool.end();
  console.log(failures ? `${failures} CHECK(S) FAILED` : "ALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
}
