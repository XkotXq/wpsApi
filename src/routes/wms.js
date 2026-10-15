import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  createWmsIssueNote,
  findWmsItem,
  listWmsDocumentClasses,
  listWmsIssueNotes,
  listWmsOrganizations,
  listWmsPickRules,
  listWmsWarehouses,
  loginToWms,
  mapWithLimit,
  WMS_ISSUE_NOTE_MAX_PAGE_SIZE,
  WMS_LOOKUP_CONCURRENCY,
} from "../wms.js";

const router = Router();

// Same limiter CIP's own login carries (routes/auth.js): this route forwards
// whatever credentials it is given straight to WMS, so nothing else here
// stops repeated attempts. Keyed by IP, which for one warehouse location
// covers real typos comfortably without a per-account counter.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Zbyt wiele prób logowania do WMS. Spróbuj ponownie za kilka minut.", code: "too_many_attempts" },
});

// POST /api/wms/login  { userNo, password }
//
// Unlike /api/auth/login this sits **behind** requireAuth (see app.js): the
// only caller is wps's own server, which already holds the shared API token,
// and a login proxy nobody has to be let into is one fewer open door. If a
// Flutter client ever needs WMS, it holds that token too.
//
// The session comes straight back to the caller and is stored nowhere here -
// wps keeps it in its own httpOnly cookie (lib/wmsSession.js), the same way
// it keeps the CIP one, so a WMS session lives exactly as long as the person
// at the desk is working.
router.post("/login", loginLimiter, async (req, res) => {
  try {
    const session = await loginToWms({
      userNo: req.body?.userNo ?? req.body?.username,
      // `pwd` is WMS's own field name, accepted so a caller can send the
      // shape it saw in WMS's own request.
      password: req.body?.password ?? req.body?.pwd,
    });
    res.json(session);
  } catch (err) {
    res.status(err.code === "wms_unreachable" ? 502 : 401).json({
      error: err.message || "Nie udało się zalogować do WMS.",
      code: err.code || "invalid_credentials",
    });
  }
});

// How many item numbers one call may resolve. An issue list is pasted in
// whole, so this is a list length and not a page size; past it the caller
// gets a 400 rather than a request that quietly loses the tail.
const MAX_ITEM_KEYWORDS = 200;


// The session travels in headers, not the body: it is credentials, so it
// belongs where the rest of this repo's per-user tokens go (`X-Cip-Token`
// on the CIP routes) rather than mixed in with the query it authorises.
function sessionFromHeaders(req) {
  const cookie = req.get("x-wms-cookie") || null;
  const token = req.get("x-wms-auth") || null;
  return cookie || token ? { cookie, token } : null;
}

// POST /api/wms/items  { orgNo, keywords: ["995402000010002", ...] }
//
// Resolves item numbers against WMS's own item master, for wps's issue-list
// grid: paste a column of item numbers and every row gets its name, unit
// and specification without anybody retyping them.
//
// The answer is keyed by **the keyword that was asked**, not by the item
// number WMS came back with, so a caller can match a reply to the grid row
// it belongs to even when nothing matched at all.
router.post("/items", async (req, res) => {
  const session = sessionFromHeaders(req);
  if (!session) return res.status(401).json({ error: "Brak sesji WMS.", code: "wms_not_signed_in" });

  const orgNo = String(req.body?.orgNo ?? "").trim();
  if (!orgNo) return res.status(400).json({ error: 'Wymagane pole "orgNo".' });

  const keywords = [
    ...new Set(
      (Array.isArray(req.body?.keywords) ? req.body.keywords : [req.body?.keyword])
        .map((keyword) => String(keyword ?? "").trim())
        .filter(Boolean)
    ),
  ];
  if (keywords.length === 0) return res.status(400).json({ error: 'Wymagane pole "keywords".' });
  if (keywords.length > MAX_ITEM_KEYWORDS) {
    return res.status(400).json({ error: `Za dużo pozycji w jednym zapytaniu (maks. ${MAX_ITEM_KEYWORDS}).` });
  }

  try {
    const found = await mapWithLimit(keywords, WMS_LOOKUP_CONCURRENCY, (keyword) =>
      findWmsItem({ session, orgNo, keyword })
    );
    // **Without the row it came from.** The lookup keeps WMS's own item
    // record because the save sends it back whole, but a screen has no use
    // for it: it would be some two kilobytes a position of somebody else's
    // schema, in the browser, going stale. The save looks the items up
    // again itself.
    res.json({
      items: Object.fromEntries(
        keywords.map((keyword, index) => {
          const { item, matched, count } = found[index];
          return [keyword, { item, matched, count }];
        })
      ),
    });
  } catch (err) {
    // A dead session is its own answer, not "item not found": wps shows the
    // sign-in again for it instead of marking every row unknown.
    const expired = err.code === "wms_session_expired";
    res.status(expired ? 401 : err.code === "wms_unreachable" ? 502 : 500).json({
      error: err.message || "Nie udało się pobrać materiałów z WMS.",
      code: err.code || "wms_error",
    });
  }
});

