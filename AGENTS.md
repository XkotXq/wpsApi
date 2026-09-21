# Project context

This is the backend API (pushed to GitHub as `wpsapi`/`wpsApi`) in a
3-app warehouse stock-tracking system for FRP / coated-FRP / filler
materials. Express + Postgres. **This directory is developed and run
directly on this machine** (`npm run dev` here, real `.env` with live
secrets here, the port-4000 server is `node src/index.js` from here) -
there's no separate `../api` directory to keep in sync with; this is the
one source of truth.

- `../WPS` (pushed to GitHub as `wps`) — internal WMS dashboard
  (reports, balances, catalog, current-list editing, CIP export).
- `../stock` (pushed to GitHub as `stock`, package name `frp`) — the
  consumer-facing app warehouse staff use to do a physical stock
  check/count. Dynamic app now (not a static export); also has its own
  unprotected `/frp-list` route outside its normal CIP login gate.

Both consume this API directly from the browser.

## CIP sync (`src/cip.js`)
Our database is the source of truth. An operation that has a counterpart in
CIP is validated here, pushed to CIP with the CIP token of the person doing
it, and only then applied to our tables; CIP has no notion of spools, so a
spool operation goes to CIP as just item + quantity.
- **`CIP_SYNC=true`** turns the push on (production). Anything else - the
  default - sends nothing: `pushToCip()` returns `{ skipped: true }` and the
  caller proceeds as if CIP had accepted. `/api/health` reports the current
  state as `cipSync`, and the server logs it at startup.
- CIP answers `{ code: 0, msg, data: null }` even for a refused operation
  (e.g. "Cannot exceed inventory quantity"), so `cipFetch` does not judge the
  reply - each operation's handler in `HANDLERS` decides what success is.
  Verified for outStorage and inStorage: success is `{ code: 0, msg: null, data: true }`, a
  refusal `{ code: 0, msg: "...", data: null }` (see `cipAccepted`). Not yet
  verified for edit.
- `SKIP_CIP_AUTH` (login bypass) is separate; with a bypass token a live sync
  refuses to run.

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

`GET /stocks/:material/trend` (`getMaterialTrend` in `src/stocks.js`,
powers wps's Reports page) caps its result to the most recent 150 stock
rounds *for that material* via each `TREND_QUERIES` entry's
`recent_versions` CTE (`LIMIT $1`, capped/defaulted to
`TREND_ROUNDS_LIMIT` in `getMaterialTrend` itself) - accepts `?limit=`,
but never above that cap. The CTE exists so the cap drops whole old
rounds instead of cutting off mid-round the way a LIMIT on the final
(round × item) result set would.

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
   `API_TOKEN`/`NEXT_PUBLIC_API_TOKEN` in `../WPS/.env.local` and
   `../stock/.env.local` — never leave it as the `.env.example`
   placeholder value in a real `.env`.
