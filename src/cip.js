import { ApiError } from "./errors.js";

// Link between this API and CIP (the company's legacy system, the same one
// POST /api/auth/login talks to). Our database is the source of truth: an
// operation is validated here, pushed to CIP with the CIP token of the person
// who does it, and only then applied to our tables (see AGENTS.md, "CIP sync").
//
// CIP_SYNC switches the whole thing:
//   CIP_SYNC=true      operations are sent to CIP
//   anything else      (default) nothing is sent - pushToCip() answers "skipped"
//                      and the caller carries on as if CIP had accepted. For
//                      development/tests without CIP; production sets it to true.
//
// SKIP_CIP_AUTH (login bypass, see routes/auth.js) is a separate switch: with
// it on, the "token" a client holds is not a real CIP token, so a live sync
// refuses to run rather than send it to CIP.

const BYPASS_TOKEN = "local-bypass";
const CIP_TIMEOUT_MS = 15000;

function parseQty(value) {
  const n = Number(String(value ?? "").trim().replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

// Same formatting rule as wpsApi's other quantity fields (smSpools.js etc.).
function formatQty(n) {
  return n % 1 === 0 ? String(Math.trunc(n)) : n.toFixed(3);
}

export function cipSyncEnabled() {
  return process.env.CIP_SYNC === "true";
}

export function logCipSyncMode() {
  console.log(
    cipSyncEnabled()
      ? `[cip] sync ON - operations are sent to CIP (${process.env.OLD_APP_BASE_URL})`
      : "[cip] sync OFF (CIP_SYNC is not \"true\") - operations are NOT sent to CIP"
  );
}

// POST a JSON body to a CIP path (e.g. "/wms/materialTemporaryStorageWarehouse/inStorage")
// with the given user's CIP token. Returns { status, ok, json } and does NOT
// judge the answer: CIP replies { code: 0, msg: "...", data: null } even when
// it refused the operation (e.g. "Cannot exceed inventory quantity"), so what
// counts as success is decided per operation by its handler below.
export async function cipFetch(path, cipToken, body) {
  let res;
  try {
    res = await fetch(`${process.env.OLD_APP_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        "accept-language": "pl",
        authorization: `Bearer ${cipToken}`,
        "content-type": "application/json",
        // Sent by CIP's own web UI on every call (an epoch-seconds stamp and the tenant).
        "cip-cache": String(Math.floor(Date.now() / 1000)),
        "tenant-id": process.env.OLD_APP_TENANT_ID ?? "1",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CIP_TIMEOUT_MS),
    });
  } catch (err) {
    // Network down, CIP unreachable or too slow: a plain thrown error would
    // reach the client as a bare "Błąd serwera." - say what actually failed
    // (nothing was sent/changed) and keep the real cause in the server log.
    console.error(`[cip] request to ${path} failed:`, err);
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    throw new ApiError(
      timedOut ? "CIP nie odpowiedziało w czasie - operacja nie została wykonana." : "Nie udało się połączyć z CIP - operacja nie została wykonana.",
      502
    );
  }
  const json = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, json };
}

// CIP refused the caller's token itself (expired or invalid) - not a refusal
// of the operation. Says so with a stable code, so the client renews the
// session (or asks for a login) instead of showing an opaque CIP message.
// CIP's exact wording for this is not known: a 401/403, or an error reply
// (code 1) whose text talks about the token, counts.
function assertTokenAccepted(reply) {
  const msg = String(reply.json?.msg ?? "");
  const rejected = reply.status === 401 || reply.status === 403 || (reply.json?.code === 1 && /token|expired|unauthori[sz]ed|login/i.test(msg));
  if (rejected) {
    console.warn(`[cip] token refused (HTTP ${reply.status}): ${msg}`);
    throw new ApiError("Sesja CIP wygasła - zaloguj się ponownie.", 401, { code: "session_expired" });
  }
}

// Success, as CIP answers it (seen for outStorage): { code: 0, msg: null, data: true }.
// A refusal has the same code: { code: 0, msg: "Temporary Warehouse Outbound
// Specification:45.0Cannot exceed inventory quantity:0.0", data: null } - so
// `code` alone proves nothing; the data flag does.
export function cipAccepted(reply) {
  return reply.ok && reply.json?.code === 0 && reply.json?.data === true;
}

// CIP has no notion of a spool: a material's quantity in CIP is one combined
// number (possibly split across a few rows by location, never by spool).
// smpda/wps layer spool tracking on top of that entirely on our side - CIP
// only ever sees item + quantity for an issue/receipt. An item spread across
// more than one CIP row is refused rather than split (see the earlier
// decision on multi-row issues) - still needs a query-by-item request to know
// which row(s) hold it and how much (not captured yet).

const INVENTORY_QUERY_PATH = "/wms/materialTemporaryStorageWarehouse/query/page";
// The most rows a single page of that query returns (matches what wps's own
// cipInventory.js already asks for) - looped over if CIP ever has more.
const QUERY_PAGE_SIZE = 500;

// Every row CIP currently has for one item number, by scanning query/page -
// there is no server-side filter for this (see AGENTS.md's CIP sync section
// for why reusing this endpoint, rather than a dedicated filtered one, is the
// pragmatic choice). Ordered as CIP returned them, newest first, matching
// wps's own inventory query.
async function findCipRows(itemNo, cipToken) {
  const rows = [];
  let current = 1;
  for (;;) {
    const reply = await cipFetch(INVENTORY_QUERY_PATH, cipToken, {
      page: { size: QUERY_PAGE_SIZE, current, orders: [{ column: "createTime", asc: false }] },
    });
    assertTokenAccepted(reply);
    if (!reply.ok || reply.json?.code !== 0) {
      throw new ApiError(reply.json?.msg || `Nie udało się odczytać stanu z CIP (${reply.status}).`, 502);
    }
    const page = reply.json.data ?? {};
    const pageRows = page.records ?? [];
    for (const row of pageRows) {
      if (String(row.itemNo ?? "").trim() === itemNo) rows.push(row);
    }
    if (pageRows.length < QUERY_PAGE_SIZE || current * QUERY_PAGE_SIZE >= (page.total ?? 0)) break;
    current += 1;
  }
  return rows;
}

// The single CIP row to issue [quantity] of [itemNo] from. CIP has no concept
// of a spool - our spools are a layer on top of one combined quantity per
// item, so this never needs to know which spool is being issued, only how
// much. Per the earlier decision: an issue that no single CIP row can cover
// alone is refused rather than split across rows (throws with each row's own
// quantity, so the message can say what IS available).
async function findCipRowToIssue(itemNo, quantity, cipToken) {
  const rows = await findCipRows(itemNo, cipToken);
  if (!rows.length) throw new ApiError(`Materiału ${itemNo} nie ma w CIP.`, 409);

  const sufficient = rows
    .map((row) => ({ row, available: parseQty(row.specifications) }))
    .filter(({ available }) => Number.isFinite(available) && available + 1e-9 >= quantity)
    .sort((a, b) => a.available - b.available); // the tightest fit first
  if (!sufficient.length) {
    const available = rows.map((row) => formatQty(parseQty(row.specifications) || 0)).join(", ");
    throw new ApiError(`Żaden pojedynczy wpis w CIP nie ma wystarczającej ilości (dostępne: ${available}).`, 409);
  }
  return sufficient[0].row;
}

// Order lookup ("Obsługa zamówień" prep - see AGENTS.md roadmap step 7 and
// material_order's `production_order_no`): CIP's own order search and its
// per-line bill of materials. Read-only, so unlike HANDLERS.* below this does
// NOT go through pushToCip/CIP_SYNC - there's no local copy of this data to
// fall back to, it only ever exists in CIP. Still needs the caller's own CIP
// token (same as everything else in this file): CIP has no notion of a
// service account here.

// "Order process count" screen's own search - takes a full orderId
// ("260010309034801(4)", order number + line in parens) directly, unlike
// order/infor/page/search's loose orderNumber match, so this is an exact
// lookup for one line. `workStatus: "4"` and `processRouteList: []` are
// captured as-is from CIP's own UI request for this screen (meaning of "4"
// not confirmed - narrow the filter or make it a parameter if a line in
// another status ever needs to be found and isn't).
const ORDER_SEARCH_PATH = "/cppms/orderProcessCount/page/search";
// A different CIP screen's search - the one this file used before switching
// to orderProcessCount above. Kept only as a fallback (see
// resolveOrderIdsByFragment below): unlike orderProcessCount's `orderId`,
// its own `orderInfor.orderNumber` does a loose "contains" match (confirmed
// live: searching "9034801" matched full number "260010309034801"), which is
// what makes searching by a fragment or just the ending of an order number
// possible at all.
const ORDER_RESOLVE_PATH = "/cppms/order/infor/page/search";
const BOM_SEARCH_PATH = "/cppms/historical/bom/search/erpNumber";
const ORDER_SEARCH_PAGE_SIZE = 100;

// The order line(s) CIP has for `orderId`. Each returned row is one
// production line of the order (its own erpNumber/orderId/orderSn). Paged
// the same way findCipRows does for inventory in case more than one line
// (or, for a bare order number with no "(n)", several lines) comes back.
async function findCipOrderLines(orderId, cipToken) {
  const lines = [];
  let current = 1;
  for (;;) {
    const reply = await cipFetch(ORDER_SEARCH_PATH, cipToken, {
      page: { current, size: ORDER_SEARCH_PAGE_SIZE },
      orderProcessCountDto: {
        processRouteList: [],
        workStatus: "4",
        orderId,
        requestDateStart: "",
        requestDateEnd: "",
        dispatchTimeStart: "",
        dispatchTimeEnd: "",
      },
    });
    assertTokenAccepted(reply);
    if (!reply.ok || reply.json?.code !== 0) {
      throw new ApiError(reply.json?.msg || `Nie udało się wyszukać zamówienia w CIP (${reply.status}).`, 502);
    }
    const page = reply.json.data ?? {};
    const pageRows = page.records ?? [];
    lines.push(...pageRows);
    if (pageRows.length < ORDER_SEARCH_PAGE_SIZE || current * ORDER_SEARCH_PAGE_SIZE >= (page.total ?? 0)) break;
    current += 1;
  }
  return lines;
}

// Every distinct exact orderId ("260010309034801(4)") CIP's loose order
// search turns up for `fragment` - a snippet or just the ending of an order
// number, e.g. "9034801" for "260010309034801". Used only when
// findCipOrderLines's own exact search (orderProcessCount) comes up empty
// (see getCipOrderMaterials): this is purely a resolver, so each id it finds
// still goes through findCipOrderLines again afterwards for the real,
// consistent per-line data (segDescription, workStatus, ...) - order/infor's
// own records carry a different/older field set, not reused directly here.
async function resolveOrderIdsByFragment(fragment, cipToken) {
  const ids = new Set();
  let current = 1;
  for (;;) {
    const reply = await cipFetch(ORDER_RESOLVE_PATH, cipToken, {
      page: { current, size: ORDER_SEARCH_PAGE_SIZE },
      orderInfor: { orderNumber: fragment },
      requestDateStart: "",
      requestDateEnd: "",
    });
    assertTokenAccepted(reply);
    if (!reply.ok || reply.json?.code !== 0) {
      throw new ApiError(reply.json?.msg || `Nie udało się wyszukać zamówienia w CIP (${reply.status}).`, 502);
    }
    const page = reply.json.data ?? {};
    const pageRows = page.records ?? [];
    for (const row of pageRows) if (row.orderId) ids.add(row.orderId);
    if (pageRows.length < ORDER_SEARCH_PAGE_SIZE || current * ORDER_SEARCH_PAGE_SIZE >= (page.total ?? 0)) break;
    current += 1;
  }
  return [...ids];
}

// The materials (BOM) CIP has on file for one order line. Shape of `data` is
// whatever CIP's own BOM screen shows - not reshaped here, just passed
// through, since only the request (not a real response) was captured so far.
async function findCipOrderBom({ erpNumber, orderId, orderSn }, cipToken) {
  const reply = await cipFetch(BOM_SEARCH_PATH, cipToken, { erpNumber, orderId, orderSn });
  assertTokenAccepted(reply);
  if (!reply.ok || reply.json?.code !== 0) {
    throw new ApiError(reply.json?.msg || `Nie udało się pobrać materiałów zamówienia z CIP (${reply.status}).`, 502);
  }
  return reply.json.data ?? null;
}

// CIP's own "historyEdit" screen - free-text process requirements per order
// line (cable structure, print/marking instructions, test requirements,
// packaging...), keyed by `orderSn` (the line's own, from findCipOrderLines
// - not orderId). This is where a line's drum/spool size requirement lives,
// e.g. "Rozmiar szpuli: W600A 600X400X340" - nowhere in the order/BOM data
// above (confirmed live, captured from CIP's own order detail page).
const HISTORY_EDIT_PATH = "/cppms/historical/historyEdit/search";

async function findCipOrderProcessRequirements(orderSn, cipToken) {
  if (orderSn == null) return null;
  const reply = await cipFetch(HISTORY_EDIT_PATH, cipToken, { orderSn });
  assertTokenAccepted(reply);
  if (!reply.ok || reply.json?.code !== 0) {
    throw new ApiError(reply.json?.msg || `Nie udało się pobrać wymagań procesowych zamówienia z CIP (${reply.status}).`, 502);
  }
  return reply.json.data ?? null;
}

// Which of the several free-text "opRequest*" fields (one per production
// process stage - SH = sheath/oblew, SC = stranding/skręcanie, ...) carries
// a "Rozmiar szpuli: ..." segment varies by order/cable type (confirmed
// live: found under `opRequestSh` for one real order) - every one of them
// is checked here, first match wins. Each field is CIP's own "/"-separated
// list of free-text requirements, same style as `stDescription` elsewhere
// in this file.
const OP_REQUEST_FIELDS = ["opRequestSh", "opRequestSc", "opRequestTb", "opRequestDp", "opRequestTest", "opRequestCustomer"];
const SPOOL_SIZE_LABEL_RE = /rozmiar\s+szpuli\s*:\s*(.+)/i;

// A single order line can need more than one drum - a cable run split
// across several physical reels, each its own size, e.g. "Rozmiar szpuli:
// 4km: 1250B 1250*650*740 ; 2km: 1120B II 1120*650*740" (confirmed live) -
// so every ";"-separated piece of the "Rozmiar szpuli:" text comes back as
// its own array entry, not just the first/only one. A plain single-drum
// line (no ";") is a one-element array. Each entry is still raw CIP text -
// a drum/spool code plus its own dimensions, and here possibly a leading
// "4km:"-style length label too, none of it split apart further here.
// Matching a piece against an actual catalog item is routes/cipOrders.js's
// job (it alone touches the database) - see that file's `matchDrumCatalog`
// and `splitLengthLabel`.
function extractSpoolSizeSegments(historyEditData) {
  if (!historyEditData) return [];
  for (const field of OP_REQUEST_FIELDS) {
    const text = historyEditData[field];
    if (!text) continue;
    for (const segment of String(text).split("/")) {
      const match = segment.trim().match(SPOOL_SIZE_LABEL_RE);
      if (match) {
        return match[1]
          .split(";")
          .map((piece) => piece.trim())
          .filter(Boolean);
      }
    }
  }
  return [];
}

// A material substituted on this order - e.g. a discontinued reel of tape
// swapped for a newer one - shows up here, not in the BOM itself (the BOM
// just lists whichever item number is current). `orderId` is the exact
// full form ("...(4)"): the query does accept a bare order number too, but
// then mixes in every line's substitutions, which findCipOrderBom's
// per-line matching below can't attribute correctly - so this is only ever
// called with one line's own exact orderId.
const MATERIAL_MAPPING_SEARCH_PATH = "/cms/material/mapping/page/query";
const MATERIAL_MAPPING_PAGE_SIZE = 100;

async function findCipMaterialMappings(orderId, cipToken) {
  const mappings = [];
  let current = 1;
  for (;;) {
    const reply = await cipFetch(MATERIAL_MAPPING_SEARCH_PATH, cipToken, {
      page: { current, size: MATERIAL_MAPPING_PAGE_SIZE },
      materialItemOriginal: "",
      materialItem: "",
      materialDescLong: "",
      materialTypeCode: "",
      materialTypeName: "",
      orderId,
      createBy: "",
      createTime: [],
      createTimeStart: "",
      createTimeEnd: "",
    });
    assertTokenAccepted(reply);
    if (!reply.ok || reply.json?.code !== 0) {
      throw new ApiError(reply.json?.msg || `Nie udało się pobrać zamian materiałów z CIP (${reply.status}).`, 502);
    }
    const page = reply.json.data ?? {};
    const pageRows = page.records ?? [];
    mappings.push(...pageRows);
    if (pageRows.length < MATERIAL_MAPPING_PAGE_SIZE || current * MATERIAL_MAPPING_PAGE_SIZE >= (page.total ?? 0)) break;
    current += 1;
  }
  return mappings;
}

// Attaches each material mapping to the BOM row(s) it concerns - matched by
// itemCode against either side of the mapping (materialItemOriginal or
// materialItem), since it isn't confirmed here which one the BOM's own
// itemCode reflects after a swap. A material with no matching mapping is
// left untouched (no `materialChange` field at all, rather than null - so
// callers can just check for its presence).
function attachMaterialChanges(materials, mappings) {
  if (!mappings.length) return materials;
  return (materials ?? []).map((material) => {
    const mapping = mappings.find(
      (m) => m.materialItemOriginal === material.itemCode || m.materialItem === material.itemCode
    );
    if (!mapping) return material;
    return {
      ...material,
      materialChange: {
        from: mapping.materialItemOriginal,
        to: mapping.materialItem,
        desc: mapping.materialDesc,
        changedAt: mapping.createTime,
      },
    };
  });
}

// CIP's `orderId` is `orderNumber` plus "(lineNumber)", e.g.
// "260010309034801(4)" for line 4 of order 260010309034801 - a bare order
// number (no "(n)") is also accepted and, since findCipOrderLines's own
// search isn't confirmed to be exact-only, is used as a safety net below:
// with a full orderId, a result whose own `orderId` doesn't match exactly is
// dropped instead of trusted blindly.
function hasLineSuffix(orderId) {
  return /\(\d+\)$/.test(String(orderId));
}

// Splits a trailing "(n)" off `orderId`, if it has one - e.g. "25501(1)"
// (a fragment/ending of the number, but WITH a real line suffix already
// attached) becomes { numberPart: "25501", lineSuffix: "(1)" }. Needed
// because order/infor's own `orderNumber` field (the one the loose fragment
// search in resolveOrderIdsByFragment below runs against) is purely
// numeric - it never contains "(" ")" at all, so searching it for
// "25501(1)" literally, parens included, finds nothing even though "25501"
// alone would (confirmed live: this was exactly why that combination failed
// while a full "...025501(1)" or a bare "25501" each worked on their own).
function splitOrderIdFragment(orderId) {
  const match = String(orderId).match(/^(.*?)(\(\d+\))$/);
  return match ? { numberPart: match[1], lineSuffix: match[2] } : { numberPart: String(orderId), lineSuffix: null };
}

// The order line(s) matching `orderId`, each with its materials attached
// (see findCipOrderBom) and any material substitution CIP has on file for
// that exact line (see findCipMaterialMappings/attachMaterialChanges) -
// materials involved carry their own `materialChange`, and the line also
// keeps the raw list as `materialMappings` (rarely needed on its own, but
// kept rather than dropped, e.g. a mapping whose item isn't in this BOM at
// all). Throws ApiError (404) if CIP has nothing under that orderId at all.
export async function getCipOrderMaterials(orderId, cipToken) {
  const allLines = await findCipOrderLines(orderId, cipToken);
  let lines = hasLineSuffix(orderId) ? allLines.filter((line) => line.orderId === orderId) : allLines;

  // orderProcessCount only matches a full, exact orderId - a fragment or just
  // the ending of one finds nothing there (confirmed live). Retried through
  // order/infor's loose search purely to resolve which exact orderId(s) that
  // fragment means (see resolveOrderIdsByFragment) - each is then looked up
  // again the normal way, so a fragment match returns the exact same shape a
  // typed-in-full orderId would. Only the numeric part of the fragment is
  // searched (see splitOrderIdFragment) - a fragment that already carries
  // its own real "(n)" (e.g. "25501(1)") narrows the resolved candidates
  // back down to that one line afterwards instead of passing the "(n)" into
  // the search itself, where it could never match anything.
  if (!lines.length) {
    const { numberPart, lineSuffix } = splitOrderIdFragment(orderId);
    const resolvedIds = (await resolveOrderIdsByFragment(numberPart, cipToken)).filter(
      (id) => !lineSuffix || id.endsWith(lineSuffix)
    );
    const resolvedLines = await Promise.all(resolvedIds.map((id) => findCipOrderLines(id, cipToken)));
    lines = resolvedLines.flat().filter((line) => resolvedIds.includes(line.orderId));
  }

  if (!lines.length) throw new ApiError(`Nie znaleziono zamówienia ${orderId} w CIP.`, 404);
  return Promise.all(
    lines.map(async (line) => {
      const [materials, materialMappings, processRequirements] = await Promise.all([
        findCipOrderBom(line, cipToken),
        findCipMaterialMappings(line.orderId, cipToken),
        findCipOrderProcessRequirements(line.orderSn, cipToken),
      ]);
      return {
        ...line,
        materials: attachMaterialChanges(materials, materialMappings),
        materialMappings,
        // Raw text pieces, e.g. ["W600A 600X400X340"] or ["4km: 1250B
        // 1250*650*740", "2km: 1120B II 1120*650*740"] - each matched
        // against the actual drum catalog in routes/cipOrders.js (needs the
        // database, which this file never touches - see matchDrumCatalog
        // there).
        spoolSizeSegments: extractSpoolSizeSegments(processRequirements),
      };
    })
  );
}

// One entry per operation kind that has a CIP counterpart:
//   name: async (payload, cipToken) => details object  (throws ApiError when CIP refuses)
// Filled in as the CIP requests are captured - e.g. "issue" and "receipt".
const HANDLERS = {};

HANDLERS.receipt = async ({ itemNo, itemName, quantity, locationCode }, cipToken) => {
  // `quantity` arrives as the raw string the client sent (e.g. "0.001") -
  // formatQty needs a number, same as HANDLERS.issue already parses its own
  // quantity before formatting it. Missing this parse here crashed every
  // receipt with "n.toFixed is not a function" (caught live 2026-09-25).
  const qty = parseQty(quantity);
  if (!(qty > 0)) throw new ApiError("Nieprawidłowa ilość do przyjęcia.", 400);
  const reply = await cipFetch("/wms/materialTemporaryStorageWarehouse/inStorage", cipToken, {
    itemNo,
    itemName,
    specifications: formatQty(qty),
    locationCode: locationCode ?? "",
    note: "",
    outStorageQuantity: "",
    signType: "add",
  });
  assertTokenAccepted(reply);
  if (!cipAccepted(reply)) throw new ApiError(reply.json?.msg || `CIP odrzuciło przyjęcie (${reply.status}).`, 409);
  return {};
};

HANDLERS.issue = async ({ itemNo, quantity }, cipToken) => {
  const qty = parseQty(quantity);
  if (!(qty > 0)) throw new ApiError("Nieprawidłowa ilość do wydania.", 400);
  const row = await findCipRowToIssue(itemNo, qty, cipToken);

  // `specifications` must equal `outStorageQuantity` here - both carry the
  // amount actually being issued *right now*, not the row's own on-hand
  // total (confirmed live: CIP's own UI sends the two equal for both a full
  // and a partial issue; leaving `specifications` as the row's untouched
  // total - the first, wrong version of this code - made CIP issue the
  // row's *entire* amount regardless of `outStorageQuantity`).
  const reply = await cipFetch("/wms/materialTemporaryStorageWarehouse/outStorage", cipToken, {
    ...row,
    signType: "outStock",
    specifications: formatQty(qty),
    outStorageQuantity: formatQty(qty),
  });
  assertTokenAccepted(reply);
  if (!cipAccepted(reply)) throw new ApiError(reply.json?.msg || `CIP odrzuciło wydanie (${reply.status}).`, 409);
  return { cipRowId: row.id };
};

// Sends one operation to CIP - or, with CIP_SYNC off, does nothing.
//   -> { synced: false, skipped: true }   sync is off
//   -> { synced: true, ...details }       CIP accepted it
// Throws an ApiError when CIP refuses (nothing changed there), when the caller
// has no usable CIP token, or when this operation kind isn't wired up yet.
export async function pushToCip(operation, payload, { cipToken } = {}) {
  if (!cipSyncEnabled()) return { synced: false, skipped: true };

  if (!cipToken) throw new ApiError("Brak sesji CIP - zaloguj się ponownie.", 401);
  if (cipToken === BYPASS_TOKEN) {
    throw new ApiError("Sesja lokalna (SKIP_CIP_AUTH) nie może zapisywać w CIP - wyłącz CIP_SYNC albo zaloguj się prawdziwym kontem.", 401);
  }

  const handler = HANDLERS[operation];
  if (!handler) throw new ApiError(`Operacja "${operation}" nie ma jeszcze obsługi w CIP.`, 501);
  return { synced: true, ...(await handler(payload, cipToken)) };
}
