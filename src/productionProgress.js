import { findCipRowsByOrderNumber } from "./cip.js";

// "Postęp produkcji" / "Production progress" (wps: Zamówienia materiałów ->
// Postęp produkcji) - paste the list of what runs on which production line
// and get, per position, how long the run is in total and how much of it is
// still to be made. Read live from CIP on every request; nothing is stored.
//
// The input is the list the planners keep: a production line, then the
// positions that run on it, e.g.
//
//   ST01
//       CF-260010303028101-544182
//       CF-260010303025401-544327
//
// "CF-260010303028101-544182" is CIP's own erpNumber - confirmed against
// real data on 2026-10-08: one CIP row per production line of an order, each
// with its own erpNumber and its own length. The middle segment is the order
// number (CIP's `orderNumber`), which is what its search filters by - the
// erpNumber itself is not a filterable field, so a position is found by
// searching its order and matching the erpNumber in the result.

// ─── Reading the pasted list ────────────────────────────────────────────────

// "CF-260010303028101-544182". The letter prefix is kept rather than assumed
// to be "CF", since nothing says it always is.
const ERP_NUMBER_RE = /[A-Za-z]{1,8}-\d{6,}-\d+/g;

// A bare production **order** number, pasted instead of the job numbers
// above - e.g. "260010303024501". That stands for every line of the order,
// not one of them, so one pasted number can answer with several rows (that
// order has twelve).
//
// Eight digits minimum, because that is the shortest real order number seen
// (both "20260401" and the 15-digit "260010303024501" are real), while a
// position/job suffix is six - so a stray "544182" on a line of its own is
// not quietly taken for an order.
const ORDER_NUMBER_RE = /\b\d{8,}\b/g;

function normaliseLineName(text) {
  // The first token only, so a stray "   ST01  (nowa)" still names ST01, and
  // upper-cased because `locations` holds line names upper-case.
  const first = String(text ?? "").trim().split(/\s+/)[0] ?? "";
  return first.slice(0, 16).toUpperCase() || null;
}

export function parseErpNumber(text) {
  const trimmed = String(text ?? "").trim().toUpperCase();
  const m = trimmed.match(/^([A-Za-z]{1,8})-(\d{6,})-(\d+)$/);
  if (!m) return null;
  return { erpNumber: trimmed, orderNumber: m[2], position: m[3] };
}

/**
 * The pasted block as `[{ line, erpNumber, orderNumber, position }]`, in the
 * order it was pasted. `erpNumber` is null for an entry pasted as a bare
 * order number, which stands for **every line of that order**.
 *
 * **Either form works, mixed in one paste.** A job number
 * ("CF-260010303028101-544182") is one line of one order; an order number
 * ("260010303028101") is all of them. Both are accepted because the lists
 * these people keep come in both shapes, and an order number is the one they
 * always have to hand.
 *
 * A row's content decides what it is, not its indentation: the same list
 * arrives indented when it is copied out of a browser and tab-separated
 * (line and number in two columns) when it comes from Excel, and a textarea
 * loses leading whitespace often enough that indentation alone is not
 * something to hang the parse on. So: any row carrying a number is an entry -
 * and if that row has anything else on it, that something is the line it
 * belongs to (the two-column shape). A row with no number at all names the
 * line that the rows under it belong to.
 */
export function parsePastedProgressList(text) {
  const entries = [];
  let currentLine = null;

  for (const raw of String(text ?? "").split(/\r?\n/)) {
    // Job numbers first: their middle segment would also match the bare
    // order-number pattern, so the two must never be looked for at once.
    const jobs = (raw.match(ERP_NUMBER_RE) ?? []).map(parseErpNumber).filter(Boolean);
    const pattern = jobs.length ? ERP_NUMBER_RE : ORDER_NUMBER_RE;
    const found = jobs.length
      ? jobs
      : (raw.match(ORDER_NUMBER_RE) ?? []).map((number) => ({
          erpNumber: null,
          orderNumber: number,
          position: null,
        }));

    if (!found.length) {
      // Nothing to look up on this row, so it is a line header unless it is
      // blank. A pasted column heading ("Linia") lands here too and becomes
      // a group of its own, which is visible at a glance rather than
      // silently mislabelling the rows under it.
      const name = normaliseLineName(raw);
      if (name) currentLine = name;
      continue;
    }

    const rest = raw.replace(pattern, " ").replace(/[\t;,|]/g, " ").trim();
    if (rest) currentLine = normaliseLineName(rest);
    for (const entry of found) entries.push({ line: currentLine, ...entry });
  }
  return entries;
}

// ─── Reading the progress out of a CIP row ──────────────────────────────────

// Which process stage's numbers are the production progress. SH (the
// sheathing/oblew stage) is the one that runs on the ST lines this screen is
// about, and its lengths are in cable km - the same unit as the row's own
// `totalLength`.
//
// Not interchangeable with the other stages. `scProcess` (stranding) is
// counted in core km - confirmed live: a row whose totalLength is 12 km
// reports 72 there, i.e. length times number of cores - so mixing it in
// would report nonsense. `dpProcess` disagreed with the order's own finished
// state on real data (a finished order still showed 2 km "not finished").
// If another family of lines ever needs a different stage, give this screen
// a stage parameter rather than averaging them.
const PROGRESS_PROCESS_KEY = "shProcess";

