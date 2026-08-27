import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });
config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env.local"), override: true });

const { pool } = await import("../src/db.js");
const { FRP_CATALOG_SEED } = await import("../src/seedData.js");

async function main() {
  for (const row of FRP_CATALOG_SEED) {
    await pool.query(
      `INSERT INTO frp_catalog (item_number, name, label, type, mmc) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (item_number) DO NOTHING`,
      [row.itemNumber, row.name, row.label, row.type, row.mmc]
    );
  }
  console.log(`Seeded ${FRP_CATALOG_SEED.length} frp_catalog entries (existing rows left untouched).`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
