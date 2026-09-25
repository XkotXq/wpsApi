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
  Verified for outStorage, inStorage and edit: success is `{ code: 0, msg: null, data: true }`, a
  refusal `{ code: 0, msg: "...", data: null }` (see `cipAccepted`). `specifications` on an
  outStorage write must equal `outStorageQuantity` (the amount being issued
  right now) - confirmed live from CIP's own UI on both a full and a partial
  issue. Sending the row's untouched on-hand `specifications` instead (this
  code's first version) made CIP issue the row's entire amount regardless of
  `outStorageQuantity` - caught live on 2026-09-25 when a 0.001 issue took
  the whole row; corrected by `cipFetch`'s caller in `HANDLERS.issue`.
- `SKIP_CIP_AUTH` (login bypass) is separate; with a bypass token a live sync
  refuses to run.
- Wired into `upsertSmItem` (src/smItems.js): a `PUT /sm-items/:itemNo` whose body
  carries `cipOperation`/`cipQuantity` (plus an `X-Cip-Token` header) pushes
  that delta to CIP *before* touching our tables - see routes/smItems.js. A
  write with neither is untouched by any of this, same as before CIP sync
  existed. Callers: smpda's ReceiveIssueController.submit (its own CIP
  token, already held client-side) and wps's SmMaterialsPanel.js (via the
  Server Action lib/smItemsCipApi.js - see wps's own AGENTS.md for why that
  extra hop exists there). `edit` (location/note changes with no quantity
  change) is not wired into anything yet.
- CIP has no notion of a spool - a material's quantity sits in CIP as one
  combined number (possibly split across several rows/locations, but never by
  spool). smpda/wps layer spool tracking on top of that combined number
  entirely on our side; CIP only ever sees item + quantity for an
  issue/receipt, never a spool tag. An issue spanning more than one CIP row
  for the same item is refused (see the per-row-wins-or-nothing rule above),
  not split across rows.

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

What that means in practice (verified in the code): `requireAuth` never
looks at a CIP token - there is no per-user check on the server. The
`cip_session` cookie is only read by WPS's own server (`lib/cipSession.js`),
wpsApi never sees it. smpda logs in through `/api/auth/login` too, but then
sends the shared `apiToken` on every call; the employee number it attaches
to an operation is asserted by the client. `WPS/lib/smItemsApi.js` calls
wpsApi straight from the browser with `NEXT_PUBLIC_API_TOKEN`, so that token
is in the JS bundle. `pushToCip()` (src/cip.js) is the only place a user's
CIP token is used, and no route passes one yet (`HANDLERS` is empty). Not
known yet: whether CIP's access_token is opaque or a JWT, its lifetime, and
which roles CIP returns - capture one real login response at work (mask the
tokens) before designing role mapping.

## The catalog names a material (`src/smItemValidation.js`)
`sm_catalog` is the authority for a material's name. `upsertSmItem` and
`createSmOperations` save/log a known item under the catalog's name
whatever the caller sent (blank, stale, mistyped) - `catalogItemName()`.
The item number must be digits only (`assertItemNoFormat`); an item the
catalog does not know keeps the caller's name, and a blank name for it is
refused. This replaced a "400 on name mismatch" check, which would have
blocked every later save of an item after a catalog rename. Stock rows keep an
old name until their next write - the catalog changes once a year or two, so
no sync mechanism (a version counter + rename propagation was built and
dropped for that reason).
- Reads: `GET /sm-catalog` (list), `GET /sm-catalog/:itemNo` (one entry, 404
  if unknown - what smpda asks per scan).
- `POST /sm-catalog/category-individual-units` `{ category, individualUnits:
  boolean }` flips "Osobne jednostki" (`individually_tracked`) for a whole
  category, touching only rows that change. Stock already on the shelf keeps
  its own `tracked_individually`; smpda's receipt upgrades an aggregate item
  to per-spool when the catalog says so (its total becomes the pending "Brak"
  quantity, never the other way round).
- Known inconsistency: smpda's receipt decides per-spool tracking catalog-first
  (an aggregate item is upgraded), WPS's `ReceiveUnitPanel` stock-first (an
  item already on the shelf keeps its own flag). Harmless while the two flags
  agree; unify the rule if they start to diverge.
- Bulk import sets `individually_tracked` for NEW rows from category/name
  (`defaultIndividualUnits`: category FRP and a name not starting "Coated");
  existing rows are left alone.
- `POST /sm-catalog/import` overwrites category/name/unit/remark of existing
  rows, so re-importing the spreadsheet works as a sync.

## Transport orders (DRAFT - `src/orders.draft.sql`)
A new module behind "Zamówienia": people on the lines ask forklift operators
("wózkowi", 3 shifts A/B/C) for a transport. **Our database is the source of
truth; orders are NOT mirrored to CIP** (for now). The schema is a draft: NOT
wired into `npm run migrate`, idempotent so it can be folded into
`schema.sql` unchanged. `node scripts/check-orders-draft.mjs` runs it in a
transaction against the dev DB, asserts 27 rules and rolls back (nothing
persists). Inputs per type were still being decided - expect changes.