// Kilometres, to the metre.
const km = (n) => Math.round(n * 1000) / 1000;

/**
 * How much of one CIP row is made and how much is left, in km.
 *
 * `layersFinishedLength` is NOT what has been produced - that name is a
 * trap, and reading it as "done" reports every order as complete. Verified
 * on real data (2026-10-08, order 260010303024501, all 12 of its lines): it
 * is always exactly equal to the row's own `totalLength`, i.e. it is the
 * length the layer is planned for. The progress is in
 * `layersNotFinishedLength` - what is still to run:
 *
 *   - every finished line (opStatus 5) reported 0 there, and
 *   - one line reported 44 km total with 4 km not finished, i.e. 40 km
 *     already made and still running (opStatus 4).
 *
 * So produced = total - not finished.
 *
 * A stage can have several layers (a cable with two sheath layers). Every
 * row seen so far has exactly one, so max and sum agree today; max is the
 * safe reading of the two, because the layer that is furthest behind is what
 * decides when the position is off the line, while summing would invent work
 * that the cable's own length does not contain.
 */
export function rowProgress(row) {
  const totalLength = Number(row?.totalLength ?? 0) || 0;
  const layers = row?.[PROGRESS_PROCESS_KEY]?.orderProcessLayers ?? [];
  if (!layers.length) {
    // The stage is absent from this row (a cable that does not go through
    // it, or data CIP has not filled). Reported as unknown, never as zero -
    // "nothing left to make" and "we do not know" must not look alike.
    return { totalLength, remainingLength: null, producedLength: null, percent: null };
  }
  const reported = Math.max(...layers.map((l) => Number(l.layersNotFinishedLength ?? 0) || 0));
  const remainingLength = Math.min(Math.max(reported, 0), totalLength);
  const producedLength = totalLength - remainingLength;
  return {
    totalLength,
    remainingLength: km(remainingLength),
    // Rounded to the metre, because subtracting two decimal kilometre
    // figures in binary floating point does not give a decimal one: a real
    // row (997.5 km with 665.7 left) produced 331.79999999999995, which is
    // not a length anybody should be shown.
    producedLength: km(producedLength),
    // One decimal place: these are km, and a whole percent hides the last
    // few hundred metres of a long run.
    percent: totalLength > 0 ? Math.round((producedLength / totalLength) * 1000) / 10 : null,
  };
}

// ─── Every process stage on a row ───────────────────────────────────────────

// The stages CIP reports per order line, as `<key>Process` on the row, in
// CIP's own key order (which is the process route's order). Most are null on
// any given cable - a real order used four of these fifteen (SC, SZ, SH, DP)
// and the other eleven were null on all twelve of its lines.
const PROCESS_KEYS = ["sc", "cl", "rl", "dt", "rb", "sl", "sz", "rs", "sh", "fh", "uu", "ac", "we", "dp", "tb"];

function sumField(layers, field) {
  return layers.reduce((total, layer) => total + (Number(layer?.[field] ?? 0) || 0), 0);
}

/**
 * One stage's completion, or null when the stage carries no figures at all.
 *
 * **Every stage is measured in its own unit**, never in the cable's
 * kilometres, so its completion is only ever expressed against its own
 * planned amount. SC (stranding) is the proof: its planned figure is the
 * run's length times the number of elements being stranded - a 44 km run
 * reported 264, a 12 km one 72 - so comparing any of that to `totalLength`
 * would report 600% complete.
 *
 * The same naming trap as the headline figures applies here, in both
 * shapes: `layersFinishedLength` (and the flat shape's `finishedLength`) is
 * the amount **planned**, not the amount made - on every unstarted row it
 * equals the "not finished" figure exactly. What is left is
 * `layersNotFinishedLength` / `notFinishedLength`.
 */
function stageFigures(stage) {
  let planned;
  let remaining;
  let layerCount = 1;
  let finishedAt = null;

  const layers = stage?.orderProcessLayers;
  if (Array.isArray(layers) && layers.length) {
    // Summed, not maxed as the headline does: a stage's own planned amount
    // is the denominator here, so summing both sides keeps the percentage
    // self-consistent however many layers it has. (Every row seen so far
    // has exactly one.)
    planned = sumField(layers, "layersFinishedLength");
    remaining = sumField(layers, "layersNotFinishedLength");
    layerCount = layers.length;
    // The last layer to finish is when the stage itself was done.
    finishedAt = layers.map((l) => l?.actualFinishedTime).filter(Boolean).sort().at(-1) ?? null;
  } else if (stage?.finishedLength !== undefined || stage?.notFinishedLength !== undefined) {
    // The flat shape - DP reports this way, with no layers at all.
    planned = Number(stage.finishedLength ?? 0) || 0;
    remaining = Number(stage.notFinishedLength ?? 0) || 0;
  } else {
    return null;
  }

  // A stage that is present but reports nothing counts as no data, the same
  // as a null one: a column of dashes is not a completion state.
  if (planned <= 0 && remaining <= 0) return null;

  const clamped = Math.min(Math.max(remaining, 0), planned);
  return {
    planned: km(planned),
    remaining: km(clamped),
    produced: km(planned - clamped),
    percent: planned > 0 ? Math.round(((planned - clamped) / planned) * 1000) / 10 : null,
    layers: layerCount,
    finishedAt,
  };
}

