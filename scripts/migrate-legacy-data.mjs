// One-off migration: the DB still had tables from the previous
// (reverted) Postgres-backed API — frp_catalog/frp_items/coated_frp_items/
// filler_items/stock_checks/stock_status/category_locks — with real
// stock data (188 frp_items, 14 coated_frp_items). Those collide by name
// with the new schema (old frp_catalog.number vs new frp_catalog.item_number),
// so this: renames them out of the way, applies schema.sql, copies the
// data across into the new shape (frp_catalog, drums, frp_current,
// coated_frp_current), and leaves the renamed *_legacy tables in place
// for verification — nothing is dropped here.

import { config } from "dotenv";
import { readFileSync } from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", ".env") });
config({ path: join(here, "..", ".env.local"), override: true });

const { pool } = await import("../src/db.js");

function newId() {
  return crypto.randomUUID();
}

async function getOrCreateDrum(client, drumMap, drumNumber) {
  const trimmed = String(drumNumber ?? "").trim();
  if (!trimmed) throw new Error("empty drum number");
  if (drumMap.has(trimmed)) return drumMap.get(trimmed);
  const { rows: existing } = await client.query("SELECT id FROM drums WHERE drum_number = $1", [trimmed]);
  let id;
  if (existing.length) {
    id = existing[0].id;
  } else {
    id = newId();
    await client.query("INSERT INTO drums (id, drum_number) VALUES ($1, $2)", [id, trimmed]);
  }
  drumMap.set(trimmed, id);
  return id;
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: existingTables } = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [["frp_catalog", "frp_items", "coated_frp_items", "filler_items", "stock_checks", "stock_status", "category_locks"]]
    );
    for (const { table_name } of existingTables) {
      await client.query(`ALTER TABLE ${table_name} RENAME TO ${table_name}_legacy`);
      console.log(`renamed ${table_name} -> ${table_name}_legacy`);
    }

    const schemaSql = readFileSync(join(here, "..", "src", "schema.sql"), "utf8");
    await client.query(schemaSql);
    console.log("applied schema.sql");

    const hadCatalog = existingTables.some((t) => t.table_name === "frp_catalog");
    if (hadCatalog) {
      const { rowCount } = await client.query(
        `INSERT INTO frp_catalog (item_number, name, label, type, mmc)
         SELECT number, name, label, type, mmc FROM frp_catalog_legacy`
      );
      console.log(`copied ${rowCount} frp_catalog rows`);
    }

    const drumMap = new Map();

    const hadFrpItems = existingTables.some((t) => t.table_name === "frp_items");
    if (hadFrpItems) {
      const { rows: frpRows } = await client.query("SELECT * FROM frp_items_legacy ORDER BY position ASC");
      let migrated = 0;
      let skipped = 0;
      for (const row of frpRows) {
        const drum = String(row.drum_number ?? "").trim();
        if (!drum) { skipped++; continue; }
        const candidateNumbers = [row.item_number, row.frp_number].map((v) => String(v ?? "").trim()).filter(Boolean);
        let itemNumber = null;
        for (const candidate of candidateNumbers) {
          const { rows } = await client.query("SELECT 1 FROM frp_catalog WHERE item_number = $1", [candidate]);
          if (rows.length) { itemNumber = candidate; break; }
        }
        if (!itemNumber) { skipped++; console.warn(`skip frp_items row (no catalog match): drum=${drum} item_number=${row.item_number} frp_number=${row.frp_number}`); continue; }
        const drumId = await getOrCreateDrum(client, drumMap, drum);
        await client.query(
          `INSERT INTO frp_current (id, frp_item_number, drum_id, drum_number, length, location, remark, position, reserved_for_order, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, $10)`,
          [newId(), itemNumber, drumId, drum, row.length ?? "", row.location ?? "", row.remark ?? "", row.position ?? 0, row.created_at, row.updated_at]
        );
        migrated++;
      }
      console.log(`frp_items -> frp_current: migrated ${migrated}, skipped ${skipped}`);
    }

    const hadCoated = existingTables.some((t) => t.table_name === "coated_frp_items");
    if (hadCoated) {
      const { rows: coatedRows } = await client.query("SELECT * FROM coated_frp_items_legacy ORDER BY position ASC");
      let migrated = 0;
      let skipped = 0;
      for (const row of coatedRows) {
        const drum = String(row.drum_number ?? "").trim();
        if (!drum) { skipped++; continue; }
        const drumId = await getOrCreateDrum(client, drumMap, drum);
        await client.query(
          `INSERT INTO coated_frp_current (id, drum_id, drum_number, diameter, length, type, location, remark, position, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [newId(), drumId, drum, row.diameter ?? "", row.length ?? "", row.type ?? "XB", row.location ?? "", row.remark ?? "", row.position ?? 0, row.created_at, row.updated_at]
        );
        migrated++;
      }
      console.log(`coated_frp_items -> coated_frp_current: migrated ${migrated}, skipped ${skipped}`);
    }

    const hadFiller = existingTables.some((t) => t.table_name === "filler_items");
    if (hadFiller) {
      const { rows: fillerRows } = await client.query("SELECT * FROM filler_items_legacy ORDER BY position ASC");
      let migrated = 0;
      for (const row of fillerRows) {
        const drum = String(row.drum_number ?? "").trim();
        if (!drum) continue;
        const drumId = await getOrCreateDrum(client, drumMap, drum);
        await client.query(
          `INSERT INTO filler_current (id, drum_id, drum_number, diameter, length, color, flameproof, location, remark, position, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [newId(), drumId, drum, row.diameter ?? "", row.length ?? "", row.color ?? "GRAY", Boolean(row.isincendiary), row.location ?? "PRZED", row.remark ?? "", row.position ?? 0, row.created_at, row.updated_at]
        );
        migrated++;
      }
      console.log(`filler_items -> filler_current: migrated ${migrated}`);
    }

    await client.query("COMMIT");
    console.log("done — legacy tables kept as *_legacy for verification, not dropped.");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
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
