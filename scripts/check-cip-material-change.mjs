// Regression check for how a CIP BOM row with a material mapping is
// normalized before it leaves this API (routes/cipOrders.js's
// `withCatalogNames` - see AGENTS.md's "Order lookup", "Material changes").
// Run: node scripts/check-cip-material-change.mjs
//
// Reads two real sm_catalog items to assert catalog-first naming, but never
// writes anything and never talks to CIP (the function under test takes
// already-fetched BOM lines), so this is safe to run any time.
import { config } from "dotenv";
config({ path: ".env" });
const { pool } = await import("../src/db.js");
const { withCatalogNames } = await import("../src/routes/cipOrders.js");

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

const { rows } = await pool.query("SELECT item_no, item_name FROM sm_catalog ORDER BY item_no LIMIT 2");
if (rows.length < 2) {
  console.error("Need at least 2 sm_catalog rows to run this check.");
  process.exit(1);
}
const [original, replacement] = rows;

// One BOM line carrying: a swapped row the way CIP really sends it (the
// row's own itemCode is the *original*), the same swap the other way round
// (attachMaterialChanges matches either side, so this must not swap twice),
// an untouched known item, and an untouched item the catalog doesn't know.
const mapping = { from: original.item_no, to: replacement.item_no, desc: "CIP mapping desc", changedAt: "2026-09-30 12:00:00" };
const [line] = await withCatalogNames([
  {
    orderId: "TEST(1)",
    materials: [
      { itemCode: original.item_no, descriptionUs: "CIP original text", materialChange: { ...mapping } },
      { itemCode: replacement.item_no, descriptionUs: "CIP replacement text", materialChange: { ...mapping } },
      { itemCode: original.item_no, descriptionUs: "CIP original text" },
      { itemCode: "999999999", descriptionUs: "Unknown item text" },
    ],
  },
]);
const [swapped, alreadySwapped, untouched, unknown] = line.materials;

console.log(`catalog items used: ${original.item_no} -> ${replacement.item_no}\n`);

// The actual bug this check exists for: the number must follow the swap,
// not stay on the material that was replaced.
check("swapped row itemCode is the changed-to item", swapped.itemCode, replacement.item_no);
check("swapped row name is the changed-to item's catalog name", swapped.name, replacement.item_name);
check("swapped row keeps the original as materialChange.from", swapped.materialChange.from, original.item_no);
check("swapped row fromName is the original's catalog name", swapped.materialChange.fromName, original.item_name);
check("swapped row toName is the replacement's catalog name", swapped.materialChange.toName, replacement.item_name);

check("row already carrying the changed-to item is not swapped again", alreadySwapped.itemCode, replacement.item_no);
check("...and still names the original in fromName", alreadySwapped.materialChange.fromName, original.item_name);

check("untouched row keeps its own itemCode", untouched.itemCode, original.item_no);
check("untouched row has no materialChange", "materialChange" in untouched, false);
check("untouched row is named from the catalog", untouched.name, original.item_name);

check("unknown item keeps its itemCode", unknown.itemCode, "999999999");
check("unknown item falls back to CIP's own text", unknown.name, "Unknown item text");

await pool.end();
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
