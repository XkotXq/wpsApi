import { Router } from "express";
import Fuse from "fuse.js";
import { cipOrderBomForRow, getCipOrderMaterials } from "../cip.js";
import {
  frpRollsForDay,
  getProductionProgress,
  groupBomMaterials,
  groupBomMaterialsByProcess,
  parsePastedProgressList,
  perKmConsumption,
  presentMaterialKeys,
} from "../productionProgress.js";
import { knownSmItemNos, smItemCategories, smItemNames, drumCatalogEntries } from "../smCatalog.js";
import { ApiError } from "../errors.js";
import { asyncHandler } from "../asyncHandler.js";

const router = Router();

// CIP's own text for a material (BOM's descriptionUs/Zhs, or a mapping's
// materialDesc) - only ever the fallback once catalogNames has been tried.
function cipDesc(m) {
  return m.descriptionUs || m.descriptionZhs || m.itemCode;
}

// Names every material (and, for a changed one, both sides of the change)
// catalog-first, CIP text second - same rule wpsApi already applies to what
// it writes (`catalogItemName`, see AGENTS.md's "The catalog names a
// material"), extended here to what it shows from CIP's own order/BOM data
// too. `materialChange.fromName`/`toName` are only added for a row that has
// a `materialChange`, so the client never has to duplicate this fallback
// logic itself.
//
// A substituted material is also **normalized to the item it was changed
// to**: both `itemCode` and `name` are the material actually to be used
// now, i.e. what CIP's BOM would say if it were re-planned today. The BOM
// itself still carries the original, pre-swap `itemCode` (see cip.js's
// attachMaterialChanges) - leaving that through was a real bug: `name`
// already followed the swap here while `itemCode` did not, so a row read
// as the new material's name next to the old material's number, and
// anything taking the number straight off the row ordered the wrong item
// (OrdersCipListTable.js's own "Zamówienie materiału" picker did exactly
// that). The original is not lost - it stays as
// `materialChange.from`/`fromName`, which is what the "Zamówienia" search
// tab shows in its expanded change rows.
// Exported for scripts/check-cip-material-change.mjs - the normalization
// below has had two real bugs (CIP's raw Chinese text leaking past the
// catalog, and the stale pre-swap itemCode), and it is pure apart from the
// catalog lookup, so it is worth being able to exercise directly.
export async function withCatalogNames(lines) {
  // Both sides of a change are looked up, not just the row's own itemCode -
  // `from` is normally that same code, but not when the BOM already carried
  // the changed-to side, and `fromName` must still resolve then.
  const codes = lines.flatMap((line) =>
    (line.materials ?? [])
      .flatMap((m) => [m.itemCode, m.materialChange?.from, m.materialChange?.to])
      .filter(Boolean)
  );
  const catalogNames = await smItemNames(codes);
  return lines.map((line) => ({
    ...line,
    materials: (line.materials ?? []).map((m) => {
      // `?? m.itemCode` also covers a row whose own itemCode is already the
      // changed-to side (attachMaterialChanges matches either side, since
      // which one CIP's BOM reflects after a swap isn't confirmed) - then
      // this is a no-op rather than a second swap.
      const currentCode = m.materialChange?.to ?? m.itemCode;
      const material = {
        ...m,
        itemCode: currentCode,
        name: catalogNames.get(currentCode) ?? (m.materialChange?.desc || cipDesc(m)),
      };
      if (m.materialChange) {
        material.materialChange = {
          ...m.materialChange,
          fromName: catalogNames.get(m.materialChange.from) ?? cipDesc(m),
          toName: catalogNames.get(m.materialChange.to) ?? m.materialChange.desc,
        };
      }
      return material;
    }),
  }));
}

// A catalog code's own leading "W" ("W600A", "W700A", ...) isn't always
// there in CIP's text - confirmed live: one real order's `spoolSizeText`
// was "700A 700*450*530", no "W", for the same drum "Wooden drum W700A"
// carries elsewhere with one. Tried as an extra candidate alongside the
// literal code, never in place of it, so a CIP text that *does* keep the
// "W" still matches the same way as before.
// Exported for scripts/check-drum-match.mjs, which runs this against the
// real catalog - the matching is pure string work and worth a test that
// does not need CIP.
export function withoutLeadingW(code) {
  return /^W\d/i.test(code) ? code.slice(1) : null;
}

