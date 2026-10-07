// Imports a CIP inventory export ("invList.xlsx": itemNO / itemName /
// specifications / location) into "Materiały SM" - the sm_items stock list.
//
// Re-runnable: it is an overwrite, the same way sm-catalog/import is a sync.
// Every row in the file replaces that item's whole stock record - quantity,
// location and **its unit (spool) breakdown**, which a CIP export knows
// nothing about. That is the point of this import and also its one
// destructive edge, so it writes a timestamped JSON backup of sm_items +
// sm_units first and prints where it went.
//
// Goes through the API rather than straight SQL: that is what enforces the
// catalog's own name for a known item, the digits-only item number, and the
// units-replaced-wholesale rule (see upsertSmItem). No cipOperation is sent,
// so nothing is pushed to CIP - this is us catching up to CIP, not the
// other way round.
//
// Run (dev API up):  node scripts/importInvListSm.mjs [path-to-xlsx] [--dry]
import { config } from "dotenv";
import fs from "node:fs";
import path from "node:path";
config({ path: ".env" });
const XLSX = (await import("xlsx-js-style")).default;
const { pool } = await import("../src/db.js");

const BASE = "http://localhost:4000/api";
const TOKEN = process.env.API_TOKEN;
const file = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "../invList.xlsx";
const dryRun = process.argv.includes("--dry");

const rows = XLSX.utils.sheet_to_json(XLSX.readFile(file).Sheets.ReportExport, { defval: null });

// CIP's export has changed its headers at least once: the 2026-10-02 file
// had plain "itemNO"/"location", the 2026-10-07 one has bilingual
// "itemNo/物料编码" and "locationCode/位置". Both are read by matching the
// English part before the slash, case-insensitively, so neither style - nor
// the next one - needs a separate script.
//
// A column this does not find comes back undefined, exactly as a missing
// key did before, so every check below still behaves the same way.
function col(row, ...names) {
  for (const name of names) {
    const key = Object.keys(row).find((k) => {
      const english = k.split("/")[0].trim().toLowerCase();
      return english === name.toLowerCase();
    });
    if (key !== undefined && row[key] !== null && row[key] !== undefined) return row[key];
  }
  return undefined;
}

// Rows CIP marks as deleted are not stock. The older export had no such
// column at all, so an absent value means "not deleted" rather than
// dropping every row.
const liveRows = rows.filter((row) => {
  const deleted = col(row, "deleteStatus");
  return deleted === undefined || Number(deleted) === 0;
});
if (liveRows.length !== rows.length) {
  console.log(`skipped ${rows.length - liveRows.length} row(s) CIP marks as deleted`);
}
console.log(`${file}: ${rows.length} rows${dryRun ? "  (dry run - nothing is written)" : ""}`);

// --- what is in there now, before anything is touched ---
const { rows: beforeItems } = await pool.query("SELECT * FROM sm_items ORDER BY item_no");
const { rows: beforeUnits } = await pool.query("SELECT * FROM sm_units ORDER BY item_no, unit_id");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
// --backup-dir=... puts the backup somewhere nodemon is not watching.
// Writing it under wpsapi/ restarted the dev server mid-import twice before
// nodemon.json pinned the watch to src/ - and that config only takes effect
// the next time the server is started.
const backupDir = (process.argv.find((a) => a.startsWith("--backup-dir=")) ?? "").split("=")[1] || "backups";
const backup = path.join(backupDir, `sm-items-${stamp}.json`);
if (!dryRun) {
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(backup, JSON.stringify({ at: new Date().toISOString(), items: beforeItems, units: beforeUnits }, null, 2));
  console.log(`backup: ${backup} (${beforeItems.length} items, ${beforeUnits.length} units)`);
}

const { rows: catalog } = await pool.query("SELECT item_no FROM sm_catalog");
const known = new Set(catalog.map((c) => c.item_no));
const hadUnits = new Set(beforeUnits.map((u) => u.item_no));

// --- which item a row is really about -------------------------------------
// The export mangles some numbers, in two ways seen in the real file:
//   ",993907000000026"  a stray leading comma
//   "99390100000009"    a 15-digit number that lost a zero (Excel treating
//                       the tail as a number), which lands in the catalog
//                       once the tail is padded back to 9 digits
// Both of those also turn out to be **duplicates**: the same item already
// has a clean row further down the file. So a row is resolved to the item it
// means, and when two rows mean the same item the one whose number was
// already correct wins (the mangled one carries no name and quantity 0).
const PREFIX = 6;
const padded = (digits) => (digits.length >= 15 ? digits : digits.slice(0, PREFIX) + digits.slice(PREFIX).padStart(9, "0"));