// Which process stage a production line actually runs, by the prefix of its
// name. The plant's lines are named after what they do, so ST01..ST13 all
// strand (SZ), SH01..SH07 and FC01..FC03 sheath (SH), and an SC line is the
// SC stage. Given by the people who run them on 2026-10-09; it is not
// derivable from anything CIP sends, which is why it is written down here
// rather than guessed per screen.
//
// Server-side on purpose: it is a rule about the plant, and the moment two
// clients each have their own copy they disagree.
const LINE_PROCESS_PREFIXES = [
  ["ST", "sz"],
  ["SH", "sh"],
  ["FC", "sh"],
  ["SC", "sc"],
];

/**
 * The stage a line runs, or null for a line whose name says nothing about
 * it (FL01, a free-text place, a pasted heading). Null is reported as
 * "unknown" by callers rather than filled in with a guess - showing the
 * wrong stage's figures would be worse than showing none.
 */
export function processForLine(line) {
  const name = String(line ?? "").trim().toUpperCase();
  if (!name) return null;
  for (const [prefix, process] of LINE_PROCESS_PREFIXES) {
    if (name.startsWith(prefix)) return process;
  }
  return null;
}

/**
 * Which **kinds of material a line's own stage actually consumes**, by that
 * stage (`processForLine`'s own codes).
 *
 * A position carries the whole cable's BOM, not the part one stage puts in -
 * CIP has no other shape for it - so without this every line of a cable looks
 * like it needs everything the cable is made of. It does not, and the
 * difference is physical:
 *   - **FRP goes in when the cable is laid up** (the ST lines, stage `sz`):
 *     it is the strength member, it is paid off a roll at that machine and
 *     nowhere else;
 *   - **the tube granulate is extruded at secondary coating** (the SC lines,
 *     stage `sc`): the tubes are made there, around the FRP that is already
 *     in the machine, so what an SC line is sent is a bigbag of PBT;
 *   - **the compound goes on when the cable is sheathed** (SH and FC lines,
 *     stage `sh`): the FRP and the tubes are long since inside the cable by
 *     then, so a bigbag of jacket compound is what that line is sent, and
 *     neither a roll of FRP nor the granulate for a tube.
 *
 * Reported on 2026-10-12, after the export listed FRP for an SH line, and
 * corrected on 2026-10-13, after it listed FRP for SC01 as well. It is also
 * what the day's packages are counted off: counting a cable's FRP again on
 * its sheathing line ordered it twice, once per line the order was pasted on.
 *
 * **Not derivable from the BOM's own process codes** - CIP files FRP's rows
 * under "SC" while the ST line that runs them is stage "SZ", which is exactly
 * how the FRP once disappeared from the lines that need it, and then, read
 * the other way round, how it turned up on the SC lines that only extrude
 * tubes. What the SC stage is, is readable in its own figures instead: it
 * plans the run times the number of tubes - 672 against a 168 km four-tube
 * run, 72 against a 12 km six-tube one - which is a stage that makes tubes,
 * not one that lays up a cable. It is a rule about the plant, like the line
 * names above, so it lives here and not in a screen.
 *
 * A line whose stage is unknown gets **every** kind: there is nothing to
 * narrow it by, and showing too much beats hiding what somebody has to fetch.
 */
const STAGE_MATERIAL_GROUPS = {
  sz: ["frp"],
  sc: ["tube"],
  sh: ["jacket"],
};

export function materialKeysForLineProcess(lineProcess) {
  if (!lineProcess) return [...MATERIAL_GROUP_KEYS];
  return STAGE_MATERIAL_GROUPS[lineProcess] ?? [...MATERIAL_GROUP_KEYS];
}

/** Every stage with figures on this row, keyed by its short code. */
export function rowProcesses(row) {
  const totalLength = km(Number(row?.totalLength ?? 0) || 0);
  const processes = {};
  for (const key of PROCESS_KEYS) {
    const figures = stageFigures(row?.[`${key}Process`]);
    if (!figures) continue;
    processes[key] = {
      ...figures,
      // Whether this stage's figures are the cable's **own kilometres**, so
      // a caller knows when it may put "km" next to them. True when the
      // stage plans exactly the run's length (SH, SZ and DP do); false for
      // SC, which plans the run times the number of elements it strands - a
      // 44 km run reports 264 there, and calling that "km" would be wrong.
      inRunKm: totalLength > 0 && figures.planned === totalLength,
    };
  }
  return processes;
}

/**
 * Which stage columns a result should show: the ones at least one position
 * has figures for, in CIP's own order. A stage that is null (or empty) on
 * every position is left out entirely rather than rendered as a column of
 * dashes.
 */
export function presentProcessKeys(rows) {
  const seen = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row.processes ?? {})) seen.add(key);
  }
  return PROCESS_KEYS.filter((key) => seen.has(key));
}

// ─── What counts as FRP ─────────────────────────────────────────────────────