// A segment can carry its own length label before the actual drum spec -
// e.g. "4km: 1250B 1250*650*740" (see cip.js's extractSpoolSizeSegments,
// for a cable run split across several reels) - split off here so
// matchDrumCatalog only ever sees the code+dimensions part it actually
// knows how to match, same shape as a plain single-drum segment. A segment
// with no ":" at all (the common, single-drum case, e.g. "W600A
// 600X400X340") has no label. The label itself is never validated against
// any particular format (a length, a count, ...) - just carried along as
// text, appended to the matched material's own name below.
// Exported for scripts/check-drum-match.mjs, which runs this against the
// real catalog - the matching is pure string work and worth a test that
// does not need CIP.
export function splitLengthLabel(segment) {
  const colon = segment.indexOf(":");
  if (colon === -1) return { label: null, rest: segment };
  return { label: segment.slice(0, colon).trim(), rest: segment.slice(colon + 1).trim() };
}

// A word that looks like dimensions ("1250*650*740", "600X400X340" - digits
// on both sides of an "x"/"*") rather than part of a drum code - used by
// fuzzyDrumCodeGuess below to find where a segment's code ends and its
// dimensions begin, without needing to already know the exact code (that's
// the whole point of the fuzzy fallback - matchDrumCatalog's own exact
// method already handles it when the code IS known/expected).
function looksLikeDimensions(word) {
  return /\d+[x*]\d+/i.test(word);
}

// The likely code portion of a drum/spool segment - everything up to (not
// including) its first dimension-looking word, e.g. "1120B II" out of
// "1120B II 1120*650*740". Used only as the fuzzy fallback's search query
// (see fuzzyMatchDrumCatalog); matchDrumCatalog's own exact matching
// doesn't need this since it already knows every real candidate code from
// the catalog itself.
function fuzzyDrumCodeGuess(segment) {
  const words = segment.trim().split(/\s+/);
  const dimIndex = words.findIndex(looksLikeDimensions);
  return (dimIndex === -1 ? words : words.slice(0, dimIndex)).join(" ");
}

// Fallback for a segment matchDrumCatalog's own exact/boundary matching
// couldn't place at all - a typo, an unexpected spelling, or any format
// drift not already accounted for there. Fuzzy-searches the catalog's
// "Drum" item names (fuse.js: no reason to hand-roll approximate string
// matching when a well-tested library already does it) for the segment's
// guessed code (see fuzzyDrumCodeGuess) and, on a good-enough match, uses
// that catalog item the same way matchDrumCatalog would - `ignoreLocation`
// because the code sits after "Wooden drum "/etc in the catalog's own name,
// not at its start. Returns null (same as matchDrumCatalog) if nothing
// scores well enough to trust.
function fuzzyMatchDrumCatalog(spoolSizeText, drumEntries) {
  const query = fuzzyDrumCodeGuess(spoolSizeText);
  if (!query) return null;
  const fuse = new Fuse(drumEntries, { keys: ["itemName"], includeScore: true, threshold: 0.4, ignoreLocation: true });
  const [hit] = fuse.search(query);
  if (!hit) return null;
  const suffix = spoolSizeText.slice(query.length).trim();
  return {
    itemCode: hit.item.itemNo,
    name: suffix ? `${hit.item.itemName} ${suffix}` : hit.item.itemName,
    unit: hit.item.unit,
  };
}