// POST /api/wms/organizations    {}
// POST /api/wms/warehouses       { orgNo }
// POST /api/wms/document-classes { orgNo }
// POST /api/wms/pick-rules       { orgNo }
//
// The options behind wps's issue-note header selects. A code typed by hand
// is one WMS either knows or rejects at save time, so these are the lists.
// All but the first are **scoped to the organization**, because another
// org's warehouse or document class is one nobody here can put on a
// document - and the first is the list of organizations itself, which is
// why `requiresOrg` exists rather than this route demanding one from every
// list and the organizations being handed a value they would ignore.
//
// Each answers `{ options: [{ code, name }] }`: the same two things a select
// needs, so the screen does not have to know which WMS table they came out
// of, and a fifth list later is a route and a loader, not a new shape.
function referenceRoute(load, failureMessage, { requiresOrg = true } = {}) {
  return async (req, res) => {
    const session = sessionFromHeaders(req);
    if (!session) return res.status(401).json({ error: "Brak sesji WMS.", code: "wms_not_signed_in" });

    const orgNo = String(req.body?.orgNo ?? "").trim();
    if (requiresOrg && !orgNo) return res.status(400).json({ error: 'Wymagane pole "orgNo".' });

    try {
      const options = await load({ session, orgNo });
      // The code and the label, and not the WMS row behind them - the
      // labels a document carries are resolved where the document is built.
      res.json({ options: options.map(({ code, name }) => ({ code, name })) });
    } catch (err) {
      // A dead session is its own answer here too, and more sharply than on
      // the items: unhandled it reads as an organization with no warehouses.
      const expired = err.code === "wms_session_expired";
      res.status(expired ? 401 : err.code === "wms_unreachable" ? 502 : 500).json({
        error: err.message || failureMessage,
        code: err.code || "wms_error",
      });
    }
  };
}

router.post(
  "/organizations",
  referenceRoute(listWmsOrganizations, "Nie udało się pobrać organizacji z WMS.", { requiresOrg: false })
);
router.post("/warehouses", referenceRoute(listWmsWarehouses, "Nie udało się pobrać magazynów z WMS."));
router.post(
  "/document-classes",
  referenceRoute(listWmsDocumentClasses, "Nie udało się pobrać klas dokumentu z WMS.")
);
router.post("/pick-rules", referenceRoute(listWmsPickRules, "Nie udało się pobrać reguł pobrania z WMS."));

// POST /api/wms/issue-notes  { head: {...}, positions: [{ itemNo, quantity, location }] }
//
// Creates the issue note in WMS. **This is the one route here that changes
// anything** - everything above reads - so what it refuses matters as much
// as what it sends:
//   - a header without the five fields the captured document cannot be
//     without is a 400, not a document WMS silently rejects;
//   - a position whose item number is not an exact match in WMS's own item
//     master stops the whole list (`wms_unknown_items`), because a mis-
//     picked material on an issue note leaves the warehouse;
//   - a reply whose code is not WMS's own success code is a refusal
//     carrying **WMS's own message**, never a success. A list reported as
//     saved when it was not is the one outcome nobody can recover from.
const REQUIRED_HEAD = ["organization", "billDate", "documentClass", "sourceWarehouse", "destinationWarehouse"];

