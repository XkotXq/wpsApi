// One-off: replace frp_current/coated_frp_current/filler_current with
// "20260904FRP & FILLER STOCK.xlsx" (the reconciled snapshot after
// today's physical count) AND record that same data as today's finalized
// stock-take round (stock_versions/frp_stock/coated_frp_stock/filler_stock
// + a stocks bundle + stock_status), mirroring importXlsxStocks.mjs's
// historical-only import but also touching *_current per explicit request.
//
// Skips (see chat for full list), because a drum can only be attached to
// one current item at a time (drums.drum_number is UNIQUE) and length is
// a required field for frp/coatedFrp:
//   - FRP item 993916000000125 / drum C603: no length ("Do przewinięcia")
//   - COATED FRP drums T068, 01306, 01335, T073: no length ("Odwrotnie nawinięte")
//   - COATED FRP: 16 trailing blank rows (not data)
//   - Duplicate drum numbers across sheets, first occurrence kept:
//     F111 (frp kept, filler skipped), 191 (frp kept, coated skipped),
//     006 (frp kept, filler skipped), C005 (coated kept, filler skipped),
//     035 (coated kept, filler skipped), C010 (filler row 47 kept, row 138 skipped)
//
// Run with: node scripts/import-2026-09-04-current-and-stock.mjs
import { config } from "dotenv";
config({ path: ".env" });
config({ path: ".env.local", override: true });

import XLSX from "xlsx-js-style";
// Dynamic import: a static import here would be hoisted above the
// config() calls above and see an empty DATABASE_URL.
const { pool } = await import("../src/db.js");
const { newId } = await import("../src/id.js");
const { resolveDrumId } = await import("../src/drums.js");

const FILE = "../20260904FRP & FILLER STOCK.xlsx";
const PERFORMED_AT = "2026-09-04T12:00:00Z";
const PERFORMED_BY = "import xlsx";

function kmToMeters(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const km = Number(s.replace(",", "."));
  if (!Number.isFinite(km)) return "";
  return String(Math.round(km * 1000));
}

function sheetRows(wb, name, headerRows, cols) {
  const raw = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "" });
  return raw.slice(headerRows).map((r) => {
    const obj = {};
    cols.forEach((c, i) => (obj[c] = String(r[i] ?? "").trim()));
    return obj;
  });
}

function parseWorkbook(file) {
  const wb = XLSX.readFile(file);
  const skipped = [];

  const frp = sheetRows(wb, "FRP ", 2, ["frpItemNumber", "diameterLabel", "length", "drumNumber", "type", "location", "remark"])
    .filter((r) => r.frpItemNumber || r.drumNumber)
    .map((r) => ({ ...r, length: kmToMeters(r.length) }))
    .filter((r) => {
      if (!r.length) {
        skipped.push({ material: "frp", drum: r.drumNumber, reason: "brak długości" });
        return false;
      }
      return true;
    });

  const coatedFrp = sheetRows(wb, "COATED FRP", 2, ["area", "no", "diameter", "length", "drumNumber", "type", "location", "remark"])
    .filter((r) => r.drumNumber || r.diameter)
    .map((r) => ({ ...r, length: kmToMeters(r.length), type: ["XB", "Z"].includes(r.type) ? r.type : "XB" }))
    .filter((r) => {
      if (!r.length || !r.diameter || !r.drumNumber) {
        skipped.push({ material: "coatedFrp", drum: r.drumNumber, reason: "brak długości/średnicy/szpuli" });
        return false;
      }
      return true;
    });

  const filler = sheetRows(wb, "FILLER", 2, ["no", "color", "diameter", "length", "drumNumber", "flame", "location", "remark"])
    .filter((r) => r.drumNumber)
    .map((r) => ({
      ...r,
      length: kmToMeters(r.length),
      color: ["GRAY", "WHITE", "BLACK"].includes(r.color) ? r.color : "GRAY",
      flameproof: r.flame === "NIEPALNY",
    }));

  // Global first-occurrence-wins dedup on drum number - the app only
  // allows one current item per drum across all three materials.
  const seenDrums = new Set();
  function dedup(materialKey, rows) {
    return rows.filter((r) => {
      if (seenDrums.has(r.drumNumber)) {
        skipped.push({ material: materialKey, drum: r.drumNumber, reason: "duplikat numeru szpuli (zachowano pierwsze wystąpienie)" });
        return false;
      }
      seenDrums.add(r.drumNumber);
      return true;
    });
  }
  const frpFinal = dedup("frp", frp);
  const coatedFrpFinal = dedup("coatedFrp", coatedFrp);
  const fillerFinal = dedup("filler", filler);

  return { frp: frpFinal, coatedFrp: coatedFrpFinal, filler: fillerFinal, skipped };
}