// Matches one drum/spool text segment (already stripped of any length
// label - see splitLengthLabel; e.g. "W600A 600X400X340" or "W1250B II
// 1250*800*740") against the catalog's own "Drum" items ("Wooden drum
// W600A", "Wooden drum W1250B II" - confirmed against real catalog data:
// CIP's text starts with the item's own trailing code, not its full name).
// Tried candidates are each catalog entry's own last one or two words (a
// plain code like "W600A" is one word; some have a following "II"/"III"
// variant marker, two words) - plus, since CIP doesn't always keep the
// code's own leading "W" (see withoutLeadingW), that same code again with
// it stripped. The longest candidate that matches, at a word boundary (so
// "W600A" doesn't wrongly match a "W6001..." CIP text), wins; this is what
// makes "W1250B II ..." pick the "II" catalog entry over the shorter
// "W1250B" one that would otherwise also match its first word alone. Falls
// back to a fuzzy search (see fuzzyMatchDrumCatalog) when nothing matches
// this way at all, rather than giving up outright.
// Exported for scripts/check-drum-match.mjs, which runs this against the
// real catalog - the matching is pure string work and worth a test that
// does not need CIP.
export function matchDrumCatalog(spoolSizeText, drumEntries) {
  if (!spoolSizeText) return null;
  let best = null;
  const consider = (code, entry) => {
    const boundaryOk = spoolSizeText.length === code.length || /\s/.test(spoolSizeText[code.length] ?? "");
    if (spoolSizeText.startsWith(code) && boundaryOk && (!best || code.length > best.code.length)) {
      best = { entry, code };
    }
  };
  for (const entry of drumEntries) {
    const words = entry.itemName.trim().split(/\s+/);
    for (const wordCount of [2, 1]) {
      if (words.length < wordCount) continue;
      const code = words.slice(-wordCount).join(" ");
      consider(code, entry);
      const stripped = withoutLeadingW(code);
      if (stripped) consider(stripped, entry);
    }
  }
  if (!best) return fuzzyMatchDrumCatalog(spoolSizeText, drumEntries);
  const suffix = spoolSizeText.slice(best.code.length).trim();
  return {
    itemCode: best.entry.itemNo,
    // The catalog's own name doesn't carry the order-specific dimensions
    // (that's the whole reason this match is needed) - appended here so the
    // full "Wooden drum W600A 600X400X340" shows up as one name rather than
    // losing either half.
    name: suffix ? `${best.entry.itemName} ${suffix}` : best.entry.itemName,
    unit: best.entry.unit,
  };
}

// Matches every one of a line's drum/spool segments (see
// cip.js's extractSpoolSizeSegments - usually just one, but a cable run
// split across several reels has more), each through splitLengthLabel +
// matchDrumCatalog above; a segment's own length label, if it has one, is
// appended onto the matched material's name (e.g. "Wooden drum W1250B
// 1250*650*740 (4km)") so which reel gets how much stays visible. A
// segment nothing in the catalog matches is silently dropped rather than
// failing the whole line.
function matchDrumSegments(segments, drumEntries) {
  return segments
    .map((segment) => {
      const { label, rest } = splitLengthLabel(segment);
      const drum = matchDrumCatalog(rest, drumEntries);
      if (!drum) return null;
      return { ...drum, name: label ? `${drum.name} (${label})` : drum.name };
    })
    .filter(Boolean);
}

// Puts the matched drum(s)/spool(s) (see matchDrumSegments above) first in
// each line's own `materials` - each is a real "Materiały SM" item once
// matched (a Drum-category catalog row), so it belongs in the same list an
// operator already reads for this order, not a separate field; first
// because it's what the cable ships on, worth seeing before the
// ingredients that go inside it. `qty`/`requiredQuantity` are left unset:
// CIP's free text only ever says which drum(s), never how many of each. No
// line here having any `spoolSizeSegments` at all (most orders don't - see
// cip.js's extractSpoolSizeSegments) skips the catalog lookup entirely
// instead of running it to find nothing: nothing to search for, nothing
// extra to show.
async function withDrumMaterial(lines) {
  if (!lines.some((line) => (line.spoolSizeSegments ?? []).length > 0)) return lines;
  const drumEntries = await drumCatalogEntries();
  return lines.map((line) => {
    const drums = matchDrumSegments(line.spoolSizeSegments ?? [], drumEntries);
    if (!drums.length) return line;
    return {
      ...line,
      materials: [
        ...drums.map((drum) => ({ ...drum, qty: null, requiredQuantity: null, isDrumRequirement: true })),
        ...(line.materials ?? []),
      ],
    };
  });
}

