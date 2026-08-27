import { config } from "dotenv";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });
config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env.local"), override: true });

// Imported after config() so DATABASE_URL is already set when db.js
// constructs its Pool (static imports are hoisted above regular code).
const { pool } = await import("../src/db.js");

async function main() {
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "schema.sql");
  const sql = readFileSync(schemaPath, "utf8");
  await pool.query(sql);
  console.log("Migration applied.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