/**
 * Whether a material's name says it is FRP - the test behind "which FRP does
 * this position need" (routes/cipOrders.js's attachFrpRequirements).
 *
 * The name, not the catalog category, even though there is a category called
 * "FRP": every item in it does have FRP in its name, but seven more real FRP
 * items are filed elsewhere - four "PL-MAT" rows ("FRP with steel wire
 * reinforced Φ0.45mm×1.5mm"...) and three "GLYCL" ones ("FRP 3.4mm/VIP",
 * "FRP/Ф0.8mm", "GFRP/0.7*0.75mm"), all sold by the kilometre like the rest.
 * Going by category would quietly miss seven of the sixty-three. Checked
 * against the live catalog on 2026-10-08.
 *
 * The caller matches this against **our catalog's** name for the item and
 * only for items this warehouse stocks, never against CIP's own free-text
 * description - otherwise the match would depend on how CIP happens to word
 * a row.
 */
export function isFrpName(name) {
  return /frp/i.test(String(name ?? ""));
}

/**
 * The kinds of material this screen calls out of a position's bill of
 * materials, in the order their columns appear.
 *
 * **Each group matches on whichever signal its own data supports** - they
 * are deliberately not the same rule, and swapping either one breaks it:
 *   - `frp` by **name** (`isFrpName` above): the catalog's own "FRP"
 *     category would miss seven real FRP items filed under "PL-MAT" and
 *     "GLYCL".
 *   - `jacket` (`PE`, `LSZH`) and `tube` (`PBTP`) by **category**: "PE"
 *     as a name fragment matches every "TPEE"/"TPEE Masterbatch" row too -
 *     21 items that are not PE at all - so only the category is safe.
 *     Exactly those categories, and never a `… Masterbatch` one: those are
 *     colourant for the compound, not the compound.
 *
 * Checked against the live catalog on 2026-10-08, and again for PBTP on
 * 2026-10-12.
 */
// Both of these arrive in a bigbag and are counted in kg, and they are two
// groups rather than one because **two different machines eat them**:
//   - the jacket compound (`PE`, `LSZH`, depending on whether the cable is
//     flame-retardant) goes on at sheathing. "PE" alone would miss every
//     LSZH build - 32 items against 15 PE ones - so both are named.
//   - the tube granulate (`PBTP`, 4 items: "BASF PBT(6550LN)", "PBTP for
//     micro cable tube", ...) is extruded into the loose tubes at secondary
//     coating, long before the cable reaches a sheathing line. It rode in
//     the jacket group for a day (added 2026-10-12, asked for as "PBTB"),
//     which put it on the SH lines' list and nowhere near the SC line that
//     actually extrudes it - reported 2026-10-13.
//
// **PBTB is the same thing under the name the floor uses**; the catalog only
// has PBTP, so both are matched and nothing hangs on which one turns up. The
// `… Masterbatch` categories are deliberately out of both (36 `PBTP
// Masterbatch…` items, and `PE Materbatch`): colourant, not compound.
const JACKET_CATEGORIES = new Set(["PE", "LSZH"]);
const TUBE_CATEGORIES = new Set(["PBTP", "PBTB"]);

const byCategory = (categories) => (material) =>
  categories.has(String(material.category ?? "").trim().toUpperCase());

// In the order the cable is built in, which is the order the columns read in:
// the strength member, the tubes laid around it, the jacket over them.
export const MATERIAL_GROUPS = [
  { key: "frp", matches: (material) => isFrpName(material.name) },
  { key: "tube", matches: byCategory(TUBE_CATEGORIES) },
  { key: "jacket", matches: byCategory(JACKET_CATEGORIES) },
];

export const MATERIAL_GROUP_KEYS = MATERIAL_GROUPS.map((group) => group.key);

/**
 * A position's catalogued BOM materials sorted into the groups above:
 * `{ frp: [...], pe: [...] }`, each group an array (empty when the position
 * needs nothing of that kind).
 *
 * A material can legitimately land in more than one group - nothing here
 * assumes the groups are exclusive.
 */
export function groupBomMaterials(materials) {
  const grouped = Object.fromEntries(MATERIAL_GROUP_KEYS.map((key) => [key, []]));
  for (const material of materials ?? []) {
    for (const group of MATERIAL_GROUPS) {
      if (group.matches(material)) grouped[group.key].push(material);
    }
  }
  return grouped;
}

// ─── How much FRP a day's run takes, and how many rolls that is ─────────────

// What one production line gets through in a day, in kilometres of cable.
// Given by the people who run them: 55 on 2026-10-09, raised to 60 on
// 2026-10-12, back to 55 on 2026-10-14 - that is the average a line
// actually gets through, and an average is what a day's ordering has to
// rest on. It has moved three times, so it stays a constant here and is
// sent to the clients as `dailyKm` rather than written down in any of
// them.
//
// This is the whole reason the packages are counted off `daySharesForLine`
// and not off what is left of a run: a 150 km order is not ordered in one
// go, it is ordered for the day in front of it - 55 km of it - and again
// tomorrow.
export const LINE_DAILY_KM = 55;

// How much FRP one roll holds. Rolls do vary; this is the usual one, and the
// only figure anything here assumes.
const FRP_ROLL_KM = 48.8;

