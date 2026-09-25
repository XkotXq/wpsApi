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
