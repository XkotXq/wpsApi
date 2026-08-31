import { config } from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Mirrors Next.js's own env-file precedence: .env first, then .env.local
// on top if present.
config({ path: ".env" });
config({ path: ".env.local", override: true });

// Dynamic import so this only runs (and reads process.env.DATABASE_URL)
// after the config() calls above - a static `import` would be hoisted
// above them and see an empty environment.
const { pool } = await import("../src/db.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, "..", "src", "schema.sql"), "utf8");
  await pool.query(sql);
  console.log("Schema applied.");
  await pool.end();
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
