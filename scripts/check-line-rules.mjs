// Regression check for "Wytyczne do transportów" (line_material_rules) and
// how they reach an order: a material-specific rule rides on the matching
// order item (`ruleNote`), a line-wide one (item_no IS NULL) on the order
// itself (`lineRuleNote`). See src/lineMaterialRules.js and
// order_items_progress in src/schema.sql.
// Run (dev API up): node scripts/check-line-rules.mjs
import { config } from "dotenv";
config({ path: ".env" });
const { pool } = await import("../src/db.js");

const BASE = "http://localhost:4000/api";
const TOKEN = process.env.API_TOKEN;
const api = async (p, { method = "GET", body } = {}) => {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
};

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`);
};

const LINE = "ST13"; // a real production line, unlikely to carry live rules
const madeRules = [];
let orderId = null;
let otherOrderId = null;
try {
  const { rows: cat } = await pool.query("SELECT item_no, item_name FROM sm_catalog ORDER BY item_no LIMIT 2");
  const [ruled, plain] = cat;

  // Clear anything already on this line so the assertions are about us.
  await pool.query("DELETE FROM line_material_rules WHERE line_name = $1", [LINE]);

  const itemRule = await api("/line-material-rules", {
    method: "POST",
    body: { lineName: LINE, itemNo: ruled.item_no, note: "Krótkie odcinki najpierw" },
  });
  madeRules.push(itemRule.id);
  check("material rule saved with its item", itemRule.itemNo === ruled.item_no, itemRule.itemNo);

  const lineRule = await api("/line-material-rules", {
    method: "POST",
    body: { lineName: LINE, note: "Wjazd od strony hali B" },
  });
  madeRules.push(lineRule.id);
  check("line-wide rule saved with no item", lineRule.itemNo === null, String(lineRule.itemNo));

  // Saving a line-wide rule again must replace the note, not add a second.
  const replaced = await api("/line-material-rules", {
    method: "POST",
    body: { lineName: LINE, note: "Wjazd od strony hali C" },
  });
  check("re-saving a line-wide rule replaces it", replaced.id === lineRule.id, `${lineRule.id} -> ${replaced.id}`);
  const { rows: lineWide } = await pool.query(
    "SELECT count(*)::int AS n FROM line_material_rules WHERE line_name = $1 AND item_no IS NULL",
    [LINE]
  );
  check("exactly one line-wide rule per line", lineWide[0].n === 1, `${lineWide[0].n} rows`);

  // An order to that line with one ruled and one unruled material.
  const order = await api("/orders", {
    method: "POST",
    body: {
      type: "material_order",
      to: LINE,
      details: { productionOrderNo: "T-RULES" },
      employeeNo: "T-REQ",
      items: [
        { itemNo: ruled.item_no, itemName: ruled.item_name, quantity: "1", unit: "szt." },
        { itemNo: plain.item_no, itemName: plain.item_name, quantity: "1", unit: "szt." },
      ],
    },
  });
  orderId = order.id;
  check("order carries the line-wide note", order.lineRuleNote === "Wjazd od strony hali C", order.lineRuleNote);

  const fetched = await api(`/orders/${orderId}`);
  const ruledItem = fetched.items.find((i) => i.itemNo === ruled.item_no);
  const plainItem = fetched.items.find((i) => i.itemNo === plain.item_no);
  check("ruled item carries its own note", ruledItem.ruleNote === "Krótkie odcinki najpierw", ruledItem.ruleNote);
  check("unruled item carries none", plainItem.ruleNote === "", JSON.stringify(plainItem.ruleNote));
  check("the line-wide note is not repeated per item", !fetched.items.some((i) => i.ruleNote.includes("hali")), "ok");
  check("it is on the order in the list too", (await api("/orders?scope=active")).find((o) => o.id === orderId)?.lineRuleNote === "Wjazd od strony hali C");

  // Editing a rule must show up on an order already placed - the whole
  // point of these being reference data rather than copied onto the order.
  await api("/line-material-rules", { method: "POST", body: { lineName: LINE, note: "Zmienione" } });
  check("an edited rule reaches an existing order", (await api(`/orders/${orderId}`)).lineRuleNote === "Zmienione");

  // Items must not be duplicated by the new joins in the view.
  check("no row multiplication from the rule join", fetched.items.length === 2, `${fetched.items.length} items`);

  // ── A guideline about a kind of transport (2026-10-07) ──────────────────
  // A rule can name an order type instead of - or as well as - a line, so
  // these cover the scopes the old pair of cases could not express.
  // Only type-scoped rules: the line+item rule created above is one of the
  // two the specificity assertion below compares, so clearing it here would
  // make that check pass or fail for the wrong reason.
  // Type rules from an earlier run, plus this line own line-wide rule -
  // that one would win every order-level assertion below (a line beats a
  // type on purpose). The line+item rule stays: it is one of the two the
  // item specificity check compares.
  await pool.query(
    "DELETE FROM line_material_rules WHERE order_type IS NOT NULL OR (line_name = $1 AND item_no IS NULL)",
    [LINE]
  );

  const typeRule = await api("/line-material-rules", {
    method: "POST",
    body: { orderType: "material_order", note: "Każde zamówienie materiału: potwierdź u brygadzisty" },
  });
  madeRules.push(typeRule.id);
  check("type-only rule saves with no line", typeRule.lineName === null && typeRule.orderType === "material_order",
    `${typeRule.lineName} / ${typeRule.orderType}`);

  check("a type rule reaches an order of that type",
    (await api(`/orders/${orderId}`)).lineRuleNote === "Każde zamówienie materiału: potwierdź u brygadzisty");

  // An order of a different type must not pick it up. water_refill takes a
  // line and nothing else, so it is the cheapest second order to place.
  const other = await api("/orders", {
    method: "POST",
    body: { type: "water_refill", employeeNo: "CHECK", to: LINE, details: { water: "clean" }, note: "check" },
  });
  otherOrderId = other.id;
  check("it does not reach an order of another type", other.lineRuleNote === "", JSON.stringify(other.lineRuleNote));

  // Specificity: naming both a line and a type beats naming only the type.
  const bothRule = await api("/line-material-rules", {
    method: "POST",
    body: { lineName: LINE, orderType: "material_order", note: "Tylko na ST13 i tylko materiały" },
  });
  madeRules.push(bothRule.id);
  check("the more specific rule wins",
    (await api(`/orders/${orderId}`)).lineRuleNote === "Tylko na ST13 i tylko materiały",
    (await api(`/orders/${orderId}`)).lineRuleNote);

  // Two rules matching one item must still yield one row, not two.
  const itemTypeRule = await api("/line-material-rules", {
    method: "POST",
    body: { itemNo: ruled.item_no, orderType: "material_order", note: "Reguła materiału po typie" },
  });
  madeRules.push(itemTypeRule.id);
  const afterBoth = await api(`/orders/${orderId}`);
  check("an item matching two rules is still one row", afterBoth.items.length === 2, `${afterBoth.items.length} items`);
  check("the item takes the more specific of them",
    afterBoth.items.find((i) => i.itemNo === ruled.item_no)?.ruleNote === "Krótkie odcinki najpierw",
    afterBoth.items.find((i) => i.itemNo === ruled.item_no)?.ruleNote);

  // A rule naming nothing at all would apply to every transport - refused.
  let refused = false;
  try {
    await api("/line-material-rules", { method: "POST", body: { note: "Dotyczy wszystkiego" } });
  } catch {
    refused = true;
  }
  check("a rule with no scope at all is refused", refused);
} finally {
  for (const id of [orderId, otherOrderId]) {
    if (!id) continue;
    await pool.query("DELETE FROM order_items WHERE order_id = $1", [id]);
    await pool.query("DELETE FROM orders WHERE id = $1", [id]);
  }
  // Type-scoped rules have no line, so the old line-only cleanup would have
  // left them behind to affect every later run - and every real order.
  await pool.query("DELETE FROM line_material_rules WHERE line_name = $1 OR id = ANY($2::bigint[])", [LINE, madeRules]);
  console.log("\ncleaned up the test order and every rule on " + LINE);
  await pool.end();
}

console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