Tables: `lines` (SH01-07, ST01-13, FC01-03, FL01 - the only places),
`order_types`, `shifts` (A 06:00, B 14:00, C 22:00 - three 8-hour shifts),
`orders`, `order_items`, `order_photos`.

| type | from | to | `details` (JSONB) | items |
|---|---|---|---|---|
| `water_refill` (dolewanie wody) | - | line | `{water: clean\|dirty}` | - |
| `material_order` (zamówienie materiału) | - | line | `{production_order_no}` - one per whole order | 1+ |
| `goods_transport` (półprodukty/wyroby) | line | line | - | - |
| `waste_removal` (wywóz odpadu) | the place | - | - | - |
| `warehouse_return` (zwrot na magazyn) | where to collect | (warehouse implied) | - | none |
| `machine_transport` | line | line | - | - |

- Required fields per type are a CHECK (`orders_type_fields`); `details`
  stays loose JSONB on purpose while the inputs move.
- **Order number**, set by a BEFORE INSERT trigger from `created_at`:
  `[shift A/B/C][hour of the shift 1-8][minute 00-59]/[yymmdd of the shift's
  START day]/[3 random digits]`, e.g. `C415/260924/192` (25.09 at 01:15 -
  shift C started 24.09, 4th hour). Time is Europe/Warsaw wall clock, so the
  hour digit is always 1-8 even on a daylight-saving night. The random suffix
  is re-drawn until free (advisory lock on the prefix serializes same-minute
  orders). Sort lists by `created_at`, not by number.
- `shift_code`/`shift_date` = the shift it was placed in;
  `completed_shift_code`/`completed_shift_date` = the shift that fulfilled it,
  derived from `completed_at` (no manual A/B/C marking).
- Status: `new` -> `in_progress` -> `done`; `new` -> `done`;
  `new`/`in_progress` -> `cancelled`. Timestamps are filled by the trigger,
  `taken_by`/`completed_by` ("Zrealizował") must be supplied. A closed order
  is frozen; number, type, requester and `created_at` never change.
- `order_items` (material orders only): name and unit come from `sm_catalog`
  whatever is sent; an item the catalog does not know is refused. A material
  order needs at least one item (checked at commit, so order + items insert in
  one transaction).
- `order_photos` holds only a `storage_key` - where files live (server disk
  vs S3-compatible storage such as MinIO) is undecided. Plan: the PDA uploads
  through wpsApi (Hasura does not take files), shrinks the photo first, and a
  short-lived download link is generated on demand from the key.
- "Lista zamówień" = `new` + `in_progress`; "Historia zamówień" = `done` +
  `cancelled`. Today WPS shows demo data (`WPS/lib/ordersCipSeed.js`, local
  state in `OrdersCipListTable.js`, including the "Zamów" dialog).

## Roadmap (agreed direction, in order)
1. **Per-user auth.** After a successful CIP login, wpsApi issues its own
   short-lived JWT (employee number from CIP + a role from a local role-mapping
   table: orderer / forklift / supervisor). Today there is only the shared
   `API_TOKEN` (see Auth). Prerequisite for the next step.
2. **Hasura on the existing Postgres** (the plan is for it to be added), the
   orders module first: fold `orders.draft.sql` into `schema.sql`; Hasura
   metadata in git, console locked, admin secret set; permissions per role;
   subscriptions so the list and history update live. Business rules (status
   flow, numbering, required fields) stay in Postgres, not in a client.
3. **WPS**: Lista zamówień and Historia zamówień on Hasura instead of the demo
   seed; "Zrealizował" and the fulfilling shift columns. Rename "Zamówienia
   CIP" once nothing there is CIP any more.
4. **Photos**: pick the storage (disk vs MinIO), retention and backups; upload
   endpoint + on-demand links; `order_photos` is ready for it.
5. **smpda**: scans are refused with no connection (`requireOnline`), by
   decision. If offline work is ever needed: an "apply operation" endpoint with
   a client-generated idempotency key (queue operations, never whole items -
   `PUT /sm-items` overwrites the whole row and races between two PDAs);
   receipts first, issues offline also need a local stock copy.
6. **Batches for aggregate items.** Aggregate items keep one `total_quantity`;
   the batch only reaches the operation log, so a return with a different batch
   cannot be tracked. Idea: stock per (item, batch); every scan issues from the
   batch on the scanned label; when an item has other batches, ask "are you
   also taking from batch B?" before saving; fix wrong splits with a "transfer
   between batches" correction (total unchanged - zeroing would break the match
   with CIP). Whether batch traceability is a quality requirement decides
   "must scan" versus "prompt + correct".
7. **Later**: mirror orders to CIP (external id + sync status columns, not
   built), and a smpda catalog copy refreshed via Hasura subscriptions only if
   offline work becomes a requirement.