// One { orderId, segDescription, materials } entry per matched line - shared
// by /materials and /materials/warehouse, `filter` (if given) trims each
// line's own materials array first (see the warehouse route below).
// `segDescription` (CIP's own "segment" for the line, e.g. "2.1*475") comes
// along for context - it's the line's own field, not a material's, so it
// doesn't fit the materials array itself.
function materialsByLine(lines, filter) {
  return lines.map((line) => ({
    orderId: line.orderId,
    segDescription: line.segDescription ?? null,
    materials: filter ? (line.materials ?? []).filter(filter) : line.materials ?? [],
  }));
}

// A full orderId ("...(4)") is exactly one line, so the response is that
// line's own object; a bare order number can match several - imprecise, so
// there's no single right line to answer with - and the response is instead
// an array of per-line entries, never mixed together.
function respondMaterials(res, byLine) {
  res.json(byLine.length === 1 ? byLine[0] : byLine);
}

// POST rather than GET: `orderId` can contain "(" ")" (URL-encoding hassle
// on every caller) and, since getCipOrderMaterials now also accepts a
// fragment/suffix (see cip.js's resolveOrderIdsByFragment), potentially
// other odd substrings too - a JSON body sidesteps all of that instead of
// relying on URL-encoding it correctly everywhere. Takes `{ orderId }`.
function readOrderId(req) {
  const orderId = String(req.body?.orderId ?? "").trim();
  if (!orderId) throw new ApiError("Podaj numer zamówienia (pole orderId).", 400);
  return orderId;
}

function readCipToken(req) {
  const cipToken = req.header("X-Cip-Token");
  if (!cipToken) throw new ApiError("Brak sesji CIP - zaloguj się ponownie.", 401);
  return cipToken;
}

// POST /api/cip-orders { orderId } - CIP's order search + the bill of
// materials for each matching line (see cip.js's getCipOrderMaterials).
// `orderId` is a full orderId ("260010309034801(4)", that one line only), a
// bare order number ("260010309034801", every line), or just a fragment/the
// ending of one ("9034801" - resolved via CIP's own loose search, see
// cip.js). Always live against CIP (not gated by CIP_SYNC - see that
// function's comment), so it needs the caller's own CIP token, same header
// as the write endpoints.
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const orderId = readOrderId(req);
    const cipToken = readCipToken(req);
    const lines = await getCipOrderMaterials(orderId, cipToken);
    res.json({ orderId, lines });
  })
);

// POST /api/cip-orders/materials { orderId } - same lookup, trimmed to just
// the materials (see materialsByLine/respondMaterials above for the response shape).
router.post(
  "/materials",
  asyncHandler(async (req, res) => {
    const orderId = readOrderId(req);
    const cipToken = readCipToken(req);
    const lines = await withDrumMaterial(await withCatalogNames(await getCipOrderMaterials(orderId, cipToken)));
    respondMaterials(res, materialsByLine(lines));
  })
);

// POST /api/cip-orders/materials/warehouse { orderId } - same as
// /materials, but kept to only the materials this warehouse actually
// stocks: CIP's BOM lists everything the order needs (fibre, masterbatch,
// ripcord, ...), most of it from other warehouses/processes - this keeps
// only rows whose CIP `itemCode` is a known "Materiały SM" item
// (sm_catalog.item_no - same numbering, confirmed against real data; see
// knownSmItemNos). Runs after withCatalogNames, so a substituted material
// is matched on the item it was changed *to* - matching the stale pre-swap
// number here would keep/drop the wrong rows whenever only one side of a
// swap is a warehouse item.
router.post(
  "/materials/warehouse",
  asyncHandler(async (req, res) => {
    const orderId = readOrderId(req);
    const cipToken = readCipToken(req);
    const lines = await withDrumMaterial(await withCatalogNames(await getCipOrderMaterials(orderId, cipToken)));
    const allItemCodes = lines.flatMap((line) => (line.materials ?? []).map((m) => m.itemCode));
    const known = await knownSmItemNos(allItemCodes);
    respondMaterials(res, materialsByLine(lines, (m) => known.has(String(m.itemCode ?? "").trim())));
  })
);

// Two more CIP calls per position (the BOM and its substitutions), so the
// same four-at-a-time ceiling the progress lookup itself uses.
const BOM_FETCH_CONCURRENCY = 4;

