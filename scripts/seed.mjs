import { config } from "dotenv";

// Mirrors Next.js's own env-file precedence: .env first, then .env.local
// on top if present.
config({ path: ".env" });
config({ path: ".env.local", override: true });

// Dynamic import so this only runs (and reads process.env.DATABASE_URL)
// after the config() calls above — a static `import` would be hoisted
// above them and see an empty environment.
const { pool } = await import("../src/db.js");
const { FRP_CATALOG_SEED } = await import("../src/seedData.js");

async function seed() {
  for (const item of FRP_CATALOG_SEED) {
    await pool.query(
      `INSERT INTO frp_catalog (item_number, label, name, type, mmc) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (item_number) DO NOTHING`,
      [item.number, item.label, item.name, item.type, item.mmc]
    );
  }
  console.log(`Seeded ${FRP_CATALOG_SEED.length} catalog entries (existing numbers skipped).`);
  await pool.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