function resolveItemNo(rawNo) {
  const digits = String(rawNo ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (known.has(digits)) return digits;
  // Only trust the padded form when the catalog actually has it - otherwise
  // it would be inventing a number.
  const guess = padded(digits);
  if (guess !== digits && known.has(guess)) return guess;
  return digits;
}

const resolved = [];
for (const row of liveRows) {
  const itemNo = resolveItemNo(col(row, "itemNo", "itemNO"));
  const rawNo = String(col(row, "itemNo", "itemNO") ?? "").trim();
  resolved.push({ row, itemNo, clean: /^\d{15}$/.test(rawNo) });
}

// One row per item: the clean number wins, then the one that actually has a
// name, then whatever came first.
const byItem = new Map();
const duplicates = [];
for (const entry of resolved) {
  if (!entry.itemNo) continue;
  const held = byItem.get(entry.itemNo);
  if (!held) {
    byItem.set(entry.itemNo, entry);
    continue;
  }
  const better =
    (entry.clean && !held.clean) ||
    (entry.clean === held.clean &&
      String(col(entry.row, "itemName") ?? "").trim() &&
      !String(col(held.row, "itemName") ?? "").trim());
  const loser = better ? held : entry;
  byItem.set(entry.itemNo, better ? entry : held);
  duplicates.push([String(col(loser.row, "itemNo", "itemNO") ?? "").trim(), entry.itemNo]);
}
console.log(`resolved to ${byItem.size} distinct item(s)${duplicates.length ? `, ${duplicates.length} duplicate row(s) dropped` : ""}`);
for (const [droppedRaw, itemNo] of duplicates) console.log(`   dropped "${droppedRaw}" - same item as ${itemNo}`);

const created = [];
const overwritten = [];
const spoolsDropped = [];
const skipped = [];

for (const { row, itemNo } of byItem.values()) {
  const itemName = String(col(row, "itemName") ?? "").trim();
  const quantity = col(row, "specifications");
  const location = String(col(row, "locationCode", "location") ?? "").trim();

  if (!/^\d+$/.test(itemNo)) {
    skipped.push([itemNo || "(blank)", "item number is not digits only"]);
    continue;
  }
  // An item the catalog does not know keeps the name from the file, so a
  // nameless row has no name at all and must not be invented into stock.
  if (!known.has(itemNo) && !itemName) {
    skipped.push([itemNo, "unknown item with no name in the file"]);
    continue;
  }

  const body = {
    itemName,
    locationCode: location,
    note: "-",
    // A CIP export is one combined quantity per item - it has no notion of
    // which spool it sits on (see wpsApi's AGENTS.md, "Materiały SM").
    trackedIndividually: false,
    totalQuantity: quantity == null ? "0" : String(quantity),
    pendingQuantity: "0",
    units: [],
  };

  if (dryRun) {
    (beforeItems.some((i) => i.item_no === itemNo) ? overwritten : created).push(itemNo);
    if (hadUnits.has(itemNo)) spoolsDropped.push(itemNo);
    continue;
  }

  const res = await fetch(`${BASE}/sm-items/${encodeURIComponent(itemNo)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    skipped.push([itemNo, `HTTP ${res.status} ${(await res.text()).slice(0, 120)}`]);
    continue;
  }
  if (beforeItems.some((i) => i.item_no === itemNo)) overwritten.push(itemNo);
  else created.push(itemNo);
  if (hadUnits.has(itemNo)) spoolsDropped.push(itemNo);
}

console.log(`\ncreated:      ${created.length}`);
console.log(`overwritten:  ${overwritten.length}`);
console.log(`skipped:      ${skipped.length}`);
for (const [itemNo, why] of skipped) console.log(`   ${itemNo}  ${why}`);
if (spoolsDropped.length) {
  console.log(`\nspool breakdown replaced by one total on ${spoolsDropped.length} item(s):`);
  for (const itemNo of spoolsDropped) {
    const n = beforeUnits.filter((u) => u.item_no === itemNo).length;
    console.log(`   ${itemNo}  (${n} unit(s) - in the backup)`);
  }
}

const { rows: after } = await pool.query("SELECT count(*)::int AS n FROM sm_items");
const { rows: afterUnits } = await pool.query("SELECT count(*)::int AS n FROM sm_units");
console.log(`\nsm_items now: ${after[0].n}   sm_units now: ${afterUnits[0].n}`);
await pool.end();
