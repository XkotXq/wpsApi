// One-off import of historical stock-take xlsx exports into
// stock_versions/frp_stock/coated_frp_stock/filler_stock + a stocks
// bundle per date. Run with: node scripts/importXlsxStocks.mjs
// NOTE: only lists dates not already imported - 2026-08-25 and 2026-08-28
// are already in the database from the first run of this script.
import { config } from "dotenv";
config({ path: ".env" });
config({ path: ".env.local", override: true });

import XLSX from "xlsx-js-style";
// Dynamic import: a static import here would be hoisted above the
// config() calls above and see an empty DATABASE_URL (same bug fixed
// earlier in seed.mjs/migrate.mjs).
const { pool } = await import("../src/db.js");
const { newId } = await import("../src/id.js");
const { resolveDrumId } = await import("../src/drums.js");

const IMPORTS = [
  { file: "../20260721FRP & FILLER STOCK.xlsx", date: "2026-07-21T12:00:00Z" },
  { file: "../20260723FRP & FILLER STOCK.xlsx", date: "2026-07-23T12:00:00Z" },
  { file: "../20260724FRP & FILLER STOCK.xlsx", date: "2026-07-24T12:00:00Z" },
  { file: "../20260728FRP & FILLER STOCK.xlsx", date: "2026-07-28T12:00:00Z" },
  { file: "../20260731FRP & FILLER STOCK.xlsx", date: "2026-07-31T12:00:00Z" },
  { file: "../20260804FRP & FILLER STOCK.xlsx", date: "2026-08-04T12:00:00Z" },
];

function kmToMeters(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const km = Number(s.replace(",", "."));
  if (!Number.isFinite(km)) return "";
  return String(Math.round(km * 1000));
}

function rowsWithDrum(sheet, headerRows, drumIdx) {
  const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  return raw.slice(headerRows).filter((r) => String(r[drumIdx] ?? "").trim() !== "");
}

function parseWorkbook(file) {
  const wb = XLSX.readFile(file);

  const mmcFrp = rowsWithDrum(wb.Sheets["MMC_FRP"], 2, 5).map((r) => ({
    frpItemNumber: String(r[2] ?? "").trim(),
    drumNumber: String(r[5] ?? "").trim(),
    length: kmToMeters(r[4]),
    location: String(r[6] ?? "").trim(),
    remark: String(r[7] ?? "").trim(),
  }));
  const plainFrp = rowsWithDrum(wb.Sheets["FRP "], 2, 3).map((r) => ({
    frpItemNumber: String(r[0] ?? "").trim(),
    drumNumber: String(r[3] ?? "").trim(),
    length: kmToMeters(r[2]),
    location: String(r[5] ?? "").trim(),
    remark: String(r[6] ?? "").trim(),
  }));
  // Some exports (e.g. 2026-08-20) have the whole sheet's drum numbers
  // typed one column over, in the XB/Z slot, leaving the real DRUM
  // NUMBER column blank throughout - fall back to that column when the
  // expected one is empty but this one holds something other than XB/Z.
  const coatedFrpRaw = XLSX.utils.sheet_to_json(wb.Sheets["COATED FRP"], { header: 1, defval: "" }).slice(2);
  const coatedFrp = coatedFrpRaw
    .map((r) => {
      const col4 = String(r[4] ?? "").trim();
      const col5 = String(r[5] ?? "").trim();
      const shifted = !col4 && col5 && !["XB", "Z"].includes(col5);
      return {
        diameter: String(r[2] ?? "").trim(),
        type: !shifted && ["XB", "Z"].includes(col5) ? col5 : "XB",
        length: kmToMeters(r[3]),
        drumNumber: shifted ? col5 : col4,
        location: String(r[6] ?? "").trim(),
        remark: String(r[7] ?? "").trim(),
      };
    })
    .filter((item) => item.drumNumber !== "");
  const filler = rowsWithDrum(wb.Sheets["FILLER"], 2, 4).map((r) => ({
    color: ["GRAY", "WHITE", "BLACK"].includes(String(r[1]).trim()) ? String(r[1]).trim() : "GRAY",
    diameter: String(r[2] ?? "").trim(),
    length: kmToMeters(r[3]),
    drumNumber: String(r[4] ?? "").trim(),
    flameproof: String(r[5]).trim() === "NIEPALNY",
    location: String(r[6] ?? "").trim(),
    remark: String(r[7] ?? "").trim(),
  }));

  return { frp: [...mmcFrp, ...plainFrp], coatedFrp, filler };
}

async function insertVersion(client, materialKey, performedAt, items, insertRow) {
  const versionId = newId();
  await client.query(
    `INSERT INTO stock_versions (id, material_key, performed_by, performed_at, yes_count, no_count)
     VALUES ($1, $2, $3, $4, $5, 0)`,
    [versionId, materialKey, "import xlsx", performedAt, items.length]
  );
  for (const item of items) {
    const drumId = await resolveDrumId(client, item.drumNumber, null);
    await insertRow(client, versionId, drumId, item);
  }
  return versionId;
}

async function insertFrpStock(client, versionId, drumId, item) {
  await client.query(
    `INSERT INTO frp_stock (id, version_id, frp_item_number, drum_id, drum_number, length, location, remark)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [newId(), versionId, item.frpItemNumber, drumId, item.drumNumber, item.length, item.location, item.remark]
  );
}

async function insertCoatedFrpStock(client, versionId, drumId, item) {
  await client.query(
    `INSERT INTO coated_frp_stock (id, version_id, drum_id, drum_number, diameter, type, length, location, remark)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [newId(), versionId, drumId, item.drumNumber, item.diameter, item.type, item.length, item.location, item.remark]
  );
}

async function insertFillerStock(client, versionId, drumId, item) {
  await client.query(
    `INSERT INTO filler_stock (id, version_id, drum_id, drum_number, diameter, length, color, flameproof, location, remark)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [newId(), versionId, drumId, item.drumNumber, item.diameter, item.length, item.color, item.flameproof, item.location, item.remark]
  );
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const { file, date } of IMPORTS) {
      const { frp, coatedFrp, filler } = parseWorkbook(file);
      const frpVersionId = await insertVersion(client, "frp", date, frp, insertFrpStock);
      const coatedVersionId = await insertVersion(client, "coatedFrp", date, coatedFrp, insertCoatedFrpStock);
      const fillerVersionId = await insertVersion(client, "filler", date, filler, insertFillerStock);

      await client.query(
        `INSERT INTO stocks (id, performed_at, frp_version_id, coated_frp_version_id, filler_version_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [newId(), date, frpVersionId, coatedVersionId, fillerVersionId]
      );

      console.log(`${file}: frp=${frp.length} coatedFrp=${coatedFrp.length} filler=${filler.length}`);
    }

    await client.query("COMMIT");
    console.log("Import committed.");
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