// How much of a bagged material - jacket compound or tube granulate - one
// bigbag holds. The standard size the
// warehouse's own stock is split into - the same 500 kg wps's
// lib/smMaterialsSeed.js splits a real CIP inventory export by. Like the
// roll above: bags do vary, this is the usual one.
const BIGBAG_KG = 500;

// A line's **first** position, when this little is left of it, gets no FRP
// ordered: the roll already on the payoff sees a tail that short out, and a
// roll fetched for it would be carried back nearly full. Given by the people
// who run the lines (2026-10-12). It is the first position only - what is on
// the machine now - and FRP only: the day's cable still counts towards
// everything else, including the compound.
const FRP_SKIP_FIRST_KM = 15;

/**
 * How each material group is packaged: what one package holds in that
 * group's own unit, **whether a package can serve more than one production
 * line**, and whether a short first position is skipped. Keyed by
 * MATERIAL_GROUPS' own keys, so a group with nothing to count simply has no
 * entry and `packagesForDay` returns nothing for it.
 *
 * `pooled` is the difference between the two, and it is physical:
 *   - an **FRP roll sits on one machine's payoff**, so two lines running
 *     the same FRP each need their own even if neither gets through a whole
 *     roll - counted per line (`pooled: false`);
 *   - a **bigbag feeds whatever asks for it**, so one bag can cover two
 *     orders, on one line or on two - counted once over the whole day
 *     (`pooled: true`). Told to us on 2026-10-12, after the first version
 *     counted bags per line and over-ordered them.
 *
 * `size` is only the default. Bags and rolls really do differ per
 * material, so a caller may override it per item - see `packagesForDay`'s
 * own `sizes`.
 */
export const PACKAGE_RULES = {
  frp: { size: FRP_ROLL_KM, pooled: false, skipFirstBelowKm: FRP_SKIP_FIRST_KM },
  tube: { size: BIGBAG_KG, pooled: true },
  jacket: { size: BIGBAG_KG, pooled: true },
};

export const PACKAGED_GROUP_KEYS = Object.keys(PACKAGE_RULES);

/**
 * The package size to count an item by: what the caller set for that exact
 * item number, or its group's default. A non-number, zero or a negative is
 * ignored rather than trusted - it would turn the count into Infinity or a
 * negative number of bags.
 */
export function packageSizeFor(group, itemNo, sizes) {
  const override = Number(sizes?.[itemNo]);
  if (Number.isFinite(override) && override > 0) return override;
  return PACKAGE_RULES[group]?.size ?? 0;
}

/**
 * How a line's day is spent: its daily capacity handed out to the positions
 * in its queue, in the order they were pasted, until the day runs out.
 *
 * A line finishes what it is on before starting the next, so a day that has
 * 35 km left on one position and 45 km on the next is 35 km of the first and
 * 20 km of the second - not 55 of either.
 *
 * **Always in kilometres of cable**, whatever unit the line's own stage
 * counts in - a daily capacity is a figure about cable, so what it is handed
 * out against has to be one too (see `remainingInCableKm`).
 */
/**
 * What one stage of one row still has to make, **in kilometres of cable**.
 *
 * A stage counted in the cable's own kilometres (`inRunKm`) needs nothing
 * doing to it. The others plan the run times the number of things they make
 * of it - secondary coating plans 672 against a 168 km four-tube run - and
 * that multiplier is exactly `planned / totalLength`, so dividing by it
 * gives back the cable the stage has left. Read off the row's own two
 * figures, never off the cable type, which nothing here parses.
 *
 * Until this existed an SC line dropped out of the day's counting entirely,
 * and the granulate it extrudes was never ordered for it.
 */
export function remainingInCableKm(row, stage) {
  if (!stage || !(stage.remaining > 0)) return 0;
  if (stage.inRunKm) return stage.remaining;
  const total = Number(row?.totalLength ?? 0);
  const perCableKm = total > 0 ? stage.planned / total : 0;
  if (!Number.isFinite(perCableKm) || perCableKm <= 0) return 0;
  return Math.round((stage.remaining / perCableKm) * 1000) / 1000;
}

export function daySharesForLine(rows, dailyKm = LINE_DAILY_KM) {
  const process = rows[0]?.lineProcess;
  if (!process) return [];

  const shares = [];
  let left = dailyKm;
  for (const row of rows) {
    if (left <= 0) break;
    const remaining = remainingInCableKm(row, row.processes?.[process]);
    if (remaining <= 0) continue;
    const share = Math.min(remaining, left);
    shares.push({ row, km: Math.round(share * 1000) / 1000 });
    left -= share;
  }
  return shares;
}

