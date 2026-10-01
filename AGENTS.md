# Project context

This is the backend API (pushed to GitHub as `wpsapi`/`wpsApi`) for a
warehouse stock-tracking system for FRP / coated-FRP / filler materials.
Express + Postgres. **This directory is developed and run directly on this
machine** (`npm run dev` here, real `.env` with live secrets here, the
port-4000 server is `node src/index.js` from here) - there's no separate
`../api` directory to keep in sync with; this is the one source of truth.

Everything else in the repo is a client of this API, and **every one of them
owns a different person's job** - which is the context most of the design
decisions below only make sense in:

| client | who uses it | what it does here |
|---|---|---|
| `../WPS` (`wps`) | office / supervisor | Next.js dashboard: reports, balances, catalog, current lists, CIP export, order lists; also accepts a delivered order ("Zgadza się") or reports a problem on it. Browser-side, with `NEXT_PUBLIC_API_TOKEN`. |
| `../stock` (`frp`) | warehouse staff | Consumer-facing physical stock check/count. Dynamic app; has its own unprotected `/frp-list` route outside its CIP login gate. |
| `../smpda` | warehouse operator | Honeywell PDA (Flutter): scans labels, receives/issues stock, labels spools, fulfils material orders. The only client that pushes to CIP with the operator's own token. |
| `../smVendor` | forklift operator | Flutter phone app: takes a transport order, marks it delivered or reports a problem (`-> problem`, which then waits on the requester). |
| `../smOrder` | line foreman | Flutter phone/web app: places transport orders, tracks them, attaches a photo, picks materials off a CIP production order. |

Each has its own AGENTS.md; read that one before changing how a client uses
an endpoint.

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
  BOM's own raw `itemCode` is the *original*, pre-swap item - `from` - not
  the replacement). The line also keeps the raw list as `materialMappings`,
  for a mapping whose item isn't in this BOM at all.
  **What the API sends is normalized** (`withCatalogNames` in
  routes/cipOrders.js): a changed row's `itemCode` *and* `name` are both the
  item it was changed **to** - what the BOM would say if it were re-planned
  today - and the original stays available as
  `materialChange.from`/`fromName`. Only `name` used to follow the swap
  while `itemCode` kept the stale number, so a row read as the new
  material's name next to the old material's number and
  OrdersCipListTable.js's "Zamówienie materiału" picker ordered the wrong
  item number; `/materials/warehouse`'s own `sm_catalog` filter was matching
  the stale number too. Don't re-derive the swap client-side (wps's
  OrderMaterialsSearch.js did, which is why the other caller was wrong).
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

