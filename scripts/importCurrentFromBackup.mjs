// One-off import of the /frp app's localStorage backup (ystock_backup_*.json)
// into frp_current/coated_frp_current/filler_current — the live/editable
// inventory tables, which the API's own createItem() populates (so this
// gets the same validation, drum resolution, and position assignment as
// creating each item through the app itself).
import { config } from "dotenv";
config({ path: ".env" });
config({ path: ".env.local", override: true });

import fs from "node:fs";
// Dynamic import: a static import here would be hoisted above the
// config() calls above and see an empty DATABASE_URL (same bug fixed
// earlier in seed.mjs/migrate.mjs/importXlsxStocks.mjs).
const { createItem } = await import("../src/items.js");
const { getMaterial } = await import("../src/materials.js");
const { pool } = await import("../src/db.js");

const BACKUP_FILE = "../ystock_backup_2026-08-28_15-12.json";
const MATERIAL_KEYS = ["frp", "coatedFrp", "filler"];

function frpBody(item) {
  return {
    frpItemNumber: item.itemNumber || item.frpNumber || "",
    length: String(item.length ?? ""),
    location: item.location ?? "",
    drumNumber: item.drumNumber ?? "",
    remark: item.remark ?? "",
  };
}

function coatedFrpBody(item) {
  return {
    diameter: item.diameter ?? "",
    length: String(item.length ?? ""),
    location: item.location ?? "",
    drumNumber: item.drumNumber ?? "",
    remark: item.remark ?? "",
  };
}

function fillerBody(item) {
  return {
    color: item.color ?? "GRAY",
    diameter: item.diameter ?? "",
    length: String(item.length ?? ""),
    location: item.location ?? "",
    drumNumber: item.drumNumber ?? "",
    isincendiary: Boolean(item.isincendiary),
    remark: item.remark ?? "",
  };
}

const BODY_BUILDERS = { frp: frpBody, coatedFrp: coatedFrpBody, filler: fillerBody };

async function main() {
  const data = JSON.parse(fs.readFileSync(BACKUP_FILE, "utf8"));

  // A physical drum can only be attached to one current item at a time
  // (assertDrumFree in drums.js) — the source backup has a handful of
  // drum numbers reused across materials/rows (stale data the old app
  // only warned about, never blocked). First occurrence wins; the rest
  // are reported at the end instead of silently dropped.
  const seenDrums = new Set();
  const skipped = [];
  let created = 0;

  for (const materialKey of MATERIAL_KEYS) {
    const material = getMaterial(materialKey);
    for (const item of data.stocks[materialKey] ?? []) {
      const drum = String(item.drumNumber ?? "").trim();
      if (seenDrums.has(drum)) {
        skipped.push({ materialKey, drum, reason: "duplicate drum number" });
        continue;
      }
      try {
        await createItem(material, BODY_BUILDERS[materialKey](item));
        seenDrums.add(drum);
        created++;
      } catch (err) {
        skipped.push({ materialKey, drum, reason: err.message });
      }
    }
  }

  console.log(`Created ${created} current items.`);
  if (skipped.length) {
    console.log(`Skipped ${skipped.length}:`);
    for (const s of skipped) console.log(`  - ${s.materialKey} / ${s.drum}: ${s.reason}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
