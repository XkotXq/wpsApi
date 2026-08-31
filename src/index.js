import { config } from "dotenv";

// Mirrors Next.js's own env-file precedence: .env first, then .env.local
// on top if present. In Docker/production, env vars are injected directly
// and these files simply won't exist, so config() is a silent no-op.
config({ path: ".env" });
config({ path: ".env.local", override: true });

// Dynamic import so app.js (and everything it pulls in, including db.js,
// which reads process.env.DATABASE_URL at import time) only loads after
// the config() calls above — a static `import` would be hoisted above
// them and see an empty environment.
await import("./app.js");