/**
 * What a day's work takes of one material group, per material, and how many
 * packages that is:
 * `[{ itemNo, name, unit, needed, packages, perKm, cableKm, lineCount,
 *    lines: [{ line, needed, packages, perKm }] }]`,
 * biggest first. FRP comes out in rolls, compound and granulate in bigbags - the
 * arithmetic is the same, only the package size differs
 * (`PACKAGE_RULES`), so both are counted here rather than in two
 * near-identical functions that could drift apart.
 *
 * Two things decide the count, and both matter:
 *   - **a package cannot be shared between lines**, because the machines run
 *     in parallel - two lines on the same FRP need their own rolls even if
 *     neither gets through a whole one, and a bigbag hangs over one
 *     extruder's hopper the same way;
 *   - **a line needing more than one package holds gets another**
 *     (`Math.ceil`): a day of 55 km at 1.017 km of FRP per km of cable is
 *     55.935 km, which is two rolls of 48.8, not one.
 *
 * So the total is summed per line, never pooled: pooling would say one
 * package where two lines each need their own.
 */
export function packagesForDay(rows, { group = "frp", dailyKm = LINE_DAILY_KM, sizes } = {}) {
  const rule = PACKAGE_RULES[group];
  if (!rule) return [];

  const byLine = new Map();
  for (const row of rows ?? []) {
    const line = row.line || "—";
    if (!byLine.has(line)) byLine.set(line, []);
    byLine.get(line).push(row);
  }

  const byItem = new Map();
  for (const [line, lineRows] of byLine) {
    // Only what this line's own stage puts into the cable. A position carries
    // the whole cable's BOM, so without this an order pasted on both its
    // stranding line and its sheathing line had its FRP counted twice and its
    // compound counted twice (see STAGE_MATERIAL_GROUPS).
    if (!materialKeysForLineProcess(lineRows[0]?.lineProcess).includes(group)) continue;

    // What this line's day takes of each material, in that material's own
    // unit (km of FRP, kg of compound).
    const needOnLine = new Map();
    for (const [index, { row, km }] of daySharesForLine(lineRows, dailyKm).entries()) {
      // The tail on the machine right now, when it is short enough that the
      // roll already fitted will see it out (FRP only - see
      // `skipFirstBelowKm`). The day's cable is unchanged; it is this
      // material that is not fetched for it.
      if (index === 0 && rule.skipFirstBelowKm && km < rule.skipFirstBelowKm) continue;
      for (const item of row.materials?.[group] ?? []) {
        if (item.perKm === null || item.perKm === undefined) continue;
        const entry = needOnLine.get(item.itemNo) ?? { item, needed: 0, cableKm: 0 };
        entry.needed += km * item.perKm;
        // The cable this material is being counted against, kept alongside
        // the amount so the per-kilometre figure below is the one that
        // actually produced it.
        entry.cableKm += km;
        needOnLine.set(item.itemNo, entry);
      }
    }

    for (const [itemNo, { item, needed, cableKm }] of needOnLine) {
      const total =
        byItem.get(itemNo) ??
        {
          itemNo,
          name: item.name,
          unit: item.unit,
          // The size this item was counted by, so the screen can show and
          // offer to change it rather than keeping its own copy.
          packageSize: packageSizeFor(group, itemNo, sizes),
          pooled: rule.pooled,
          needed: 0,
          packages: 0,
          // Kilometres of cable the day's amount is for. Only here so
          // `perKm` below can be the amount's own rate; nothing reads it as
          // a figure in its own right.
          cableKm: 0,
          perKm: null,
          // On how many lines the day needs this material at all. Its own
          // field rather than `lines.length` for the caller to count,
          // because what counts as "needed on a line" is this rule and not
          // the screen's: a line whose share rounds to nothing does not
          // need the material, and it is left out of both.
          lineCount: 0,
          lines: [],
        };
      const lineNeeded = Math.round(needed * 1000) / 1000;
      // Per line only where a package cannot be shared. Pooled groups get
      // one count over the whole total below - counting them per line is
      // what made two half-used bags out of one.
      const linePackages =
        rule.pooled || total.packageSize <= 0 ? null : Math.ceil(lineNeeded / total.packageSize);
      total.needed = Math.round((total.needed + lineNeeded) * 1000) / 1000;
      total.cableKm = Math.round((total.cableKm + cableKm) * 1000) / 1000;
      if (linePackages !== null) total.packages += linePackages;
      // A line that takes none of it is not a line it has to reach. Only
      // reachable by rounding (a share of 0.0004 kg), and listing such a
      // line would overstate both the breakdown and the count below.
      if (lineNeeded > 0) {
        total.lines.push({ line, needed: lineNeeded, packages: linePackages, perKm: perKmConsumption(lineNeeded, cableKm) });
      }
      byItem.set(itemNo, total);
    }
  }

  for (const total of byItem.values()) {
    // How much of this material one kilometre of cable takes - the figure
    // you multiply by to plan, as against the day's amount, which is only
    // this shift's. **Weighted by the cable it came from**, not averaged
    // over the positions: the same compound runs at a different rate under
    // every cable (its BOM row is per cable), so an unweighted mean of two
    // rates would not reproduce `needed`, and this does.
    total.perKm = perKmConsumption(total.needed, total.cableKm);
    // One line per entry (the loop above is keyed by line), so this is the
    // number of production lines the day needs this material on. It is the
    // same for a pooled group as for a roll - how many places it has to
    // reach is a question about the floor, not about packaging.
    total.lineCount = total.lines.length;
    if (!rule.pooled) continue;
    // One count for the day: a bag covers whatever asks for it, so what
    // matters is the total kilograms, not which order asked for them.
    total.packages = total.packageSize > 0 ? Math.ceil(total.needed / total.packageSize) : 0;
  }

  return [...byItem.values()].sort((a, b) => b.packages - a.packages || b.needed - a.needed);
}