router.post("/issue-notes", async (req, res) => {
  const session = sessionFromHeaders(req);
  if (!session) return res.status(401).json({ error: "Brak sesji WMS.", code: "wms_not_signed_in" });

  const head = req.body?.head ?? {};
  const missing = REQUIRED_HEAD.filter((field) => !String(head[field] ?? "").trim());
  if (missing.length) {
    return res.status(400).json({ error: `Brak wymaganych pól: ${missing.join(", ")}.`, code: "wms_missing_head" });
  }

  const positions = (Array.isArray(req.body?.positions) ? req.body.positions : [])
    .map((position) => ({ ...position, itemNo: String(position?.itemNo ?? "").trim() }))
    .filter((position) => position.itemNo);
  if (positions.length === 0) {
    return res.status(400).json({ error: "Lista bez pozycji.", code: "wms_no_positions" });
  }
  if (positions.length > MAX_ITEM_KEYWORDS) {
    return res.status(400).json({ error: `Za dużo pozycji (maks. ${MAX_ITEM_KEYWORDS}).` });
  }
  const withoutQuantity = positions.filter((position) => !String(position.quantity ?? "").trim());
  if (withoutQuantity.length) {
    return res.status(400).json({
      error: `Pozycje bez ilości: ${withoutQuantity.map((position) => position.itemNo).join(", ")}.`,
      code: "wms_missing_quantity",
    });
  }

  try {
    res.json(await createWmsIssueNote({ session, head, positions }));
  } catch (err) {
    const expired = err.code === "wms_session_expired";
    const refused = err.code === "wms_unknown_items" || err.code === "wms_rejected" ||
      err.code === "wms_unknown_document_class" || err.code === "wms_unknown_pick_rule";
    res.status(expired ? 401 : refused ? 422 : err.code === "wms_unreachable" ? 502 : 500).json({
      error: err.message || "Nie udało się utworzyć listy w WMS.",
      code: err.code || "wms_error",
    });
  }
});

// POST /api/wms/issue-notes/search  { orgNo?, page?, size? }
//
// The issue notes WMS already holds, newest first - what wps's own table
// shows. **Its own path rather than a GET on /issue-notes**: every call in
// this file is a POST carrying the session in headers and a body WMS
// dictates, and a GET would have to put the paging in a query string for
// no gain. The suffix keeps the create route unambiguous.
//
// Read-only, so it refuses almost nothing: a blank `orgNo` is every
// organization, exactly as WMS's own screen asks. A document somebody is
// looking for is still one they are looking for when it was raised
// elsewhere - the opposite of the create route, which demands the
// organization because it decides what the document *is*.
router.post("/issue-notes/search", async (req, res) => {
  const session = sessionFromHeaders(req);
  if (!session) return res.status(401).json({ error: "Brak sesji WMS.", code: "wms_not_signed_in" });

  const page = Math.max(1, Number(req.body?.page) || 1);
  // Clamped rather than refused: a page size is a screen's own business
  // and a silly one is not worth an error, but somebody else's server is
  // not asked for ten thousand rows either.
  // not asked for ten thousand rows either. No size at all leaves the
  // default where it belongs, in src/wms.js.
  const requested = Number(req.body?.size);
  const size =
    Number.isFinite(requested) && requested > 0
      ? Math.min(Math.trunc(requested), WMS_ISSUE_NOTE_MAX_PAGE_SIZE)
      : undefined;

  try {
    const notes = await listWmsIssueNotes({ session, orgNo: req.body?.orgNo ?? "", page, size });
    res.json({ notes });
  } catch (err) {
    const expired = err.code === "wms_session_expired";
    res.status(expired ? 401 : err.code === "wms_unreachable" ? 502 : 500).json({
      error: err.message || "Nie udało się pobrać list z WMS.",
      code: err.code || "wms_error",
    });
  }
});

export default router;