// A position is its erpNumber *and* its orderId: one erpNumber can be two
// lines of the same order, each with its own length and its own BOM.
const positionKey = (row) => `${row.erpNumber}|${row.orderId ?? ""}`;

/**
 * Each found position given a `materials` object - the kinds of material
 * this screen calls out of its bill of materials, `{ frp: [...], pe: [...] }`,
 * each an empty array when the position needs nothing of that kind.
 *
 * Which group a material belongs to is `MATERIAL_GROUPS`
 * (productionProgress.js) - see it for why FRP is matched on the name and PE
 * only on the category.
 *
 * Both are applied to **our catalog's** own name and category, and only to
 * items this warehouse stocks: a BOM lists everything the order needs, most
 * of it from other warehouses and processes, the same reason
 * /materials/warehouse filters at all. CIP's own free-text description never
 * decides a group, or the match would depend on how CIP happens to word a
 * row.
 *
 * Quantities come straight from CIP's BOM (`requiredQuantity` - the whole
 * run's need, in the catalog's own unit). `remainingQuantity` is that
 * scaled by how much of the run is still to make, which is the number
 * somebody planning the next shift actually wants: it is derived as a
 * **proportion of the required amount**, not by multiplying CIP's per-km
 * `qty`, so it holds whatever unit that material is counted in.
 */
async function attachBomMaterials(rows, cipToken) {
  const targets = rows.filter((row) => row.found && row.orderId);
  if (!targets.length) return rows;

  const boms = new Map();
  const queue = [...targets];
  const workers = Array.from({ length: Math.min(BOM_FETCH_CONCURRENCY, queue.length) }, async () => {
    for (let row = queue.shift(); row !== undefined; row = queue.shift()) {
      const key = positionKey(row);
      if (boms.has(key)) continue;
      boms.set(key, await cipOrderBomForRow(row, cipToken));
    }
  });
  await Promise.all(workers);

  // One pass through the shared naming/substitution normalisation, so a
  // swapped material is reported as the item actually to be used now - the
  // stale pre-swap number has been a real bug here before (see
  // withCatalogNames).
  const named = await withCatalogNames([...boms.entries()].map(([key, materials]) => ({ key, materials })));
  const byKey = new Map(named.map((line) => [line.key, line.materials]));
  const allCodes = named.flatMap((line) => line.materials.map((m) => m.itemCode));
  // The name decides one group, the category the other (see
  // MATERIAL_GROUPS), so both are looked up.
  const [known, categories] = await Promise.all([knownSmItemNos(allCodes), smItemCategories(allCodes)]);

  return rows.map((row) => {
    const materials = byKey.get(positionKey(row));
    if (!materials) return row;

    // How much of the run is still to make, as a fraction. Used only for a
    // material whose own stage is unknown - everything else is scaled by
    // the stage that actually consumes it (below), which is the honest
    // number: stranding can be finished while sheathing has half the run
    // left, and one figure cannot be right for both.
    const runScale =
      row.totalLength > 0 && row.remainingLength !== null && row.remainingLength !== undefined
        ? row.remainingLength / row.totalLength
        : null;

    const catalogued = materials
      .filter(
        (m) =>
          // The drum entries this file appends elsewhere are not BOM
          // materials and carry no quantity at all.
          !m.isDrumRequirement && known.has(String(m.itemCode ?? "").trim())
      )
      .map((m) => {
        const itemNo = String(m.itemCode ?? "").trim();
        const required = Number(m.requiredQuantity ?? 0) || null;
        // CIP's BOM names the stage on the material itself.
        const process = String(m.process ?? "").trim().toLowerCase() || null;
        const stage = process ? row.processes?.[process] : null;
        const scale = stage && stage.planned > 0 ? stage.remaining / stage.planned : runScale;
        return {
          itemNo,
          name: m.name,
          category: categories.get(itemNo) ?? "",
          unit: m.unit ?? "",
          process,
          // CIP's own layer/operation for the material, carried through
          // because a stage can run more than one layer and the two are
          // what a question about this row would be chased with.
          layer: m.layer ?? null,
          operationCode: m.operationCode ?? null,
          requiredQuantity: required,
          remainingQuantity: required !== null && scale !== null ? Math.round(required * scale * 1000) / 1000 : null,
          // What one kilometre of cable takes - see perKmConsumption for why
          // this is derived from the run rather than read off CIP's own qty.
          perKm: perKmConsumption(required, row.totalLength),
        };
      });

    // The stage cells carry the materials that stage consumes; the
    // position-level grouping stays for the plain view, which has no stage
    // columns to put them in.
    const byProcess = groupBomMaterialsByProcess(catalogued);
    const processes = Object.fromEntries(
      Object.entries(row.processes ?? {}).map(([key, figures]) => [
        key,
        { ...figures, materials: byProcess[key] ?? null },
      ])
    );

    return { ...row, processes, materials: groupBomMaterials(catalogued) };
  });
}

