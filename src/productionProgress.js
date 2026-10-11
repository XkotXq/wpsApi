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
 *   - `jacket` by **category**, `PE` or `LSZH`: "PE" as a name fragment
 *     matches every "TPEE"/"TPEE Masterbatch" row too - 21 items that are
 *     not PE at all - so only the category is safe. Exactly those two: the
 *     separate "PE Materbatch" category is colourant for PE, not PE itself.
 *
 * Both checked against the live catalog on 2026-10-08.
 */
// The jacket compound is either PE or LSZH depending on the cable, both
// counted in kg, both doing the same job - "PE" alone would miss every
// flame-retardant build (32 LSZH items against 15 PE ones).
const JACKET_CATEGORIES = new Set(["PE", "LSZH"]);

export const MATERIAL_GROUPS = [
  { key: "frp", matches: (material) => isFrpName(material.name) },
  { key: "jacket", matches: (material) => JACKET_CATEGORIES.has(String(material.category ?? "").trim().toUpperCase()) },
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
// Given by the people who run them (2026-10-09).
const LINE_DAILY_KM = 55;

// How much FRP one roll holds. Rolls do vary; this is the usual one, and the
// only figure anything here assumes.
const FRP_ROLL_KM = 48.8;

/**
 * How a line's day is spent: its daily capacity handed out to the positions
 * in its queue, in the order they were pasted, until the day runs out.
 *
 * A line finishes what it is on before starting the next, so a day that has
 * 35 km left on one position and 45 km on the next is 35 km of the first and
 * 20 km of the second - not 55 of either.
 *
 * **Only for a stage counted in cable kilometres** (`inRunKm`): stranding
 * plans the run times the elements it strands, so a daily capacity in km
 * means nothing against its figures.
 */
export function daySharesForLine(rows, dailyKm = LINE_DAILY_KM) {
  const process = rows[0]?.lineProcess;
  if (!process) return [];

  const shares = [];
  let left = dailyKm;
  for (const row of rows) {
    if (left <= 0) break;
    const stage = row.processes?.[process];
    if (!stage || !stage.inRunKm || stage.remaining <= 0) continue;
    const share = Math.min(stage.remaining, left);
    shares.push({ row, km: Math.round(share * 1000) / 1000 });
    left -= share;
  }
  return shares;
}

/**
 * The FRP a day's work takes, per material, and how many rolls that is:
 * `[{ itemNo, name, unit, needed, rolls, lines: [{ line, needed, rolls }] }]`,
 * biggest first.
 *
 * Two things decide the roll count, and both matter:
 *   - **a roll cannot be shared between lines**, because the machines run in
 *     parallel - two lines on the same FRP need their own rolls even if
 *     neither gets through a whole one;
 *   - **a line needing more than one roll holds gets another**
 *     (`Math.ceil`): a day of 55 km at 1.017 km of FRP per km of cable is
 *     55.9 km, which is two rolls of 48.8, not one.
 *
 * So the total is summed per line, never pooled: pooling would say one roll
 * where two lines each need their own.
 */
export function frpRollsForDay(rows, { dailyKm = LINE_DAILY_KM, rollKm = FRP_ROLL_KM } = {}) {
  const byLine = new Map();
  for (const row of rows ?? []) {
    const line = row.line || "—";
    if (!byLine.has(line)) byLine.set(line, []);
    byLine.get(line).push(row);
  }

  const byItem = new Map();
  for (const [line, lineRows] of byLine) {
    // What this line's day takes of each FRP, in that material's own unit.
    const needOnLine = new Map();
    for (const { row, km } of daySharesForLine(lineRows, dailyKm)) {
      for (const item of row.materials?.frp ?? []) {
        if (item.perKm === null || item.perKm === undefined) continue;
        const entry = needOnLine.get(item.itemNo) ?? { item, needed: 0 };
        entry.needed += km * item.perKm;
        needOnLine.set(item.itemNo, entry);
      }
    }

    for (const [itemNo, { item, needed }] of needOnLine) {
      const total =
        byItem.get(itemNo) ?? { itemNo, name: item.name, unit: item.unit, needed: 0, rolls: 0, lines: [] };
      const lineNeeded = Math.round(needed * 1000) / 1000;
      const lineRolls = rollKm > 0 ? Math.ceil(lineNeeded / rollKm) : 0;
      total.needed = Math.round((total.needed + lineNeeded) * 1000) / 1000;
      total.rolls += lineRolls;
      total.lines.push({ line, needed: lineNeeded, rolls: lineRolls });
      byItem.set(itemNo, total);
    }
  }

  return [...byItem.values()].sort((a, b) => b.rolls - a.rolls || b.needed - a.needed);
}

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
 * material** - `{ sc: { frp: [...], jacket: [...] }, sh: {...} }`.
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
    // never has to know the plant's naming itself.
    const lineProcess = processForLine(entry.line);
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
        found: false,
        totalLength: null,
        remainingLength: null,
        producedLength: null,
        percent: null,
      });
      continue;
    }
    for (const match of matches) {
      rows.push({
        ...entry,
        lineProcess,
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
        processes: rowProcesses(match),
        ...rowProgress(match),
      });
    }
  }
  // Only the stages something in this result actually reports on, so the
  // eleven-or-so stages a cable does not go through never become columns.
  return { rows, ordersQueried: orderNumbers.length, processKeys: presentProcessKeys(rows) };
}
