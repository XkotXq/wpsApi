// One-off: parse ../materialList.txt (tab-separated "item number\tname",
// some names wrapping onto a quoted continuation line) into sm_catalog.
// individually_tracked = true only for plain FRP items (not "Coated
// FRP...", not "GFRP...") - matches the same rule already applied to
// wps's lib/smMaterialsSeed.js mock data. Run with:
//   node scripts/seed-sm-catalog.mjs
import { config } from "dotenv";
config({ path: ".env" });
config({ path: ".env.local", override: true });

import fs from "fs";
const { pool } = await import("../src/db.js");

function parseMaterialList(path) {
  const lines = fs.readFileSync(path, "utf8").split(/\r\n|\n/);
  const records = [];
  for (const line of lines) {
    if (/^\d+\t/.test(line)) {
      const idx = line.indexOf("\t");
      records.push([line.slice(0, idx).trim(), line.slice(idx + 1)]);
    } else if (line.trim() !== "" && records.length) {
      records[records.length - 1][1] += " " + line.trim();
    }
  }
  const byItem = new Map();
  for (const [itemNo, rawName] of records) {
    if (byItem.has(itemNo)) continue; // first occurrence wins - no conflicting duplicates found in this file
    let name = rawName.trim();
    if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
    byItem.set(itemNo, name.replace(/\s+/g, " ").trim());
  }
  return [...byItem.entries()].map(([itemNo, itemName]) => ({ itemNo, itemName }));
}

function isIndividuallyTracked(name) {
  if (/^Coated\b/i.test(name)) return false;
  if (/^GFRP\b/i.test(name)) return false;
  if (/^FRP\b/i.test(name)) return true;
  if (/^High-strength FRP\b/i.test(name)) return true;
  if (/^FRP with steel wire/i.test(name)) return true;
  if (/suppleness-FRP/i.test(name)) return true;
  return false;
}

async function main() {
  const items = parseMaterialList("C:\\Users\\bgrotek\\Desktop\\apps\\stock\\materialList.txt");
  const rows = items.map((it) => ({ ...it, individuallyTracked: isIndividuallyTracked(it.itemName) }));
  console.log(`parsed ${rows.length} unique items, ${rows.filter((r) => r.individuallyTracked).length} individually tracked`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of rows) {
      await client.query(
        `INSERT INTO sm_catalog (item_no, item_name, individually_tracked)
         VALUES ($1, $2, $3)
         ON CONFLICT (item_no) DO UPDATE SET item_name = EXCLUDED.item_name, individually_tracked = EXCLUDED.individually_tracked, updated_at = now()`,
        [row.itemNo, row.itemName, row.individuallyTracked]
      );
    }
    await client.query("COMMIT");
    console.log("Seed committed.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
