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

## Production progress (`src/productionProgress.js`, `POST /cip-orders/progress`)
"Postęp produkcji" / "Production progress" (wps: Zamówienia → Postęp
produkcji). The planners keep a list of what runs on which production line;
it is pasted in whole and answered per position with **how long the run is
and how much of it is still to be made**. Live against CIP on every request,
nothing stored, needs the caller's own `X-Cip-Token`.
- The pasted list is a line, then its positions under it
  (`ST01` / `CF-260010303028101-544182`). **`CF-...-...` is CIP's own
  `erpNumber`** - confirmed against real data on 2026-10-08: one CIP row per
  production line of an order, each with its own erpNumber, length and
  per-stage figures. The middle segment is the `orderNumber`.
- **Either form is accepted, mixed in one paste**: a job number
  ("CF-260010303028101-544182") is one line of one order, a bare order
  number ("260010303028101") is every line of it. The lists come in both
  shapes and the order number is the one the planners always have, so the
  parser takes both - an order-number entry has `erpNumber: null` and its
  result rows carry `wholeOrder: true` plus whichever job number CIP gives
  each line.
  - A bare number needs **8+ digits** (both "20260401" and the 15-digit
    "260010303024501" are real order numbers) while a position suffix is
    six, so a stray "544182" on a line of its own is not taken for an order.
  - A row carrying a job number is never *also* read as a bare order number -
    the job number's own middle segment matches that pattern too, so the two
    are looked for one after the other, never together.
  - Because one entry can become a dozen rows, `MAX_PROGRESS_ROWS` (600)
    bounds the **result**, checked after the cheap searches and before the
    per-position material fetches; `MAX_PROGRESS_POSITIONS` (400) still
    bounds the paste itself.
- **CIP cannot filter by erpNumber**, so a position is found by searching its
  order (`findCipRowsByOrderNumber`) and matching the erpNumber in the
  result. That is also the dedup: a real list of 26 positions was only 16
  orders (one order held 6 of them), so it is one search per order, 4 at a
  time.
- The text is parsed **server-side** (`parsePastedProgressList`) so one
  tested parser serves every caller. A row's *content* decides what it is,
  not its indentation - the same list arrives indented from a browser and
  tab-separated from Excel, and a textarea loses leading whitespace.
- **`layersFinishedLength` is not what has been produced.** That name is a
  trap: it is always exactly equal to the row's own `totalLength`, i.e. the
  length the layer is *planned* for, so reading it as "done" reports every
  order as complete. The progress is `layersNotFinishedLength` - what is
  still to run - and produced = total - that. Verified on all 12 lines of
  order 260010303024501: every finished line (opStatus 5) reported 0, and one
  line reported 44 km total with 4 km left, i.e. 40 km made and still
  running.
- The headline km figures come from the **SH (sheathing) stage**
  (`shProcess`), the one whose lengths are in cable km like `totalLength`
  itself.
- **Every stage is also reported in its own right**, as `processes` per
  position plus a `processKeys` list for the whole result
  (`rowProcesses`/`presentProcessKeys`): what is left of that stage and what
  it is out of. CIP has fifteen (`sc cl rl dt rb sl sz rs sh fh uu ac we dp
  tb`, in that key order, which is the route's order) and most are null on
  any given cable - a real order used four and the other eleven were null on
  all twelve of its lines, so `processKeys` carries only the stages
  something in the result actually reports on and the rest never become
  columns.
  - **A stage is measured against its own planned amount, never the run's
    length**, because the units differ per stage: SC (stranding) plans the
    run times the number of elements it strands (a 44 km run reported 264, a
    12 km one 72), so comparing that to `totalLength` would read as 600%
    complete.
  - Two shapes, same meaning: most stages carry `orderProcessLayers`
    (`layersFinishedLength`/`layersNotFinishedLength`), DP reports flat
    (`finishedLength`/`notFinishedLength`). **The naming trap applies to
    both** - the "finished" field is the planned amount.
  - A stage present but reporting all zeros is treated as no data, like a
    null one: a column of dashes is not a completion state.
  - Stage figures are summed across layers here (the headline takes the max
    instead - see rowProgress): a stage's own planned amount is the
    denominator, so summing both sides keeps its percentage self-consistent.
    Every row seen so far has exactly one layer, so the two agree today.
  - **Every row also carries `lineRemainingLength`**: what is left **for the
    line this row was pasted on**, in kilometres of cable - its own stage's
    remainder, converted out of that stage's unit (`remainingInCableKm`).
    Not the same number as `remainingLength`, and both are true: a position
    can be stranded and still have its whole jacket to go. A screen with room
    for two figures shows both; one with room for one (the Excel export's
    three columns) shows this one, because it is what the line is planned by.
    A line whose stage is unknown falls back to the order's remainder - there
    is no stage to read instead. Asked for on 2026-10-13.
  - **A material's `remainingQuantity` is scaled by the stage that will
    consume it, and which stage that is depends on which list it is in**
    (`materialsForLineStage`, 2026-10-13):
    - in a **stage cell** (`processes[key].materials`) each material keeps
      **its own** stage's share - the cell is asked what that stage has left;
    - in the **position's own list** (`materials`, what the plain view and
      the export read) every material is scaled by **that line's** stage -
      the list is read as "what does this line fetch for this order".
    Scaling an ST line's FRP by what the whole order had left ordered FRP for
    cable laid up days ago; it also cannot follow CIP's own `process`, which
    files FRP under "SC", the stage that extrudes the tubes. The share is a
    ratio inside one stage, so no unit conversion is involved: 240 of 800
    tube-kilometres is the same 0.3 as 60 of 200 cable ones.
  - Each stage also carries **`inRunKm`**: whether its figures are the
    cable's own kilometres, so a caller knows when it may write "km" next to
    them. True when the stage plans exactly the run's length (SH, SZ, DP);
    false for SC, whose 264 against a 44 km run is not kilometres of cable.