/**
 * The same, for every group that comes in packages:
 * `{ frp: [...], tube: [...], jacket: [...] }`. A group nothing in the paste needs comes
 * back as an empty array, which the caller leaves out of the screen - the
 * same rule `presentMaterialKeys` follows for the columns.
 */
export function packagesForDayByGroup(rows, options = {}) {
  return Object.fromEntries(
    PACKAGED_GROUP_KEYS.map((group) => [group, packagesForDay(rows, { ...options, group })])
  );
}

/**
 * A caller's own package sizes, cleaned up: `{ "<itemNo>": <number> }` with
 * anything unusable dropped rather than refused, since one bad cell in a
 * settings panel must not cost the whole answer. Zero, a negative, a
 * non-number and an absurd size all fall back to the group default.
 *
 * Validated here rather than in the route because it is the same rule
 * wherever the sizes come from.
 */
export function sanitisePackageSizes(raw) {
  const clean = {};
  for (const [itemNo, value] of Object.entries(raw ?? {})) {
    const key = String(itemNo).trim();
    const size = Number(value);
    if (!key || !Number.isFinite(size) || size <= 0 || size > MAX_PACKAGE_SIZE) continue;
    clean[key] = size;
  }
  return clean;
}

// Nothing is packed in more than this (km of FRP, kg of compound) - a guard
// against a typo, not a real limit anybody is near: the biggest bag in use
// is 1250 kg and the longest roll under 50 km.
const MAX_PACKAGE_SIZE = 100000;

/**
 * How much of a material one kilometre of cable takes.
 *
 * **Derived from the run, not read from CIP's own `qty`.** That field is a
 * per-unit figure whose unit is not always the cable's kilometre: FRP's
 * 1.017 does divide the run (997.5 km x 1.017 = the 1014.4575 required, and
 * the same 1.017 holds on 168 km and 36 km runs), but a real tube-filling
 * gel row read `qty` 2.810177 against 1112.830092 required on a 198 km run -
 * 396 units, i.e. twice the run, so its base is something else. Dividing the
 * required amount by the run's own length is right for every material,
 * whatever CIP counted in. Checked against all four of those rows.
 */
export function perKmConsumption(requiredQuantity, totalLength) {
  const required = Number(requiredQuantity ?? 0);
  const run = Number(totalLength ?? 0);
  if (!Number.isFinite(required) || !Number.isFinite(run) || run <= 0 || !requiredQuantity) return null;
  return Math.round((required / run) * 10000) / 10000;
}

/**
 * The same grouping, split by the **process stage that consumes the
 * material** - `{ sc: { tube: [...], ... }, sh: { jacket: [...], ... } }`.
 *
 * CIP's BOM says which stage each material belongs to in its own `process`
 * field ("SC", "SH", ...) - confirmed against a real BOM on 2026-10-09,
 * alongside `layer` and `operationCode` ("SC58"). Those values are exactly
 * the stage codes PROCESS_KEYS already uses, so the two line up with no
 * mapping table to keep in step.
 *
 * A material whose `process` is blank, or names a stage this row does not
 * run, is left out rather than parked somewhere arbitrary: the point of
 * this is that a material appears under the stage that actually uses it.
 */
export function groupBomMaterialsByProcess(materials) {
  const byProcess = {};
  for (const material of materials ?? []) {
    const key = String(material.process ?? "").trim().toLowerCase();
    if (!PROCESS_KEYS.includes(key)) continue;
    if (!byProcess[key]) byProcess[key] = Object.fromEntries(MATERIAL_GROUP_KEYS.map((k) => [k, []]));
    for (const group of MATERIAL_GROUPS) {
      if (group.matches(material)) byProcess[key][group.key].push(material);
    }
  }
  return byProcess;
}

/**
 * The same materials, with every amount re-scaled to **what the line this
 * row sits on still has to run** rather than to the material's own stage.
 *
 * Both figures are honest and they are different: a position can be stranded
 * and still have its whole jacket to go. A **stage cell** is asked "what has
 * this stage left", so there each material keeps its own stage's share. The
 * **position's own list** is read as "what does this line fetch for this
 * order", so it is this one - asked for on 2026-10-13, after an ST line was
 * shown FRP for cable it had already laid up, the order's sheathing being
 * what was really left.
 *
 * The share is a ratio inside one stage, so it needs no unit conversion: 240
 * of 800 tube-kilometres is the same 0.3 as 60 of 200 cable ones. A line
 * whose stage is unknown, or a stage with nothing planned, leaves the
 * materials exactly as they came - there is nothing truer to put there.
 */
export function materialsForLineStage(materials, row) {
  const stage = row?.lineProcess ? row.processes?.[row.lineProcess] : null;
  if (!stage || !(stage.planned > 0)) return materials ?? [];
  const scale = stage.remaining / stage.planned;
  return (materials ?? []).map((material) => ({
    ...material,
    remainingQuantity:
      material.requiredQuantity === null || material.requiredQuantity === undefined
        ? null
        : Math.round(material.requiredQuantity * scale * 1000) / 1000,
  }));
}