async function replaceCurrent(client, table, items, insertCurrentRow, drumIdByNumber) {
  await client.query(`TRUNCATE ${table}`);
  let position = 0;
  for (const item of items) {
    let drumId = drumIdByNumber.get(item.drumNumber);
    if (!drumId) {
      drumId = await resolveDrumId(client, item.drumNumber, null);
      drumIdByNumber.set(item.drumNumber, drumId);
    }
    await insertCurrentRow(client, drumId, item, position);
    position += 1;
  }
}

async function insertVersion(client, materialKey, items, insertStockRow, drumIdByNumber) {
  const versionId = newId();
  await client.query(
    `INSERT INTO stock_versions (id, material_key, performed_by, performed_at, yes_count, no_count)
     VALUES ($1, $2, $3, $4, $5, 0)`,
    [versionId, materialKey, PERFORMED_BY, PERFORMED_AT, items.length]
  );
  for (const item of items) {
    const drumId = drumIdByNumber.get(item.drumNumber);
    await insertStockRow(client, versionId, drumId, item);
  }
  return versionId;
}

async function insertFrpCurrent(client, drumId, item, position) {
  await client.query(
    `INSERT INTO frp_current (id, frp_item_number, drum_id, drum_number, length, location, remark, position)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [newId(), item.frpItemNumber, drumId, item.drumNumber, item.length, item.location, item.remark, position]
  );
}
async function insertFrpStock(client, versionId, drumId, item) {
  await client.query(
    `INSERT INTO frp_stock (id, version_id, frp_item_number, drum_id, drum_number, length, location, remark)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [newId(), versionId, item.frpItemNumber, drumId, item.drumNumber, item.length, item.location, item.remark]
  );
}

async function insertCoatedFrpCurrent(client, drumId, item, position) {
  await client.query(
    `INSERT INTO coated_frp_current (id, drum_id, drum_number, diameter, type, length, location, remark, position)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [newId(), drumId, item.drumNumber, item.diameter, item.type, item.length, item.location, item.remark, position]
  );
}
async function insertCoatedFrpStock(client, versionId, drumId, item) {
  await client.query(
    `INSERT INTO coated_frp_stock (id, version_id, drum_id, drum_number, diameter, type, length, location, remark)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [newId(), versionId, drumId, item.drumNumber, item.diameter, item.type, item.length, item.location, item.remark]
  );
}

async function insertFillerCurrent(client, drumId, item, position) {
  await client.query(
    `INSERT INTO filler_current (id, drum_id, drum_number, diameter, length, color, flameproof, location, remark, position)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [newId(), drumId, item.drumNumber, item.diameter, item.length, item.color, item.flameproof, item.location, item.remark, position]
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
  const { frp, coatedFrp, filler, skipped } = parseWorkbook(FILE);
  console.log(`Parsed: frp=${frp.length} coatedFrp=${coatedFrp.length} filler=${filler.length} skipped=${skipped.length}`);
  for (const s of skipped) console.log("  skip:", s.material, s.drum, "-", s.reason);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const drumIdByNumber = new Map();
    await replaceCurrent(client, "frp_current", frp, insertFrpCurrent, drumIdByNumber);
    await replaceCurrent(client, "coated_frp_current", coatedFrp, insertCoatedFrpCurrent, drumIdByNumber);
    await replaceCurrent(client, "filler_current", filler, insertFillerCurrent, drumIdByNumber);

    const frpVersionId = await insertVersion(client, "frp", frp, insertFrpStock, drumIdByNumber);
    const coatedVersionId = await insertVersion(client, "coatedFrp", coatedFrp, insertCoatedFrpStock, drumIdByNumber);
    const fillerVersionId = await insertVersion(client, "filler", filler, insertFillerStock, drumIdByNumber);

    await client.query(
      `INSERT INTO stocks (id, performed_at, frp_version_id, coated_frp_version_id, filler_version_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [newId(), PERFORMED_AT, frpVersionId, coatedVersionId, fillerVersionId]
    );

    for (const materialKey of ["frp", "coatedFrp", "filler"]) {
      await client.query(
        `INSERT INTO stock_status (material, completed, updated_at, updated_by) VALUES ($1, TRUE, now(), $2)
         ON CONFLICT (material) DO UPDATE SET completed = TRUE, updated_at = now(), updated_by = $2`,
        [materialKey, PERFORMED_BY]
      );
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