- **What a day's run takes of each material, and how many packages that
  is** (`packagesForDay` / `packagesForDayByGroup`, sent as
  `packages: { frp, tube, jacket }`). **One function counts every group**,
  since only the packaging differs - `PACKAGE_RULES`: an FRP **roll holds
  48.8 km**, a **bigbag of compound or granulate 500 kg**. With the third figure
  from the people who run the lines (2026-10-09, revised twice since), a line
  getting through **55 km of cable a day** - the average actually run (55,
  then 60 on 2026-10-12, back to 55 on 2026-10-14) - that is
  everything the count rests on. **This is what keeps a 150 km order from
  being ordered in one go**: the count is what the day in front of the line
  takes, and tomorrow is counted again. (48.8 km
  is theirs; the 500 kg bag is the standard size the warehouse's own stock
  is split into - the same figure wps's `lib/smMaterialsSeed.js` splits a
  real CIP inventory export by.)
  - **Those sizes are only defaults.** Bags and rolls really do differ per
    material, so a caller may send `packageSizes: { "<itemNo>": <number> }`
    and that item is counted by its own size instead
    (`packageSizeFor`). wps types them in on the screen itself. Run
    through `sanitisePackageSizes`, which **drops** a zero, a negative, a
    non-number or an absurd size rather than refusing the request: one bad
    cell in a settings panel must not cost the whole answer. Only the size
    ever travels - how a package is counted stays here.
  - `daySharesForLine` hands the day out to the line's positions **in the
    order they were pasted**, since a line finishes what it is on before
    starting the next: 35 km left on one position and 45 on the next is 35
    of the first and 20 of the second, not 55 of either.
  - Each share is turned into material by that material's own `perKm`,
    then into packages with `Math.ceil` - a day of 55 km at 1.017 is
    55.935 km of FRP, which is **two** rolls of 48.8; the same day at 42 kg
    of compound per km is 2310 kg, which is **five** bigbags of 500.
  - **A line is only counted for what its own stage puts into the cable**
    (`STAGE_MATERIAL_GROUPS` / `materialKeysForLineProcess`, 2026-10-12,
    corrected 2026-10-13): **FRP** on the lines that lay the cable up (`sz` -
    the ST lines), the **tube granulate** on the ones that extrude the tubes
    (`sc` - the SC lines), the **jacket compound** on the ones that sheath it
    (`sh` - SH and FC). A position carries the **whole cable's BOM** whichever
    line it is pasted on, so without this an order pasted on both its
    stranding and its sheathing line had its FRP counted twice and its
    compound counted twice - and the sheathing line was sent a roll of FRP it
    cannot use. **This cannot be read off the BOM's own process codes** (CIP
    files FRP under "SC" while the ST line running it is stage "SZ"), which is
    exactly how the FRP once vanished from the lines that need it - and then,
    read the other way round, how it turned up on the SC lines, which only
    extrude tubes (reported 2026-10-13). **What the SC stage is, its own
    figures say**: it plans the run times the number of tubes (672 against a
    168 km four-tube run), so it is a stage that makes tubes, not one that
    lays a cable up. Every row also carries `lineMaterialKeys` so a screen
    filters the same way instead of inventing its own answer; a line whose
    stage is unknown keeps every kind.
  - **A line's first position gets no FRP when under 15 km is left of it**
    (`PACKAGE_RULES.frp.skipFirstBelowKm`, 2026-10-12): the roll already on
    the payoff sees a tail that short out, and one fetched for it would come
    back nearly full. **First position only** - what is on the machine now -
    and **FRP only**: those kilometres still count towards everything else,
    the compound included, because the line does produce them. A line that
    is nothing but a short tail therefore has no FRP entry at all.
  - **Whether a package can be shared is per group** (`PACKAGE_RULES`'
    own `pooled`), and it is physical:
    - an **FRP roll sits on one machine's payoff**, so it is counted **per
      line**: two lines running the same FRP need their own rolls even if
      neither gets through a whole one, and pooling would say one where two
      are needed;
    - a **bigbag feeds whatever asks for it**, so it is counted **once over
      the whole day**: two orders needing 200 kg each are one bag, not two.
      Told to us on 2026-10-12, after the first version counted bags per
      line the way the rolls are counted and over-ordered them.
    A pooled item's `lines[].packages` is therefore `null` - only the
    amounts are per line - and the item carries `pooled` so a screen can
    say which it is. **Nothing may sum `lines[].packages` to get the
    total.**
  - **A stage counted in its own units is converted back to cable first**
    (`remainingInCableKm`, 2026-10-13). The daily capacity is a figure about
    cable, so what it is handed out against has to be one too: secondary
    coating plans the run times the tubes it extrudes, and that multiplier is
    exactly `planned / totalLength`, so dividing by it gives back the cable
    the stage has left (240 of its own units on a four-tube cable = 60 km).
    Read off the row's own two figures, never off the cable type, which
    nothing here parses. Until this existed an SC line dropped out of the
    day's counting altogether and the granulate it extrudes was never ordered
    for it; a stage with nothing to convert by still gets no share.
    **The day's figure is assumed to hold for an SC line too** - it is the
    only capacity anybody has given us; if a tube line's day is a different
    number, `LINE_DAILY_KM` has to become per stage.
  - A group with no entry in `PACKAGE_RULES` is simply not counted, and a
    group nothing in the paste needs comes back as an empty array - which
    the screen leaves out, the same rule `materialKeys` follows for the
    columns.
  - The response carries **`dailyKm`** alongside `packages`, so the screen
    can head those panels with the day they rest on instead of keeping its
    own copy of the figure.
  - Each item carries **`lineCount`** - on how many production lines the
    day needs that material (2026-10-14). It is a field of its own rather
    than something a screen counts off `lines`, because what makes a line
    one that needs the material is this rule: a line whose share rounds to
    nothing (0.0004 kg) is left out of **both** `lines` and the count. It
    is counted **the same way for a pooled group as for a roll** - how many
    machines a material has to reach is a question about the floor, not
    about packaging, so a bigbag that is one count for the day can still
    have to be carried to four places.
  - Each item (and each of its lines) also carries **`perKm`, weighted by
    the cable the amount came from** - `needed / cableKm`, where `cableKm`
    is the cable those day-shares account for (2026-10-12). It has to be
    weighted: a material's rate is per *cable*, so averaging the rates of
    two cables plainly would not reproduce `needed`. `cableKm` is sent only
    so the figure is auditable; nothing reads it on its own.
