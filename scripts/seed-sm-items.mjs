// One-off: seed sm_items/sm_units from wps's mock SM_INITIAL_ITEMS (the
// last state of the "Materiały SM" concept before it moved server-side),
// so Lista materiałów SM isn't empty on first real load. Run with:
//   node scripts/seed-sm-items.mjs
import { config } from "dotenv";
config({ path: ".env" });
config({ path: ".env.local", override: true });

import fs from "fs";
const { upsertSmItem } = await import("../src/smItems.js");
const { pool } = await import("../src/db.js");

// wps's own file is plain JS with an ESM export - reading + eval'ing it
// here keeps this a one-off script without adding a cross-repo import.
const src = fs.readFileSync("C:\\Users\\bgrotek\\Desktop\\apps\\stock\\wps\\lib\\smMaterialsSeed.js", "utf8");
const withoutExport = src.replace("export const SM_INITIAL_ITEMS", "const SM_INITIAL_ITEMS");
const items = new Function(`${withoutExport}\nreturn SM_INITIAL_ITEMS;`)();

async function main() {
  console.log(`seeding ${items.length} sm_items...`);
  for (const item of items) {
    await upsertSmItem(item.itemNo, item);
  }
  console.log("Seed committed.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
