# Project context

This is a **git-tracked mirror** of `../api` (this repo pushes to GitHub
as `wpsapi`/`wpsApi`), the backend API in a 3-app warehouse
stock-tracking system for FRP / coated-FRP / filler materials. Express +
Postgres.

- `../wps` (pushed to GitHub as `wps`) — internal WMS dashboard
  (reports, balances, catalog, current-list editing, CIP export).
- `../stock` (pushed to GitHub as `stock`, package name `frp`) — the
  consumer-facing static export app warehouse staff use to do a physical
  stock check/count.

Both consume this API. **`../api` is the directory that actually runs**
(`npm run dev` there, real `.env` with live secrets there); this
directory only mirrors `../api`'s `src/` for pushing to GitHub. Make
changes in `../api` first, then copy them here (and `npm install` /
`git commit`/`push` here) rather than editing this copy independently —
otherwise the two drift.

## Data model
Generic CRUD (`src/items.js`: `listItems`/`createItem`/`updateItem`/
`deleteItem`/`reorderItems`/`transferItem`) driven by per-material field
config in `src/materials.js` (`MATERIALS.frp` / `.coatedFrp` / `.filler`,
each with `currentTable`, `required`, `fields`, optional `catalog` join).
Live inventory lives in `frp_current` / `coated_frp_current` /
`filler_current`; historical stock-takes are separate snapshot tables
(`src/stocks.js`, `src/checks.js`). Bulk position updates (`reorderItems`,
`transferItem`) use a single `UPDATE ... FROM unnest($1::type[], ...)`
query instead of N sequential per-row UPDATEs — keep that pattern for any
similar bulk-write endpoint; don't reintroduce an N+1 loop.

## Auth
Two layers:
1. `POST /api/auth/login` and `/api/auth/refresh` (`src/routes/auth.js`)
   proxy the company's legacy CIP system's OAuth2 password/refresh grant
   server-to-server (CIP has no CORS policy, so the browser can't call it
   directly). Rate-limited (`express-rate-limit`, 10 req/15min/IP) since
   this route forwards whatever credentials it's given straight to CIP.
2. Every other route requires a shared bearer token
   (`src/middleware/auth.js`'s `requireAuth`, checked against
   `API_TOKEN`, timing-safe compare) — this is a small internal tool
   used by one warehouse location, not a multi-tenant app, so a full
   per-user API key system is deliberately not used. `API_TOKEN` must be
   a real random secret, generated with
   `crypto.randomBytes(32).toString("hex")`, and must match
   `API_TOKEN`/`NEXT_PUBLIC_API_TOKEN` in `../wps/.env.local` and
   `../stock/.env.local` — never leave it as the `.env.example`
   placeholder value in a real `.env`.
