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

## Order lookup (`src/cip.js`'s `getCipOrderMaterials`, `routes/cipOrders.js`)
`POST /cip-orders` (+ `/materials`, `/materials/warehouse`), body `{ orderId }`,
looks up a CIP production order's bill of materials - for wps's "Zamówienia"
tab (`OrderMaterialsSearch.js`) and "Zamówienie materiału"'s own material
picker (`OrdersCipListTable.js`), checking what a production order needs
before/while it's run. POST rather than GET with `orderId` in the URL: it can
contain `(` `)` (a full orderId) and, since a fragment is also accepted (see
below), potentially other odd substrings too - a JSON body sidesteps
URL-encoding all of that correctly at every call site. A GET, or any path
under `/cip-orders` these three routes don't define, is refused by name
rather than falling through to the generic `/:material` catch-all further
down `app.js` (see that guard's own comment - this exact fall-through was
seen live from Postman when these were still GET routes).
Read-only and always live against CIP, regardless of `CIP_SYNC` (see that
constant's own doc comment) - there's no local copy of this data to fall
back to. `orderId` is CIP's own `orderNumber` + "(lineNumber)", e.g.
`260010309034801(4)`; a bare order number (no `(n)`) returns every matching
production line instead of one, and a fragment or just the ending of one
(e.g. `9034801`) is resolved too - see `resolveOrderIdsByFragment`: CIP's
`orderProcessCount` search (the main lookup, exact-only) is retried through
a different, looser CIP search purely to resolve which exact orderId(s) a
fragment means, each then looked up again the normal way so the response
shape never differs by which path found it.
- `/materials` returns just `{ orderId, materials }` (or an array of those,
  one per line, for a bare order number/fragment - see the route's own comment).
  `/materials/warehouse` is the same, filtered to materials this warehouse
  actually stocks (`sm_catalog.item_no` - `smCatalog.js`'s `knownSmItemNos`);
  a BOM lists everything the order needs, most of it (fibre, masterbatch...)
  from other warehouses/processes.
- **Names** (`withCatalogNames` in `routes/cipOrders.js`): every material's
  `name` (and, for a changed one, `materialChange.fromName`/`toName`) is
  resolved catalog-first (`sm_catalog.item_name`, via `smCatalog.js`'s
  `smItemNames`), CIP's own `descriptionUs`/`descriptionZhs`/mapping
  `materialDesc` only as the fallback for an item the catalog doesn't know -
  same rule this file's "The catalog names a material" section already
  documents for what wpsApi writes, extended here to what it shows from CIP's
  own order/BOM data too. Skipping this and using CIP's raw description
  directly showed Chinese text for at least one real item whose
  `descriptionUs` was blank.
- **Material changes**: a material can be substituted after the order was
  planned (e.g. a discontinued tape swapped for its replacement) - the BOM
  itself doesn't show this, CIP's `/cms/material/mapping/page/query` does
  (`findCipMaterialMappings`). `getCipOrderMaterials` attaches it to the BOM
  row it concerns as `materialChange: { from, to, desc, changedAt }`, matched
  by `itemCode` against either side of the mapping (confirmed live: the
  BOM's `itemCode` is the *original*, pre-swap item - `from` - not the
  replacement). The line also keeps the raw list as `materialMappings`, for
  a mapping whose item isn't in this BOM at all.
- **Drum/spool size**: which drum(s) an order's cable ships on is free text
  CIP keeps per order line, nowhere in the order/BOM data above - CIP's own
  "historyEdit" screen (`POST /cppms/historical/historyEdit/search`, body
  `{ orderSn }`) has it, under one of several `opRequest*` fields (SH/SC/
  TB/DP/Test/Customer - which one varies by order/cable type, all are
  checked - confirmed live: found under `opRequestSh`), as a
  "Rozmiar szpuli: ..."-style segment in that field's own "/"-separated free
  text (`cip.js`'s `findCipOrderProcessRequirements` +
  `extractSpoolSizeSegments`, run per line alongside the BOM/mapping fetches
  - `line.spoolSizeSegments`). A line can need more than one drum - a cable
  run split across several reels, e.g. "Rozmiar szpuli: 4km: 1250B
  1250*650*740 ; 2km: 1120B II 1120*650*740" (confirmed live) - so that
  text is itself split on ";" into one segment per drum, each optionally
  carrying its own leading length label ("4km:") split off by
  `routes/cipOrders.js`'s `splitLengthLabel` before matching.
  `matchDrumCatalog` matches a segment's code (before its own dimensions,
  e.g. "W600A") against `sm_catalog`'s own "Drum" category
  (`smCatalog.js`'s `drumCatalogEntries`) by longest trailing-word match
  (handles a "II"/"III" variant suffix, e.g. "Wooden drum W1250B II" over
  the shorter "Wooden drum W1250B", and a missing leading "W" - both
  confirmed live - see that function's own comment), falling back to a
  fuzzy search (`fuse.js`, `fuzzyMatchDrumCatalog`) for anything that
  matches neither way. `withDrumMaterial` then appends every matched
  segment as its own `materials` entry (a segment's length label, if it had
  one, appended onto its name - `isDrumRequirement: true`, `qty`/
  `requiredQuantity` left unset - the free text never says how many of each
  drum) - each a real "Materiały SM" catalog item by construction, so they
  survive `/materials/warehouse`'s own filter with no special-casing
  needed.

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

Tables: `locations` (places; SH01-07, ST01-13, FC01-03, FL01 are the fixed production lines, `is_line`),
`order_types`, `shifts` (A 06:00, B 14:00, C 22:00 - three 8-hour shifts),
`orders`, `order_items`, `order_photos`.

| type | from | to | `details` (JSONB) | items |
|---|---|---|---|---|
| `water_refill` (dolewanie wody) | - | line | `{water: clean\|dirty}` | - |
| `material_order` (zamówienie materiału) | - | line | `{production_order_no}` - one per whole order | 1+ |
| `spool_order` (zamówienie szpul) | - | line | - (no agreed inputs yet) | 1+ |
| `goods_transport` (półprodukty/wyroby) | any place | any place | - | - |
| `waste_removal` (wywóz odpadu) | the place | - | - | - |
| `warehouse_return` (zwrot na magazyn) | where to collect | (warehouse implied) | - | none |
| `machine_transport` | line | line | - | - |

- The WPS "Nowe zamówienie" menu offers: dolewanie wody, zamówienie materiału,
  zamówienie szpul, transport półproduktów, wywożenie odpadu, zwrot na magazyn
  (`machine_transport` exists in the schema but is not in the menu).
- **Places.** Every type but `goods_transport` takes production lines only
  (enforced in `orders_before_insert`). `goods_transport` ("skąd"/"dokąd") takes
  any text: a typed place takes the known spelling (case-insensitive, unique
  index on `lower(name)`), a new one is registered in `locations` with the order
  and is suggested from then on - one shared list, not per user (suggestions:
  `ILIKE '%typed%'`, lines first). A transport may not go from a place to itself.
  Planned, not built: a "Częste trasy" strip above the form (this user's most
  frequent routes, ranked from their own past orders); the slot is a TODO
  comment in `OrdersCipListTable.js`.
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
- `order_items`: both kinds are counted by piece - `unit` is always `"szt."`,
  never `sm_catalog`'s own unit (km/kg/...), even for **material_order**.
  **material_order** still requires the item to be real: `item_name` comes
  from `sm_catalog`, an unknown item number is refused. **spool_order** items
  are physical spools, which the catalog has no notion of - not consulted at
  all (for now); `item_name` is whatever the caller sent (e.g. the spool
  type, "1610"), only required to be non-blank. Either type needs at least
  one item (checked at commit, so order + items insert in one transaction).
- `line_material_rules` (`line_name`, `item_no`, `note`, unique per pair): a
  standing instruction for one material on one line - e.g. line SH02 needs
  Glass Yarn/600tex issued as short lengths first. `line_name` must be a real
  production line (`locations.is_line`). Same shape and same "who maintains
  it" open question as the planned `material_mapping` (see roadmap) - both
  are small, manually-kept reference tables, not derived from anything.
  `order_items_with_notes` (a view) joins this onto `order_items` via the
  parent order's `to_location`, live - an edited/added rule applies to every
  matching order immediately, including ones already placed, not just new
  ones. `rule_note` is `NULL` for the ordinary case (nothing special about
  that item on that line).
- `client_order_no` (optional): the company's own client order - what a
  customer ordered (e.g. fibre-optic products), separate from `order_no`
  (ours, generated) and from `details->>'production_order_no'`
  (material_order's own, used to query CIP - see roadmap). Not yet scoped to
  particular types.
- Photos: the WPS form offers one optional photo for `goods_transport`, `waste_removal` and
  `warehouse_return` (demo: browser-only blob URL, no upload yet).
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