- **Consumption per kilometre of cable** (`perKmConsumption`, sent as a
  material's `perKm`) is **derived from the run, not read off CIP's own
  `qty`**: that field's base is not always the cable kilometre. FRP's 1.017
  does divide the run on 997.5 km, 168 km and 36 km alike, but a real
  tube-filling gel row read `qty` 2.810177 against 1112.830092 required on a
  198 km run - 396 units, twice the run. Dividing the required amount by the
  run's own length is right whatever CIP counted in. Shown in wps's plain
  view only.
- **Which stage a production line runs** is `processForLine`, sent on every
  row as `lineProcess`: ST strands (`sz`), SH and FC sheathe (`sh`), SC is
  `sc`, matched on the line name prefix. Given by the people who run the
  lines on 2026-10-09 - **nothing CIP sends says this**, so it is written
  down here rather than guessed per screen, and a line the naming says
  nothing about (FL01, a free-text place) comes back null for the caller to
  report as unknown instead of showing some other stage's figures. wps's
  plain view is the caller: one stage column, the line's own.
- **An erpNumber can match more than one CIP row** (seen live:
  `CF-260010303024501-544065` is both line (2) and line (12) of its order,
  with different lengths) - each match is its own result row. A position CIP
  does not know comes back `found: false` rather than being dropped.
- **Which materials a position needs** ride on the same response, as
  `materials` (`{ frp: [...], pe: [...] }`, `attachBomMaterials` in
  routes/cipOrders.js) plus a `materialKeys` list for the whole result:
  CIP's own bill of materials per position, sorted into the kinds this
  screen calls out. Measured live - 26 positions, so 52 extra CIP calls, in
  1.7 s - so it is always fetched rather than being a second request or a
  per-row expand. A group nothing in the paste needs is left out of
  `materialKeys` and never becomes a column, the same rule the stages
  follow.
  - The BOM is fetched by the row this screen **already has**
    (`cip.js`'s `cipOrderBomForRow`), not by searching for the line again:
    that saves a search per position and, because the progress search asked
    for every `workStatus`, it also works for a line CIP has already
    finished.
  - **The groups match on different signals, and swapping one breaks it**
    (`MATERIAL_GROUPS` in productionProgress.js, listed in the order the
    cable is built in: the strength member, the tubes around it, the jacket
    over them):
    - **FRP by name.** Every item in the catalog's "FRP" category does have
      FRP in its name, but seven more are filed under "PL-MAT" ("FRP with
      steel wire reinforced Φ0.45mm×1.5mm"...) and "GLYCL" ("FRP 3.4mm/VIP",
      "GFRP/0.7*0.75mm"), all sold by the kilometre like the rest - a
      category check would miss seven of the sixty-three.
    - **`jacket` by category**, exactly `"PE"` or `"LSZH"`: one job done by
      two compounds (15 PE items against 32 LSZH ones, so PE alone would miss
      every flame-retardant build).
    - **`tube` by category**, `"PBTP"` or `"PBTB"`: the granulate the loose
      tubes are extruded from, 4 items, in kg and in bigbags like the jacket
      compound. **PBTB is the floor's own name for it** - the catalog only has
      PBTP, so both are matched and nothing hangs on which turns up. Added
      inside `jacket` on 2026-10-12 (asked for as "PBTB") and **split out on
      2026-10-13**: bagged the same way, but **eaten by another machine**, so
      in one group with the jacket it was listed for the SH lines and never
      for the SC line that extrudes it.
      Never a `… Masterbatch` category, in either group: "PE" as a *name*
      fragment matches every "TPEE"/"TPEE Masterbatch" row (21 items that are
      not PE), and "PE Materbatch" / the three "PBTP Masterbatch…" categories
      (36 items) are colourant *for* the compound, not the compound.
    All checked against the live catalog on 2026-10-08, PBTP on 2026-10-12. The groups are
    **not exclusive**: nothing downstream may assume a material is in at
    most one.

  - Matched against **our catalog's** own name and category
    (`smItemNames`/`smItemCategories`) and only for items this warehouse
    stocks (`knownSmItemNos`), never CIP's own description - otherwise the
    match would depend on how CIP happens to word a row. Substitutions go
    through the shared `withCatalogNames`, so a swapped material is reported
    as the item actually to be used now.
  - **Each material names its own stage**, in the BOM row's `process`
    field ("SC", "SH", ...) - captured live on 2026-10-09 alongside `layer`
    and `operationCode` ("SC58"). Those are exactly the codes PROCESS_KEYS
    uses, so the two line up with no mapping table to keep in step.
    `groupBomMaterialsByProcess` sorts the materials by it and they ride on
    the stage itself, as `processes.<key>.materials`; a material naming no
    stage, or one this row does not run, is left out rather than parked
    under an arbitrary one.
  - `requiredQuantity` is CIP's own figure for the whole run;
    **`remainingQuantity` is that scaled by how much of **its own stage** is
    still to make** (the run as a whole only for a material whose stage is
    unknown) - stranding can be finished while sheathing has half the run
    left, and one figure cannot be right for both. It is - derived as a proportion of the required amount rather than by
    multiplying CIP's per-km `qty`, so it holds whatever unit the material is
    counted in. (The two do agree: a 997.5 km run needing 1014.4575 KM is
    exactly 1.017 per km.)
- `node scripts/check-production-progress.mjs` asserts the parsing, the
  arithmetic, the stage reader and both material-group rules against real
  captured row shapes and real
  catalog/BOM names - **needs neither the database nor CIP**, which is the
  point: the alternative is a live token and a half-finished production order
  every time somebody touches this.

## `workStatus` on CIP's order search
Known since 2026-10-08, confirmed live on order 260010303024501 (12 lines):
**"0" is every status, "4" only unfinished lines, "5" only finished ones.**
This is the filter `ORDER_SEARCH_PATH` takes, and it was previously captured
from CIP's UI with its meaning unknown.
- `findCipOrderLines` sends **"4"**, so it **cannot find a production order
  whose line is already finished** - 5 of those 12 lines are invisible to it,
  and with them to wps's "Zamówienia" search and to "Zamówienie materiału"'s
  own material picker. Left as it is for now rather than widened as a side
  effect of the work that uncovered it; decide whether looking up a finished
  order's BOM should work before changing it.
- `findCipRowsByOrderNumber` (production progress) deliberately sends "0",
  because "how much is left to make" has to be able to answer zero.

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

## WMS login (`src/wms.js`, `POST /api/wms/login`)
**WMS is not CIP.** It is the plant's own warehouse system
(`https://wms.yofc.com:8181`, `WMS_BASE_URL`), a different server with
different accounts, and an issue list has to exist in it. The person at the
desk is already signed into wps with their CIP account, which WMS knows
nothing about, so wps asks them for a second login - that is what this route
is for, and the whole of what it does. Added 2026-10-13 for wps's
"Wydania WMS".
- Proxied server-to-server for the same reason CIP's login is: WMS sends no
  CORS headers, so no browser can call it.
- **Behind `requireAuth`**, unlike `/api/auth/login`: the only caller is
  wps's own server, which already holds the shared token, and a login proxy
  nobody has to be let into is one fewer open door. Rate-limited the same
  way (10 per 15 min per IP) - this route forwards whatever credentials it
  is given straight to WMS, so nothing else stops repeated attempts.
- **Nothing is stored here.** The session comes straight back to the caller;
  wps keeps it in an httpOnly cookie of its own (`lib/wmsSession.js`), so it
  lives exactly as long as the person at the desk is working. There is no
  refresh - WMS gives nothing to refresh with, so the first call WMS refuses
  is what says the session is gone, and the answer is to sign in again.
- The request is the one WMS's own login page makes, captured 2026-10-13:
  `POST /ilcwmsbase/userlogin/authlogin`,
  `{ userNo, pwd, invokerParam: 1 }`, with `x-requested-with:
  XMLHttpRequest` - without that header the framework can answer with its
  own login HTML instead of JSON.
- **Whether WMS accepted is not in its status code and not in a flag**:
  it answers **HTTP 200 either way** and words a refusal as
  `{"msg":"Login failed, please re-enter user and password!","code":"sys0049"}`
  (captured live with an account that does not exist). What it really turns
  on is **the session itself** - WMS hands over `WMS_AUTH` as a cookie and a
  refusal *blanks* it (`WMS_AUTH=; Path=/; Secure; HttpOnly; SameSite=Lax`) -
  so `wmsSessionFrom` accepts exactly when something came back to be
  recognised by, which is the one signal a refusal cannot produce. Reading
  `code` instead would mean guessing which of sys0049's siblings means yes,
  and guessing wrong tells somebody whose password was right that it was
  not. **A cookie with no value is therefore not a session** - that rule in
  `sessionCookie` is what the whole thing rests on.
  - A token in the body is accepted as well (`TOKEN_FIELDS`), because the
    login's own request sends `credentials: "omit"` - WMS's page cannot be
    keeping that cookie either, so a real success may carry the same thing
    in its payload. Either will do; `wmsPost` sends back whatever it was
    given.
- **Its certificate is fine**: checked live 2026-10-13, port 8181 serves a
  GlobalSign `*.yofc.com` certificate that validates normally and **expires
  2026-11-23**. `WMS_TLS_INSECURE` exists for a renewal onto an internal CA
  and is off by default - credentials travel over this, so trusting any
  certificate is a decision somebody makes knowingly, in `.env`. Check that
  expiry date before anybody reaches for the switch.
- **Nothing credential-shaped is ever logged.** A refusal logs WMS's own
  `msg`/`code`, an acceptance logs the reply's **field names** only - which
  is how a token field WMS turns out to use gets added to `TOKEN_FIELDS`
  without a single value of anybody's session being written down.
- `node scripts/check-wms-login.mjs` pins all of it - the 200-with-a-refusal,
  the blanked cookie, an unfamiliar success code, a split cookie, a body
  token, the login page instead of an answer - against the real captured
  replies and **needs neither WMS nor a password**.
- **A later call sends the session twice**, as WMS's own pages do:
  the `WMS_AUTH` cookie *and* the same id again in an `authentication-info`
  header (`authInfoFor` - the body token if the login gave one, otherwise
  the value out of the cookie; **inferred**, since the only login reply we
  have captured is a refusal and carries no id). `app-module-number` goes
  with it and is **per screen** - `WMS_MODULE_ISSUE` ("100400010001") is
  the out-notice one.

## WMS item lookup (`POST /api/wms/items`)
Resolves item numbers against WMS's own item master, for wps's issue-list
grid: a column of numbers is pasted and every row fills in its name,
specification and unit. The request is the one WMS's `addoutnotice` screen
makes, captured 2026-10-14:
`POST /ilcwmsbase/bmitem/getbmitemlistbyparams`, body
`{ condition: { orgNo, keyword, statusCode: 1, field: "itemNo", order: "asc" }, current: 1, size: 20 }`.
- Body `{ orgNo, keywords: [...] }`, session in **headers** (`X-Wms-Cookie`,
  `X-Wms-Auth`) - credentials belong where this repo's other per-user tokens
  go (`X-Cip-Token`), not mixed into the query they authorise.
- **The answer is keyed by the keyword that was asked**, never by the item
  number WMS came back with, so a caller can match a reply to the grid row
  it belongs to even when nothing matched.
- **`statusCode: 1` is WMS's own**: only items in use, so a discontinued
  material cannot be put on a new issue note.
- WMS has no batch lookup, so a pasted list of 30 is 30 calls - four at a
  time (`ITEM_LOOKUP_CONCURRENCY`, the same as the CIP order searches),
  capped at `MAX_ITEM_KEYWORDS` (200) with a 400 rather than a request that
  quietly loses the tail. Duplicates are asked once.
- **A search is not a get, so which row the keyword meant is decided**
  (`matchWmsItem`): an **exact** item-number match wins outright; a search
  that returned exactly one row is taken; **anything else fills nothing**
  and comes back `"ambiguous"` with the count. On an issue note a quietly
  mis-picked material is the kind of mistake that leaves the warehouse.
- **"Not logged in" is an HTTP 200 with no rows** - captured live on
  2026-10-14 with an all-zeros session id:
  `{"code":"000701","msg":"User not logged in"}`. Anything that just counts
  rows reads that as "no such item", so a whole pasted list would come back
  marked as unknown materials with nothing on screen about signing in.
  `wmsNotLoggedIn` is checked **before** the rows are, and the route answers
  401 `wms_session_expired` so wps can ask for the sign-in again. This is the
  single most important thing to keep right in this section.
- The reply's own shape has **not** been seen: reading it needed a live
  session, and a session is somebody's password. So `wmsRowsFrom` accepts
  every container this family of frameworks uses (`data.records`/`list`/
  `rows`, `data` itself, the body itself) and `ITEM_FIELDS` lists several
  spellings per field, first non-blank wins - an unexpected one costs a
  blank cell, not the lookup. The **field names** of the first real reply
  are logged once per server run (names only, never values); that is how
  those guesses become the real spellings.
- The raw WMS row is **not** passed on - only `{ itemNo, itemName, unit,
  spec, category }`. A screen rendering whatever WMS happens to send breaks
  the day WMS adds a field.
- `node scripts/check-wms-login.mjs` covers all of it: the not-logged-in
  reply against a genuinely empty search, every row container, the field
  spellings, and each of `matchWmsItem`'s four verdicts.
- Creating the note and listing what has been created are their own
  sections below.

## The issue header's own lists (`POST /api/wms/organizations`, `/warehouses`, `/document-classes`, `/pick-rules`)
**Every field of WMS's issue-note header but the remark** is a list in WMS
and must be one in wps too - a code typed by hand is one WMS rejects at
save time with nothing on screen saying which field was wrong. All captured
from `addoutnotice`, the last three on 2026-10-14 and the organizations on
2026-10-15:

| field | WMS path | body |
| --- | --- | --- |
| organization + source organization | `/ilcwmsbase/bmorg/getbmorglistbyparams` | paged, `statusCode: "1"`, **no `orgNo`** |
| source + destination warehouse | `/ilcwmsbase/bmwarehouse/getbmwarehouselistbyparams` | paged, `statusCode: "1"` |
| document class | `/ilcwmsbase/bmclassifytype/getBusinessClassifyTypeListByParams` | paged, `statusCode: "1"`, `bigModule: "0"` |
| picking rule | `/ilcwmsbase/tooracle/getpickrule` | **not paged**: `{ condition: { organizationCode, dateFrom: "", dateTo: "", ruleName: "" } }` |

- **Two pairs of fields read one list each.** Both warehouses: the
  destination of an issue note is another of the same organization's
  warehouses (confirmed 2026-10-14). Both organizations: the source
  organization is another entry of the same `bmorg` list (2026-10-15).
  Each pair is one request, not a second list that looks alike.
- **The organizations are the one list not scoped by an organization** - it
  is the list of them - so its captured body carries no `orgNo` at all.
  That is why `pagedBody` takes the **whole** condition rather than an
  organization plus extras, why `referenceRoute` has a `requiresOrg` flag
  instead of demanding one from every list, and why the screen must not
  clear or re-fetch it when the organization changes.
  - It **does** check the session, unlike `getpickrule`: verified live
    2026-10-15 with an all-zeros id (401 `wms_session_expired`). Two
    endpoints of the same application differing on that is exactly why
    `wmsNotLoggedIn` is checked on every one of them rather than on the
    ones that seemed to need it.
- **Each list brings its own body** (`listWmsReference` takes one;
  `pagedBody` is what the two master-data lists share): the picking rules
  are not paged and name the organization `organizationCode` where the
  others page and call it `orgNo`. What the helper actually shares is the
  part worth sharing - the 000701 check, the row-container search, the
  field-name log and `referenceOptions` - so a fifth list inherits the
  rules instead of re-deciding them.
- Body `{ orgNo }`, session in the same two headers as `/items`, and
  **`orgNo` is required with no default**: another organization's warehouse
  or document class is one nobody here can put on a document, so an empty
  one is a 400 rather than a guess.
- `statusCode` is the **string** `"1"` in the paged two, where the item
  search sends the number `1`, and `bigModule: "0"` is WMS's own (the
  classify types belong to several modules and `0` is the set this screen
  offers). That is what each screen sends; handing WMS back exactly its own
  request is cheaper than finding out which spelling it is strict about.
- `size: 1000` is WMS's own, i.e. "all of them": a plant has tens of
  warehouses and a handful of document classes, so each list is one call and
  then a select, not a search box over something that fits on screen.
- **Both answer `{ options: [{ code, name }] }`**, not WMS's rows: the
  screen does not have to know which WMS table an option came out of, and
  the raw row is not passed on for the reason the items' is not.
  `referenceOptions` drops a row with **no code** (an option whose value
  cannot be submitted is worse than a shorter list), keeps one with no name
  (pickable by code), deduplicates by code and keeps WMS's own order.
- The **000701 rule applies here too** and for a sharper reason than on the
  items: a dead session answers 200 with no rows, which reads as "this
  organization has no warehouses" - an empty select with nothing on screen
  to act on. `wmsNotLoggedIn` is checked before the rows and the route
  answers 401 `wms_session_expired`. Verified live on 2026-10-14 against
  both paths with an all-zeros session id.
- Each list's field names are logged once per server run, names only
  (`[wms] warehouse list reply fields: ...`, and so on), which is what turns
  `WAREHOUSE_FIELDS`' and `CLASSIFY_TYPE_FIELDS`' candidate spellings into
  the real ones.
- **The picking rules are the one reply we have actually seen**, because
  `getpickrule` turns out **not to check the session at all**: an all-zeros
  one gets the same list (2026-10-14). One row of org 460, verbatim but for
  the timestamp:
  `{ pickRuleName: "YOFC POL pick", organizationCode: "460", autoShipConfirmFlag: "N", pickRuleId: "510", lastUpdateDate: ... }`
  under `data.records`, in an envelope whose **success** code is `"000001"`
  with `msg: "成功"` - one more reason no `code` value may be read as
  success or failure anywhere here. `PICK_RULE_FIELDS` is therefore
  captured, not guessed; it keeps `codeFromName` as a fallback so a rule
  sent without an id is still selectable rather than silently missing, and
  that fallback is **this list's alone** - a warehouse with no number is a
  row nothing can be done with.
  - Do not read that endpoint's openness as licence to drop the 000701
    check elsewhere: it is harmless only because the answer is the same
    either way.
- Still free text: **remark** alone, which is a sentence somebody writes.

## Creating the issue note (`POST /api/wms/issue-notes`)
The one WMS call here that **changes anything**. WMS's own save, captured
2026-10-14: `POST /ilcwmswms/outnoticehead/addoutnoticehead` - note the
different application, `ilcwmswms`, where every read above is
`ilcwmsbase`.
- **A `detailList` row is WMS's own item row, sent straight back**: not a
  position built from five fields but the whole `bmitem` record - every
  `guestCol`, `lotRuleNo`, `shelflife`, `itemPrice` - plus `applyQty` (a
  **string**), `cellNo`, twelve empty `lotAtt01..12`, `combinationLotNo`
  and `itemFlag: "1"`. So this route **looks every item up again** and
  sends back what WMS answers with (`wmsIssueDetailRow`). Two consequences
  worth keeping: the browser never holds those rows (`/items` strips the
  raw row out of its answer), and what the document carries cannot have
  drifted from what WMS currently has.
  - The row keeps **WMS's own `id`** when it has one - this framework keys
    records by a 32-hex id and the captured detail row carries exactly such
    a value - and is given a fresh one only when WMS sent none.
- **The header sends codes and their labels, and not in the obvious
  direction**: `pickRule` is the rule's **name**, while `pickRuleName` is
  `"510-YOFC POL pick"` - its id and name joined. `classifyType` is the
  code with `classifyTypeName` beside it. The screen therefore sends only
  the codes it picked and **the labels are resolved here** against WMS's
  own lists; `autoShipConfirmFlag` likewise comes off the chosen picking
  rule's record rather than being defaulted.
- `wmsIssueHeadPayload` sends **every key the capture sends, in its order,
  including the sixteen it sends empty**. A key WMS's own screen always
  sends is not one to leave out on the theory that it is optional, and
  `check-wms-login.mjs` asserts the key list against the capture.
- Inferred, and the only thing here that is: **`inCellNo`** - the capture
  puts the destination warehouse's own code there with a label of
  `"<code>-Cache location"`, i.e. its default cell, and the request that
  lists the cells has not been captured. With no cell chosen the
  destination warehouse stands in and the label is left to WMS.
  `docNature: "20"` and `standardCol01: "0"` are constants in the capture
  and nothing on the screen sets either.
- **What it refuses matters as much as what it sends.** A header missing
  any of organization / bill date / document class / both warehouses is a
  400; a position with no quantity is a 400; a position whose item number
  is not an **exact** match in WMS's item master stops the whole list
  (422 `wms_unknown_items`) - a mis-picked material on an issue note
  leaves the warehouse. A dead session is caught at the item lookup, so
  **nothing is posted** (verified live 2026-10-14 with an all-zeros
  session: 401 `wms_session_expired`, no document).
- **Only `code: "000001"` is a save.** That is the one success code this
  family of endpoints has ever shown us (`getpickrule`'s reply), so
  anything else is a 422 `wms_rejected` carrying **WMS's own message**.
  Reporting a document as created when it was not is the one outcome
  nobody can recover from; a refusal somebody can read is recoverable.
  When a second success code turns up, widen `WMS_OK_CODE` - do not
  loosen this into "anything that is not an error".
- The number WMS gave the document comes back as `outNoticeNo`
  (`createdOutNoticeNo` looks where that family of replies puts it) and is
  **not invented** when the reply carries none.

## The issue notes already in WMS (`POST /api/wms/issue-notes/search`)
The read side of the same screen, captured 2026-10-15:
`POST /ilcwmswms/outnoticehead/getoutnoticeheadlistbyparams` - the save's
own application again, not the `ilcwmsbase` every header list lives in.
**This is what wps's table shows**, which is what makes that table survive
a reload and what makes a document raised on WMS's own screen appear in it:
wps is one of two ways into the same documents, never the record of them.
- Its condition is **long and almost entirely empty** - fifteen search
  fields WMS's own screen sends blank, which is how it asks for everything
  - and all of them are sent, the same rule the save follows.
  `check-wms-login.mjs` asserts the key list against the capture.
- `field: "updateDate"` + `order: "desc"` is **newest first**, the only two
  values here that are a decision rather than a copy. `standardCol01: "0"`
  is the same constant the save sends, so this lists the documents that
  save creates and not another kind.
- **WMS's own screen copies three of its headers into the condition**
  (`Authentication-Info`, `Accept-Language`, `App-Module-Number`) - its
  ajax layer merges them in - and they are sent back the same way. The
  session id there is the one already travelling in the same request's
  cookie and header, so it is not a second disclosure; nothing logs a
  request body.
- **A blank `orgNo` is every organization**, exactly as the capture asks,
  and the route does not demand one: a document somebody is looking for is
  still one they are looking for when it was raised elsewhere. The opposite
  of the create route, which demands the organization because it decides
  what the document *is*.
- `size` is clamped to `WMS_ISSUE_NOTE_MAX_PAGE_SIZE` (200) rather than
  refused - a page size is a screen's own business and a silly one is not
  worth an error, but somebody else's server is not asked for ten thousand
  rows either.
- **The 000701 rule applies**, and here it is at its sharpest: a dead
  session answers 200 with no rows, which reads as "no documents" - and an
  empty table is exactly what somebody would believe. Verified live
  2026-10-15 with an all-zeros id (401 `wms_session_expired`).
- The reply's shape is **not** captured, so `ISSUE_NOTE_FIELDS` lists
  candidate spellings per field and the row is flattened to
  `{ outNoticeNo, billDate, createdAt, createdBy, status, documentClass,
  warehouse, positions, remark }` - never WMS's own row, for the reason
  `/items` does not pass one on. These are **better than guesses** though:
  the save's captured payload names the columns of this very table
  (`outNoticeNo`, `billDate`, `classifyType`, `warehouseNo`, `remark`) and
  `updateDate` is proven to exist by being what the list sorts on. The
  people and the counts have no such backing, so they carry several
  spellings and a blank costs a cell, not the list.
  - **A count WMS did not send stays null, never 0**: `Number(null)` is 0,
    and a document shown as having no positions is a claim about it rather
    than a missing cell. (Caught by the check script, not by review.)
  - A row with no document number is dropped: it cannot be looked up in
    WMS and cannot be told from the next one on screen.
- The field names of the first real reply are logged once per server run,
  names only, as every other list here does.

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
  - The suffix is **3 random digits** (100-999). The minute is already in
    the prefix, so the suffix only has to separate orders placed within the
    same minute; random keeps every number the same width. It was a
    per-minute counter for one day (2026-10-01 to 2026-10-02) and was put
    back to random on request.
  - A drawn number that already exists is **redrawn** (up to 50 times)
    rather than risked: 900 values make a clash unlikely, but against a
    UNIQUE column "unlikely" is a 23505 nobody can read. The advisory lock
    on the prefix keeps two concurrent same-minute inserts from drawing at
    the same moment.
  - **Nothing parses `order_no`** - every client only displays it - so
    changing the shape of the suffix never breaks a client, and old numbers
    in history need no migration.
  - **Sort lists by `created_at`, never by `order_no`**: the suffix is
    random, and across days the date sits in the middle segment, so a string
    sort is not chronological at all.
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
- **"Pozycja wydana" means issued at least once**, not issued up to the
  ordered amount (since 2026-10-02). `order_items.quantity` is always a
  piece count ("10 szt.") while the issued amount is the catalog's own unit
  (kg, km), so the old `issued_quantity >= quantity` compared pieces with
  kilograms: an order for a material sold by weight could never be
  delivered. `order_items_progress.issue_count` (how many issue scans hit
  the line, unit-free) is the signal, used by `deliverOrder` and sent as
  `issueCount` for every client to use instead of re-deriving it.
  - The piece count is therefore **not verified** for an aggregate material:
    two spools and four spools can weigh the same, so nothing but the
    operator knows which went out. smpda shows the ordered piece count while
    issuing; that is the whole safeguard. Only individually tracked
    categories (FRP: one scan per drum) make the count exact.
  - That view is **dropped and recreated**, not CREATE OR REPLACE'd: the
    replace form cannot insert a column anywhere but the end (42P16), and it
    silently left `issue_count` out when it was added in the middle.
- **Taking an order is race-safe.** `takeOrder` updates
  `WHERE id = $1 AND status = 'new'` and tells the loser who got it
  ("Zamówienie przyjął już 4601270.", 409). Without the status guard two
  operators pressing at the same moment both got 200: the second UPDATE
  still matched, and in_progress -> in_progress is not a status change so it
  slipped past the transition guard - the later writer silently took over
  `taken_by` while `order_events` still credited the first. Confirmed
  live before the fix.
- **The requester may edit, cancel or delete their own order - but only
  while nobody has started it** (added 2026-10-02, `check-order-edit.mjs`):
  - `POST /:id/edit/start` takes an edit lock (`editing_by`/`editing_at`),
    which hides the order from the forklift queue (`editing: true` in the
    payload) and makes `takeOrder` refuse it. **The lock expires after
    `EDIT_LOCK_MINUTES` (5)**, because an app killed mid-edit would
    otherwise hide the order for good; smOrder re-sends it every 2 minutes
    while the form is open, and `/:id/edit/stop` releases it at once.
  - `PATCH /:id` saves (places, details, note and the whole item list -
    replaced wholesale) and releases the lock. The type, requester, number
    and `created_at` stay fixed, as `orders_before_update` already
    enforced.
  - `DELETE /:id` removes it outright, for one placed by mistake - unlike
    cancelling, which keeps it in history with a reason.
  - `orders_require_items` is now a constraint trigger on **INSERT OR
    UPDATE**: it was INSERT-only, so an edit could leave a material order
    with no positions at all.
- **Chat on an order** (`order_messages`, added 2026-10-02): what the two
  people on one transport say to each other, reached from the same screen as
  the problem loop. `GET /:id/messages` (oldest first, `?afterId=N` for
  only what is newer), `POST /:id/messages`. Deliberately not
  `order_events`: an event is something that happened to the order, a
  message is somebody talking, and mixing them makes the audit trail
  unreadable. Writing to a closed order is allowed - people explain things
  after the fact.
  - **The clients poll `?afterId=` every second** while the thread is open.
    That is what makes it feel immediate without a socket: the answer is an
    empty array almost every time (~6 ms a call), and a dropped poll on
    warehouse Wi-Fi costs one second rather than a reconnect.
  - `order_message_reads` (order, employee, `last_read_id`) is how far each
    person has read, written by `POST /:id/messages/read` with GREATEST so a
    late call cannot move the mark backwards. An order then carries
    `messageCount` and - for the employee named in `?viewer=` -
    `unreadCount`, which excludes that person's own messages. No viewer, no
    unread count: there is no per-user auth, so the caller has to say who is
    asking.
  - Checked by `node scripts/check-order-chat.mjs`.
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
- **`GET /orders` pages on request**: `?limit=N` returns one page and
  `?beforeCreatedAt=&beforeId=` the next, keyset rather than OFFSET -
  orders close while somebody is scrolling, and an offset silently repeats
  or skips a row at every page boundary. Both cursor parts travel together;
  no limit means the whole list, which is what wps and smpda read.
- "Lista zamówień" = `new` + `in_progress` + `delivered`; "Historia
  zamówień" = `done` + `cancelled` (`STATUS_SETS`). A `delivered` order
  stays in the active list until it is really closed.

## Nothing in here carries a machine's address (`src/lanAddress.js`)
Setting this system up on another computer used to mean finding every
place one machine's IP had been written down - and they went stale on this
one too, every time DHCP handed out a different lease. The rule now is
that **an address is derived, not configured**, and the few things that
genuinely cannot be say so:
- `S3_ENDPOINT` empty (or `auto`) means **this machine's own LAN
  address**, found by `lanAddress()`. It is the one setting that can never
  be localhost: a photo is fetched by the phone straight from storage,
  through a presigned URL that carries this host. The startup line says
  which address was picked, because a machine with several NICs is a guess
  worth showing - private ranges are preferred in the order 192.168, 10,
  then 172.16/12, where Docker and WSL keep bridges no phone can reach.
- The same file runs as a one-liner (`node src/lanAddress.js`), which is
  how `tools/build-apk.*` bake an address into the Flutter apps without a
  second copy of that heuristic.
- The browsers answer it themselves: wps and stock call the API on the host
  their own page came from (see their `browserApi.js`), so neither bundle
  holds an address at all.
- An explicit value always wins, and a real deployment needs one - see
  `deploy/README.md`. The whole new-machine path is `SETUP.md` at the repo
  root.

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
   short-lived JWT (employee number from CIP + a role from a local
   role-mapping table - `employee_roles`, filled in from wps's
   "Uprawnienia"). Today there is only the shared `API_TOKEN` (see Auth)
   and **nothing enforces a role anywhere**. Prerequisite for the next
   step.
   - **`EMPLOYEE_ROLES` is `["forklift"]` alone** (narrowed 2026-10-15,
     on request): one role plus **no role**, where no role is the absence
     of a row and not a value. `supervisor`, `orderer`, `warehouse` and
     `test` were on that list until then; since nothing enforced them,
     narrowing it costs no behaviour, while a screen offering four roles
     nobody hands out reads as a decision about who may do what - which
     is exactly what it was not. Whatever enforces roles later must still
     treat an employee with no row as having **no** role rather than
     every role.
   - The `employee_roles` CHECK in `schema.sql` deliberately still allows
     all five: it is a backstop against garbage, not the catalogue, and
     tightening it would refuse rows that already exist. `EMPLOYEE_ROLES`
     is the one thing that decides what may be handed out, because the
     route and the screen both read it (verified live 2026-10-15:
     `PUT /employee-roles/:no` with `supervisor` is a 400).
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
