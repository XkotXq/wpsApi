# wpsApi

Backend API for a warehouse stock-tracking system covering FRP,
coated-FRP and filler materials. Express + PostgreSQL.

Part of a 3-app warehouse system:

- **wpsApi** (this app) — the shared backend.
- [**wps**](../WPS) — internal WMS dashboard (reports, balances,
  catalog, current-list editing, CIP export).
- [**stock**](../stock) — consumer-facing app warehouse staff use to do
  the physical stock check/count.

Both `wps` and `stock` call this API directly from the browser.

## What it does

- Generic CRUD over each material's live inventory (`frp_current`,
  `coated_frp_current`, `filler_current`), driven by per-material field
  config — see `src/routes/items.js` / `src/materials.js`.
- Historical stock-take snapshots and per-round comparisons —
  `src/routes/stocks.js` / `src/stocks.js`.
- Physical stock-check submissions — `src/routes/checks.js`.
- The shared FRP item catalog — `src/routes/catalog.js`.
- Login/refresh against the company's legacy CIP system (OAuth2
  password grant, proxied server-to-server) — `src/routes/auth.js`.
- Per-material advisory locks so two people can't edit the same round at
  once — `src/routes/locks.js`.

## Getting started

```bash
npm install
cp .env.example .env   # fill in real values
npm run migrate        # apply the database schema
npm run seed           # optional: seed sample data
npm run dev
```

The server listens on `PORT` (default `4000`).

### Environment variables (`.env`)

See `.env.example` for the full list — at minimum you need
`DATABASE_URL` (Postgres connection string) and `API_TOKEN` (a random
secret, generated with `crypto.randomBytes(32).toString("hex")`, that
must match `API_TOKEN`/`NEXT_PUBLIC_API_TOKEN` in `wps`'s and `stock`'s
own `.env.local` files).

### Scripts

- `npm run dev` — start with auto-reload (nodemon)
- `npm run start` — start without auto-reload
- `npm run migrate` — apply the database schema
- `npm run seed` — seed sample data

## Tech stack

Express · PostgreSQL (`pg`) · `express-rate-limit` · `xlsx-js-style`

See [`AGENTS.md`](./AGENTS.md) for implementation details and gotchas.
