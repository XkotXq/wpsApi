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
  const res = await fetch(`${process.env.OLD_APP_BASE_URL}${path}`, {
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
  const json = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, json };
}

// Success, as CIP answers it (seen for outStorage): { code: 0, msg: null, data: true }.
// A refusal has the same code: { code: 0, msg: "Temporary Warehouse Outbound
// Specification:45.0Cannot exceed inventory quantity:0.0", data: null } - so
// `code` alone proves nothing; the data flag does.
export function cipAccepted(reply) {
  return reply.ok && reply.json?.code === 0 && reply.json?.data === true;
}

// One entry per operation kind that has a CIP counterpart:
//   name: async (payload, cipToken) => details object  (throws ApiError when CIP refuses)
// Filled in as the CIP requests are captured - e.g. "issue" and "receipt".
const HANDLERS = {};

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