// How much of a paste this will look up at once. The planners' list is a
// shift's worth of work (a real one: 26 positions across 16 orders), so this
// is far above anything real - it is here so a paste of the wrong thing
// entirely cannot turn into hundreds of requests against CIP.
const MAX_PROGRESS_POSITIONS = 400;

// And how many positions those may resolve to. A pasted order number is one
// entry but every line of that order (twelve, for a real one), so this is
// the limit that actually bounds the work - well above a shift's list, and
// there so a paste of the wrong thing cannot turn into a thousand CIP calls.
const MAX_PROGRESS_ROWS = 600;

// POST /api/cip-orders/progress { text } - "Postęp produkcji": the planners'
// pasted list of what runs on which line, answered per position with the
// length of the run and how much of it is still to be made (see
// productionProgress.js for the format and for where those figures come
// from). The paste is parsed here rather than in the client so that one
// tested parser serves every caller.
router.post(
  "/progress",
  asyncHandler(async (req, res) => {
    const text = String(req.body?.text ?? "");
    const cipToken = readCipToken(req);
    const entries = parsePastedProgressList(text);
    if (!entries.length) {
      throw new ApiError("Nie znaleziono w tekście żadnej pozycji (np. CF-260010303028101-544182).", 400);
    }
    if (entries.length > MAX_PROGRESS_POSITIONS) {
      throw new ApiError(`Za dużo pozycji naraz (${entries.length}, limit ${MAX_PROGRESS_POSITIONS}).`, 400);
    }
    const { rows, ordersQueried, processKeys } = await getProductionProgress(entries, cipToken);
    // One pasted *order* number stands for every line of that order, so the
    // result can be several times the size of the paste - a 26-number list
    // of 12-line orders is 300 positions, and each of those costs two more
    // CIP calls for its materials. Checked here, after the (cheap) searches
    // and before that expensive part, so the refusal names a real number
    // instead of the request simply taking minutes.
    if (rows.length > MAX_PROGRESS_ROWS) {
      throw new ApiError(
        `Numery rozwinęły się na ${rows.length} pozycji (limit ${MAX_PROGRESS_ROWS}) - wklej mniej zamówień naraz.`,
        400
      );
    }
    // Which materials each position needs, straight from CIP's own BOM -
    // this screen is read while planning what has to go out to the lines, so
    // the material is half the answer (see attachBomMaterials).
    const withMaterials = await attachBomMaterials(rows, cipToken);
    res.json({
      rows: withMaterials,
      ordersQueried,
      positions: entries.length,
      processKeys,
      // Only the material kinds something in this paste actually needs,
      // so a group nothing needs never becomes a column.
      materialKeys: presentMaterialKeys(withMaterials),
      // What a day's run takes of each FRP and how many rolls that is -
      // per line, never pooled, since parallel machines cannot share a roll
      // (see frpRollsForDay).
      frpRolls: frpRollsForDay(withMaterials),
    });
  })
);

// Anything else under /cip-orders (wrong method, e.g. a GET, or an unknown
// path) would otherwise fall through this whole router and land on app.js's
// generic "/:material" catch-all, which then rejects "cip-orders" itself as
// an unknown material - a confusing error unrelated to the real problem
// (this exact fall-through, via GET to a bare "/cip-orders", was seen live
// from Postman before these routes were POST-only). This stops that
// fall-through with the actual problem instead.
router.use(() => {
  throw new ApiError("Ten endpoint przyjmuje tylko POST z numerem zamówienia w treści (JSON: { orderId }).", 405);
});

export default router;
