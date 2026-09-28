import { Router } from "express";
import Fuse from "fuse.js";
import { getCipOrderMaterials } from "../cip.js";
import { knownSmItemNos, smItemNames, drumCatalogEntries } from "../smCatalog.js";
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
// too. `name` is this row's current identity (the changed-to item, when
// there is one); `materialChange.fromName`/`toName` are only added for a row
// that has a `materialChange`, so the client never has to duplicate this
// fallback logic itself.
async function withCatalogNames(lines) {
  const codes = lines.flatMap((line) =>
    (line.materials ?? []).flatMap((m) => [m.itemCode, m.materialChange?.to]).filter(Boolean)
  );
  const catalogNames = await smItemNames(codes);
  return lines.map((line) => ({
    ...line,
    materials: (line.materials ?? []).map((m) => {
      const currentCode = m.materialChange?.to ?? m.itemCode;
      const material = { ...m, name: catalogNames.get(currentCode) ?? (m.materialChange?.desc || cipDesc(m)) };
      if (m.materialChange) {
        material.materialChange = {
          ...m.materialChange,
          fromName: catalogNames.get(m.itemCode) ?? cipDesc(m),
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
function withoutLeadingW(code) {
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
function splitLengthLabel(segment) {
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
function matchDrumCatalog(spoolSizeText, drumEntries) {
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
// knownSmItemNos).
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