## Transport orders (`src/schema.sql`)
A module behind "Zamówienia": people on the lines ask forklift operators
("wózkowi", 3 shifts A/B/C) for a transport. **Our database is the source of
truth; orders are NOT mirrored to CIP** (for now). Was a draft
(`src/orders.draft.sql`, kept out of `npm run migrate` while the design
moved) - folded into `schema.sql` for real on 2026-09-29, unchanged, once
the shape settled; that draft file is gone. `node scripts/check-orders.mjs`
(renamed from `check-orders-draft.mjs`) still runs the whole schema in a
transaction against the dev DB, asserts 37 rules and rolls back (nothing
persists) - a useful regression check even now the tables are real, since
every statement in `schema.sql` is idempotent by design.

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
  START day]/[nth order of that minute]`, e.g. `C415/260924/1` (25.09 at
  01:15 - shift C started 24.09, 4th hour, first order of that minute).
  Time is Europe/Warsaw wall clock, so the hour digit is always 1-8 even on
  a daylight-saving night.
  - The suffix **counts within the minute and restarts at 1 in the next
    one** (the minute is already in the prefix, which is what keeps the
    whole number unique). It was 3 random digits until 2026-10-01: that
    made a number needlessly long (`/124` for the only order in its
    minute) and left two numbers from the same minute sorting arbitrarily.
  - `MAX(suffix)+1`, not `count+1` - a deleted row would otherwise re-issue
    a number that already existed. The advisory lock on the prefix (already
    there, to serialize same-minute orders) is what makes that read-then-write
    safe.
  - **Old numbers are not migrated and must not be**: people have them on
    paper. A minute that already holds one simply counts on past it (after
    `/124` comes `/125`), so both formats coexist in history for good.
    Nothing parses `order_no` - every client only displays it - so the
    change is display-only for them.
  - Within one shift-day the number now sorts chronologically, but **sort
    lists by `created_at` anyway**: across days the date sits in the middle
    segment, so a plain string sort is not chronological overall.
- `shift_code`/`shift_date` = the shift it was placed in;
  `completed_shift_code`/`completed_shift_date` = the shift that fulfilled it,
  derived from `completed_at` (no manual A/B/C marking).
- Status: `new` -> `in_progress` -> `delivered` -> `done`; `new` -> `done`;
  `in_progress` <-> `problem`; `delivered` -> `problem`; and
  **`cancelled` only from `new`**. Timestamps are filled by the trigger,
  `taken_by`/`completed_by` must be supplied. A closed order is frozen;
  number, type, requester and `created_at` never change.
- **An order can only be cancelled while nobody has started it** (since
  2026-10-01). Once a forklift operator has taken it, the only ways out are
  "zrealizowane" or the problem loop below - a transport somebody is already
  carrying must not be able to vanish from under them. `cancelOrder`
  refuses the rest with "Zamówienia w realizacji nie można anulować - zgłoś
  problem.", and so does the transition guard in `schema.sql`: the rule was
  being broken from the outside (a "Zgłoś problem" that cancelled), so an
  old client build still installed on somebody's phone cannot get round it
  either - it gets an error, which is also how a stale client makes itself
  known. wps is the only app that offers "Anuluj" at all, and only on a
  `new` order.
- **The problem loop** (added 2026-10-01). "Zgłoś problem" **never cancels
  an order** - it hands it to the other side, who has to answer it. One
  endpoint, both directions (`POST /:id/problem`, description **required**):
  - `in_progress -> problem` - the forklift operator cannot finish
    (smVendor). The **requester** answers, in smOrder or wps.
  - `delivered -> problem` - the requester rejects what arrived (smOrder or
    wps). The **operator** answers, in smVendor. This path used to be
    `POST /:id/cancel`, which ended the transport with nobody to answer.
  Either way the answer is "Problem rozwiązany"
  (`POST /:id/problem/resolve`, `problem -> in_progress`) and the work
  carries on from where it was, so **the loop can run more than once on one
  order, from both sides**. Only the side it was reported *to* is shown the
  button - offering it to the reporter would let them close their own
  report.
  - Columns: `problem_note` (what is blocking it *right now*, cleared on
    resolve), `problem_reported_by`/`_at`, `problem_resolved_by`/`_at`,
    and **`problem_reported_from`** - the status it was reported from, i.e.
    whose turn it is to answer (sent as `problemReportedFrom`). Without it
    the two directions are indistinguishable on the row.
  - Entering `problem` **clears `delivered_at`/`delivered_by`** (in the
    before-update trigger): a rejected handover did not happen, so it has
    to happen again - and that also takes the order out of the auto-accept
    sweep, which would otherwise close a delivery somebody just rejected.
  - A `problem` order stays in smpda's issuing queue too: the flag blocks
    the delivery, not the issuing, and is often about the stock itself.
  - Checked by `node scripts/check-problem-loop.mjs` - both directions, the
    refusals, the undone delivery, and the resulting timeline.
- **`order_events` is the audit trail** - one row per status move plus
  `created`, written by the `orders_after_insert`/`orders_after_update`
  triggers and read by `GET /:id/events` (oldest first). This is what makes
  a whole episode reconstructible: the order row only ever holds the
  *current* state, so a problem that was reported and then resolved, or an
  order blocked twice, exists nowhere else. **Rendered in wps only**
  (`OrderEventLog`) - the phone apps deliberately do not show it, they show
  what to do now.
  - The note comes in through the **transaction-local GUC**
    `wps.event_note` (`set_config(..., true)`), set by `setOrderStatus`
    inside its own transaction - a trigger cannot see a function argument,
    and this keeps the status change and its event one atomic write.
  - `actor` is derived per status from the row's own `*_by` column, so
    `auto` (the auto-accept sweep) stays distinguishable from a person
    confirming - "nobody answered" and "the requester agreed" are not the
    same fact afterwards.
- **The delivery/confirmation path is the same for every type.** The
  forklift operator presses "Dostarczone" in smVendor (`-> delivered`), and
  the person who ordered it then confirms ("Zgadza się", `-> done`) or
  reports a problem (`-> problem`, never `-> cancelled`) in smOrder or wps;
  doing nothing is also an answer, since the sweep auto-accepts after
  `AUTO_ACCEPT_MINUTES`.
  - An order **with** items (material_order, spool_order) can only be
    delivered once every item is issued - `deliverOrder` re-checks that
    server-side against `order_items_progress`, so a client whose checklist
    has gone stale cannot mark delivery early.
  - An order **without** items (water_refill, goods_transport,
    waste_removal, warehouse_return) is deliverable as soon as it is taken -
    there is nothing to issue. Until 2026-10-01 delivery was refused
    outright for those four, which left them with no confirmation step at
    all: they could only be closed from wps.
  - Checked end-to-end per type by `node scripts/check-delivery-flow.mjs`.
- **"Zrealizował" is not `completed_by`.** The API's `fulfilledBy` is
  `delivered_by || taken_by || completed_by` (see `orderRowToApi`): the
  employee who actually carried the transport out - the forklift operator
  who pressed "Dostarczone" (smVendor), or who took it when there was no
  delivery step. `completed_by` is only who *closed* the order - the
  requester accepting a delivery (`acceptOrder` copies `accepted_by` into
  it), a dashboard user clicking "Zrealizuj" in wps, or literally `auto`
  for the 10-minute auto-accept sweep - so it is the fallback only for an
  order closed without ever being taken. It is still sent raw as
  `completedBy` (plus `acceptedBy`) for anything that needs the closer.
- `order_items`: both kinds are counted by piece - `unit` is always `"szt."`,
  never `sm_catalog`'s own unit (km/kg/...), even for **material_order**.
  **material_order** still requires the item to be real: `item_name` comes
  from `sm_catalog`, an unknown item number is refused. **spool_order** items
  are physical spools, which the catalog has no notion of - not consulted at
  all (for now); `item_name` is whatever the caller sent (e.g. the spool
  type, "1610"), only required to be non-blank. Either type needs at least
  one item (checked at commit, so order + items insert in one transaction).
- `line_material_rules` (`line_name`, `item_no`, `note`): a standing
  instruction for a production line, in two flavours.
  - **Material-specific** (`item_no` set, unique per line+item) - e.g. line
    SH02 needs Glass Yarn/600tex issued as short lengths first.
  - **Line-wide** (`item_no IS NULL`) - about the line whatever is brought
    to it, e.g. "wjazd od strony hali B". At most one per line, enforced by
    the partial unique index `line_material_rules_line_only_idx`, because
    the plain `UNIQUE (line_name, item_no)` cannot: Postgres treats NULLs as
    distinct and would take any number of them.
  `line_name` must be a real production line (`locations.is_line`). A small,
  manually-kept reference table, not derived from anything; same "who
  maintains it" open question as the planned `material_mapping` (see roadmap).
- **How a guideline reaches an order** - resolved server-side, in one place,
  because wps used to match it in the browser and that left
  smpda/smVendor/smOrder showing nothing:
  - a material rule rides on the item, as `ruleNote` (joined in
    `order_items_progress` via the parent order's `to_location`);
  - a line-wide rule rides on the order, as `lineRuleNote`
    (`lineWideRulesFor` in orders.js) - repeating it under every material
    would be noise;
  - both are looked up **live**, so an edited rule applies to orders already
    placed, not just new ones. `""` for the ordinary case of nothing special.
  - `order_items_with_notes` (an older view doing the same join) is now
    redundant and unused - `order_items_progress` carries `rule_note`.
  - Checked by `node scripts/check-line-rules.mjs`.
  - wps still matches rules client-side in **one** place on purpose: the
    "Nowe zamówienie" form, where the order does not exist yet so there is
    nothing for the server to join against.
- `client_order_no` (optional): the company's own client order - what a
  customer ordered (e.g. fibre-optic products), separate from `order_no`
  (ours, generated) and from `details->>'production_order_no'`
  (material_order's own, used to query CIP - see roadmap). Not yet scoped to
  particular types.
- "Lista zamówień" = `new` + `in_progress` + `delivered`; "Historia
  zamówień" = `done` + `cancelled` (`STATUS_SETS`). A `delivered` order
  stays in the active list until it is really closed.

## Photos (`src/orderPhotos.js`)
Built and in use (this was roadmap step 4). **Storage is S3-compatible
object storage** - MinIO locally, see `../dockerPostgresql/AGENTS.md`; the
`minio` client speaks plain S3, so pointing `S3_ENDPOINT` at real S3 is the
whole migration. `order_photos` keeps only the key, never the bytes.
- `POST /orders/:id/photo` - multipart, one file under `photo` plus an
  `uploadedBy` field. In-memory (multer), 12 MB cap, `image/jpeg|png|webp|heic`
  only; anything else is a 400. Keyed
  `YYYY-MM/order-<id>/<uuid>.<ext>`, so the bucket stays browsable by hand
  and old months are easy to archive.
- An order carries `photo` (the first attachment, the shape wps's table and
  card already render) and `photos` (all of them), each with a **presigned
  link valid one hour**. Presigned, not a proxy route, because a browser
  `<img src>` cannot send an Authorization header; short-lived because every
  client re-reads the order anyway (wps polls, the Flutter apps poll) and
  gets a fresh link with it. Never cache or store these URLs.
- **`S3_ENDPOINT` must be a host the phones and browsers can reach** - not
  `localhost`, not the docker service name - because that host ends up
  inside the presigned URL. On the warehouse LAN use the same address wpsApi
  itself is reached at.
- If storage is unconfigured or down, uploads are refused with a clear
  message and order lists simply come back without photos: an order must
  never fail to load over an attachment.
- A client shrinks the picture before sending (smOrder does, via
  `image_picker`'s `maxWidth`/`imageQuality`); nothing re-encodes here.
- Checked by `node scripts/check-order-photos.mjs` (needs the dev API and
  MinIO up): uploads a real file, re-reads the order, fetches the presigned
  link with no auth header, compares bytes, and asserts a non-image is
  refused - then deletes both the order and the stored object.
- Open: retention and backups (the bucket is the only copy), and whether
  wps's own "Nowe zamówienie" form should upload too - it still only picks a
  browser-local blob and drops it, while smOrder is wired end to end
  (`waste_removal` so far).

## Roadmap (agreed direction, in order)
1. **Per-user auth.** After a successful CIP login, wpsApi issues its own
   short-lived JWT (employee number from CIP + a role from a local role-mapping
   table: orderer / forklift / supervisor). Today there is only the shared
   `API_TOKEN` (see Auth). Prerequisite for the next step.
2. **Hasura on the existing Postgres** - started (2026-09-29): a
   `graphql-engine` service now runs alongside `postgres` in
   `../dockerPostgresql/docker-compose.yml`, same database, admin secret in
   that folder's own `.env` (gitignored - see `.env.example` there). Only
   `sm_items`/`sm_units` are tracked so far (with `sm_items.units` as an
   array relationship), each with a `SELECT`-only permission for a `user`
   role - `HASURA_GRAPHQL_UNAUTHORIZED_ROLE=user`, so wps's browser-side
   subscription (`lib/hasuraClient.js`) needs no auth header at all, same
   low-friction shared-access model the rest of this app's own auth already
   uses (see "Auth" above). **Hasura is read-only** - its own mutations are
   never used, so every write still goes through this API (CIP sync,
   catalog-name enforcement, ...) and can't be bypassed by writing straight
   to a table. wps's `SmMaterialsPanel.js` subscribes to a minimal
   `{ item_no updated_at }` change signal and, on every tick, just re-runs
   its existing REST fetch (`loadItems()`) rather than shaping row data a
   second time in GraphQL - confirmed live: a `PUT /sm-items/:itemNo` (the
   same path smpda's own receipt/issue and wps's own edits use) pushes to
   every open "Materiały SM" tab within about a second, wps or smpda either
   one. Metadata isn't exported to git yet (still just `sm_items`/
   `sm_units`, set up via the Metadata API directly) - do that once more
   tables are tracked and the shape has settled. `orders.draft.sql` is now
   folded into `schema.sql` for real (see "Transport orders" above) -
   subscriptions for the orders module specifically are still ahead; extend
   the same tracked-tables/permissions pattern to any table that needs live
   updates next (transport orders when
   that module goes in, catalog, ...).
3. **WPS**: Lista zamówień and Historia zamówień are on this API for real
   now (not the demo seed, not Hasura - plain REST with a 5 s poll), and
   "Zrealizował" is wired (see "Zrealizował is not completed_by" above).
   Left: the fulfilling-shift columns, and renaming "Zamówienia CIP" once
   nothing there is CIP any more.
4. **Photos** - done (2026-10-01), see the "Photos" section above. MinIO was
   the chosen storage. What is left is retention/backups, and deciding
   whether wps's own form should upload as well as smOrder's.
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