/**
 * Which material columns a result should show: the groups at least one
 * position needs something from, in the order above. A group nothing in the
 * paste needs is left out entirely rather than rendered as a column of
 * "brak" - the same rule the process columns follow.
 */
export function presentMaterialKeys(rows) {
  return MATERIAL_GROUP_KEYS.filter((key) => rows.some((row) => (row.materials?.[key] ?? []).length > 0));
}

// ─── The lookup ─────────────────────────────────────────────────────────────

// One CIP search per order, not per pasted position: the planners' list
// repeats an order once per line it runs on (a real list had 26 positions
// across 16 orders, and one order accounted for 6 of them), and four at a
// time keeps a 50-order paste quick without opening fifty sockets against
// CIP at once.
const ORDER_FETCH_CONCURRENCY = 4;

async function fetchInBatches(orderNumbers, cipToken) {
  const byNumber = new Map();
  const queue = [...orderNumbers];
  const workers = Array.from({ length: Math.min(ORDER_FETCH_CONCURRENCY, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      byNumber.set(next, await findCipRowsByOrderNumber(next, cipToken));
    }
  });
  await Promise.all(workers);
  return byNumber;
}

/**
 * The pasted list, each position answered with its progress - in the order
 * it was pasted, so the result reads like the list it came from.
 *
 * A position CIP does not know comes back with `found: false` rather than
 * being dropped: a number that resolves to nothing is exactly what the
 * person pasting it needs to see.
 *
 * One erpNumber can match more than one CIP row (seen live:
 * CF-260010303024501-544065 is both line (2) and line (12) of its order,
 * with different lengths). Each match is its own result row - picking one
 * would silently hide half the work.
 */
export async function getProductionProgress(entries, cipToken) {
  const orderNumbers = [...new Set(entries.map((e) => e.orderNumber))];
  const byNumber = await fetchInBatches(orderNumbers, cipToken);

  const rows = [];
  for (const entry of entries) {
    // The stage this entry's line runs, carried on every row so a client
    // never has to know the plant's naming itself - and with it, which kinds
    // of material that stage actually consumes, so a screen can show the
    // line what it fetches rather than everything the cable is made of.
    const lineProcess = processForLine(entry.line);
    const lineMaterialKeys = materialKeysForLineProcess(lineProcess);
    const candidates = byNumber.get(entry.orderNumber) ?? [];
    // A job number names one line of the order; a bare order number stands
    // for all of them, so there is nothing to narrow it down by.
    const matches = entry.erpNumber
      ? candidates.filter((r) => String(r.erpNumber ?? "").trim().toUpperCase() === entry.erpNumber)
      : candidates;

    if (!matches.length) {
      rows.push({
        ...entry,
        lineProcess,
        lineMaterialKeys,
        found: false,
        totalLength: null,
        remainingLength: null,
        lineRemainingLength: null,
        producedLength: null,
        percent: null,
      });
      continue;
    }
    for (const match of matches) {
      const processes = rowProcesses(match);
      const progress = rowProgress(match);
      // What is left **for this line**, in kilometres of cable: its own
      // stage's remainder, not the order's. The two are different numbers
      // and both are true - a position can be stranded and still have its
      // whole jacket to go - so the one a line is planned by is the one its
      // own machine still has to run (asked for on 2026-10-13). Converted
      // out of the stage's own unit where it has one (see
      // remainingInCableKm). A line whose stage is unknown falls back to the
      // order's remainder: there is no stage to read instead.
      const lineStage = lineProcess ? processes[lineProcess] : null;
      const lineRemainingLength = lineStage
        ? remainingInCableKm({ totalLength: progress.totalLength }, lineStage)
        : progress.remainingLength;
      rows.push({
        ...entry,
        lineProcess,
        lineMaterialKeys,
        found: true,
        // CIP's own job number for this line. For an entry pasted as an
        // order number the paste had none, and this is where it comes from -
        // so a row always says which line of the order it is.
        erpNumber: match.erpNumber ?? entry.erpNumber,
        // Whether the paste asked for this one line or for the whole order.
        wholeOrder: !entry.erpNumber,
        orderId: match.orderId ?? null,
        // CIP's own internal key for the line. Carried through because the
        // bill of materials is fetched by it (see cip.js's
        // cipOrderBomForRow) - that is how the FRP a position needs is
        // looked up without searching for the line a second time.
        orderSn: match.orderSn ?? null,
        cableType: match.cableType ?? null,
        itemNumber: match.itemNumber ?? null,
        // CIP's own status for the line: 5 = finished, 4 = still running
        // (confirmed live against the search's own workStatus filter).
        opStatus: match.opStatus ?? null,
        requestDate: match.requestDate ?? null,
        // Every stage this line goes through, each with what is left of it
        // and what it is out of - in that stage's own unit (see
        // stageFigures).
        processes,
        ...progress,
        lineRemainingLength,
      });
    }
  }
  // Only the stages something in this result actually reports on, so the
  // eleven-or-so stages a cable does not go through never become columns.
  return { rows, ordersQueried: orderNumbers.length, processKeys: presentProcessKeys(rows) };
}
