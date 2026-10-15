import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

// Link between this API and **WMS** - the plant's own warehouse system
// (https://wms.yofc.com:8181), which is *not* CIP: a different server, a
// different login and a different session. wps's "Wydania WMS" screen needs
// one because an issue list has to exist in WMS itself, and the person at
// the desk is already logged into wps with their CIP account - the two
// systems do not share accounts, so WMS asks for its own.
//
// Proxied server-to-server for the same reason CIP's login is
// (routes/auth.js): WMS sets no CORS headers, so the browser cannot call it,
// and this keeps the credentials out of the page's own JS either way.
//
// Captured from WMS's own login page (login.html) on 2026-10-13:
//   POST /ilcwmsbase/userlogin/authlogin
//   { "userNo": "...", "pwd": "...", "invokerParam": 1 }
// with `x-requested-with: XMLHttpRequest`, which that framework uses to tell
// an API call from a form post.
const WMS_BASE_URL = process.env.WMS_BASE_URL || "https://wms.yofc.com:8181";
const WMS_LOGIN_PATH = "/ilcwmsbase/userlogin/authlogin";
const WMS_TIMEOUT_MS = 15000;

// An internal server on a port of its own often carries a certificate no
// public CA signed - but this one does not: checked live on 2026-10-13, port
// 8181 serves a GlobalSign-issued `*.yofc.com` certificate that validates
// normally (it expires 2026-11-23, so a connection that suddenly stops
// validating is worth checking against that date before anybody reaches for
// this switch). Left here for a renewal that lands on an internal CA
// instead, and off by default: a login is credentials, so trusting any
// certificate is a decision somebody makes knowingly, in .env.
const WMS_TLS_INSECURE = process.env.WMS_TLS_INSECURE === "true";

// Same shape routes/auth.js uses for CIP: a stable `code` the clients can
// translate, a Polish fallback message, and whatever WMS actually said kept
// to the server log.
//   invalid_credentials   WMS refused the login
//   wms_unreachable       WMS could not be reached
function wmsError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * POST a JSON body to a WMS path as an already-logged-in session.
 *
 * `cookie` and `auth` are the two halves of what `loginToWms` hands back,
 * and WMS's own pages send **both**: the `WMS_AUTH` cookie (their requests
 * are `credentials: "include"`) and the same session id again in an
 * `authentication-info` header. `appModule` is WMS's `app-module-number` -
 * which of its screens is asking, e.g. "100400010001" for the out-notice
 * (issue) screen; it is per call because it is per screen.
 *
 * Node's http/https rather than fetch for two reasons: WMS_TLS_INSECURE can
 * be honoured per request (undici needs a dispatcher for that), and
 * `set-cookie` is readable without fighting undici's header API. The
 * relaxed HTTP parser matches CIP's own calls and costs nothing.
 */
export function wmsPost(path, body, { cookie, auth, appModule } = {}) {
  const target = new URL(`${WMS_BASE_URL}${path}`);
  const isHttps = target.protocol === "https:";
  const payload = JSON.stringify(body ?? {});

  return new Promise((resolve, reject) => {
    const req = (isHttps ? https : http).request(
      {
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: "POST",
        insecureHTTPParser: true,
        ...(isHttps && WMS_TLS_INSECURE && { rejectUnauthorized: false }),
        headers: {
          accept: "application/json, text/javascript, */*; q=0.01",
          "accept-language": "en-US",
          "content-type": "application/json; charset=UTF-8",
          "content-length": Buffer.byteLength(payload),
          // WMS's own page sends this on every API call; without it that
          // framework can answer with the login HTML instead of JSON.
          "x-requested-with": "XMLHttpRequest",
          ...(cookie && { cookie }),
          ...(auth && { "authentication-info": auth }),
          ...(appModule && { "app-module-number": appModule }),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let data = null;
          try {
            data = JSON.parse(raw);
          } catch {
            data = null;
          }
          resolve({
            status: res.statusCode ?? 0,
            data,
            setCookie: res.headers["set-cookie"] ?? [],
          });
        });
      }
    );
    req.setTimeout(WMS_TIMEOUT_MS, () => req.destroy(wmsError("wms_unreachable", "WMS nie odpowiedziało w czasie.")));
    req.on("error", (err) =>
      reject(err?.code === "wms_unreachable" ? err : wmsError("wms_unreachable", "Nie udało się połączyć z WMS."))
    );
    req.write(payload);
    req.end();
  });
}

// What identifies the session afterwards. **WMS's is a cookie**, `WMS_AUTH` -
// captured live on 2026-10-13. A token in the body is looked for as well
// because the login's own request sends `credentials: "omit"`, i.e. WMS's own
// page cannot be keeping that cookie either, so a successful reply may well
// carry the same thing in its payload. Either will do and nothing here cares
// which: whatever comes back is what gets sent back.
const TOKEN_FIELDS = ["token", "accessToken", "access_token", "sessionId", "sid", "ticket", "authToken"];

function pick(source, fields) {
  if (!source || typeof source !== "object") return null;
  for (const field of fields) {
    const value = source[field];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

// The reply's own payload may be the body or sit under `data` - both shapes
// are common in this family of frameworks, so look in both.
export function sessionToken(data) {
  return pick(data, TOKEN_FIELDS) ?? pick(data?.data, TOKEN_FIELDS);
}

// Only the name/value part of each cookie, joined into one `cookie` header:
// a Set-Cookie carries Path/Secure/HttpOnly attributes that must not be sent
// back, and a session can be split across more than one cookie.
//
// **A cookie with no value is not a session.** Clearing `WMS_AUTH` is exactly
// how a refused login arrives (`WMS_AUTH=; Path=/; Secure; HttpOnly;
// SameSite=Lax`), so dropping the empty ones is also what makes
// `wmsAccepted` below work.
export function sessionCookie(setCookie) {
  const pairs = (setCookie ?? [])
    .map((line) => String(line).split(";")[0].trim())
    .filter((pair) => {
      const eq = pair.indexOf("=");
      return eq > 0 && pair.slice(eq + 1).trim().length > 0;
    });
  return pairs.length ? pairs.join("; ") : null;
}

/**
 * Whether a login reply carries a session, and which kind - the whole of
 * the accept rule (see loginToWms's own doc comment for why it is this and
 * not the status code or the `code` field). Exported so
 * scripts/check-wms-login.mjs can pin it against the real captured replies
 * rather than against a live WMS and somebody's password.
 */
export function wmsSessionFrom(reply) {
  const cookie = sessionCookie(reply?.setCookie);
  const token = sessionToken(reply?.data);
  const status = reply?.status ?? 0;
  const accepted = status >= 200 && status < 300 && Boolean(cookie || token);
  return { accepted, cookie, token };
}

export function refusalReason(data) {
  if (!data) return "reply was not JSON (WMS's own login page?)";
  const msg = data.msg || data.message || data.resultMsg;
  const code = data.code ?? data.resultCode;
  return [msg, code && `code ${code}`].filter(Boolean).join(" / ") || Object.keys(data).join(",");
}

/**
 * Log in to WMS with one person's own WMS credentials.
 *
 * Returns `{ token, cookie, userNo, name }` - `token`/`cookie` being
 * whatever WMS recognises the session by afterwards (either may be null,
 * never both). Nothing is stored here: the session belongs to the caller,
 * which keeps it for as long as the person is working.
 *
 * **Whether WMS accepted is not in its status code and not in a flag.** It
 * answers HTTP 200 either way, and words a refusal as
 * `{"msg":"Login failed, please re-enter user and password!","code":"sys0049"}`
 * - captured live on 2026-10-13 with an account that does not exist. So what
 * this turns on is the session itself: accepted means WMS handed over
 * something to be recognised by, which is the one signal a refusal cannot
 * produce. Reading `code` instead would mean guessing which of sys0049's
 * siblings means yes, and guessing it wrong would tell somebody whose
 * password was right that it was not.
 */
export async function loginToWms({ userNo, password }) {
  const user = String(userNo ?? "").trim();
  if (!user || !password) throw wmsError("invalid_credentials", "Podaj login i hasło do WMS.");

  const reply = await wmsPost(WMS_LOGIN_PATH, { userNo: user, pwd: password, invokerParam: 1 });

  const { accepted, cookie, token } = wmsSessionFrom(reply);

  if (!accepted) {
    // Never the body itself and never what was sent: a refusal can echo the
    // account back, and this log is read by whoever can read the server.
    console.warn(`[wms] login refused (HTTP ${reply.status}):`, refusalReason(reply.data));
    throw wmsError("invalid_credentials", "Nieprawidłowy login lub hasło do WMS.");
  }

  const payload = reply.data?.data && typeof reply.data.data === "object" ? reply.data.data : reply.data;

  // Field **names** only, so the first real login can be read off the log
  // without a single value of it being logged - which is how a token field
  // WMS turns out to use gets added to TOKEN_FIELDS above.
  console.log(
    "[wms] login accepted;",
    cookie ? "session in a cookie;" : "session in the body;",
    "reply fields:",
    Object.keys(reply.data ?? {}).join(",") || "(none)"
  );

  return {
    token,
    cookie,
    userNo: pick(payload, ["userNo", "userno", "userId", "employeeNo", "empNo", "account"]) ?? user,
    name: pick(payload, ["userName", "username", "userNameCn", "name", "realName", "fullName", "empName"]) ?? user,
  };
}

// ── Item lookup ──────────────────────────────────────────────────────────
// WMS's own "add an issue note" screen (component/om/outnotice/addoutnotice)
// resolves a typed or pasted item number through this, and so does wps's
// own issue-list grid: an item number goes in, the material's name and the
// rest of its master data comes back. Captured from that screen on
// 2026-10-14.
const WMS_ITEM_SEARCH_PATH = "/ilcwmsbase/bmitem/getbmitemlistbyparams";

// WMS's `app-module-number` for the out-notice (issue) screen - the module
// whose requests these are. Not a guess: it is what that screen sends.
export const WMS_MODULE_ISSUE = "100400010001";

// WMS's own page asks for 20 at a time. A lookup here wants the one item
// whose number was typed, so the page size only has to be big enough that
// an exact match is somewhere in it.
const WMS_ITEM_PAGE_SIZE = 20;

/**
 * The value WMS's pages send as `authentication-info`.
 *
 * Their own requests carry the session **twice** - as the `WMS_AUTH` cookie
 * and as this header - and the captured header value has exactly the shape
 * of a session id (a UUID). So this is the session's own id: the body token
 * when the login gave one, otherwise the value out of the cookie.
 * **Inferred, not captured from a login** (the login reply we have is a
 * refusal, which carries no id at all), so if a real session turns out to
 * use something else, this one function is where it changes.
 */
export function authInfoFor(session) {
  if (session?.token) return session.token;
  const match = /(?:^|;\s*)WMS_AUTH=([^;]+)/.exec(session?.cookie ?? "");
  return match ? match[1].trim() : null;
}

/**
 * Whether WMS is saying "whoever is asking is not logged in".
 *
 * **This is not an HTTP status and not an empty result**, and getting it
 * wrong is the expensive mistake here: captured live on 2026-10-14 with an
 * all-zeros session id, an item lookup on a dead session answers
 * **HTTP 200** with `{"code":"000701","msg":"User not logged in"}` - which
 * reads as "that item does not exist" to anything that only counts rows. A
 * whole pasted list would then come back marked as unknown materials and
 * the real cause - sign in again - would be nowhere on screen.
 *
 * The code is the signal; the message is checked too, in case the same
 * condition ever arrives under a sibling code. A reply that is not JSON at
 * all is the framework's own login page, which means the same thing.
 */
const WMS_NOT_LOGGED_IN_CODE = "000701";

export function wmsNotLoggedIn({ data } = {}) {
  if (data === null || data === undefined) return true;
  if (String(data.code ?? "") === WMS_NOT_LOGGED_IN_CODE) return true;
  return /not\s+logged\s+in/i.test(String(data.msg ?? data.message ?? ""));
}

// Where the rows are. The envelope is `{ code, msg, ... }` - the same one
// the login refusal uses - but which key a page of results sits under has
// not been seen yet (the probe that would have shown it needed a live
// session, and a session is somebody's password), so every container this
// family of frameworks uses is accepted rather than one being assumed.
const ROW_CONTAINERS = ["records", "list", "rows", "data", "result", "items"];

export function wmsRowsFrom(data) {
  if (Array.isArray(data)) return data;
  for (const source of [data?.data, data]) {
    if (Array.isArray(source)) return source;
    if (!source || typeof source !== "object") continue;
    for (const key of ROW_CONTAINERS) {
      if (Array.isArray(source[key])) return source[key];
    }
  }
  return [];
}

// Which field holds what. Each list is tried in order and the first
// non-blank one wins, so an unexpected spelling costs a blank cell rather
// than the whole lookup - and the names a real reply actually used are
// logged (names only), which is how the right one gets to the front.
const ITEM_FIELDS = {
  itemNo: ["itemNo", "itemCode", "materialNo", "materialCode", "goodsNo", "no"],
  itemName: ["itemName", "itemNameEn", "itemDesc", "materialName", "goodsName", "name", "itemNameCn"],
  unit: ["unitNo", "unit", "unitName", "measureUnit", "baseUnit", "unitCode"],
  spec: ["spec", "specification", "specifications", "model", "itemSpec"],
  category: ["itemClass", "itemClassName", "category", "categoryName", "itemType", "typeName"],
};

function firstFilled(row, fields) {
  for (const field of fields) {
    const value = row?.[field];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

/**
 * One WMS item row, cut down to what a list position needs. The raw row is
 * **not** passed on: a screen that renders whatever WMS happens to send
 * would break the moment WMS adds a field, and the fields actually wanted
 * here are the ones above.
 */
export function normaliseWmsItem(row) {
  return {
    itemNo: firstFilled(row, ITEM_FIELDS.itemNo),
    itemName: firstFilled(row, ITEM_FIELDS.itemName),
    unit: firstFilled(row, ITEM_FIELDS.unit),
    spec: firstFilled(row, ITEM_FIELDS.spec),
    category: firstFilled(row, ITEM_FIELDS.category),
  };
}

/**
 * Of the rows WMS answered a keyword with, the one that keyword meant.
 *
 * WMS searches, so "99540200001" comes back with everything starting that
 * way and the first row is not necessarily the item somebody typed. An
 * **exact** item-number match therefore wins outright; only when there is
 * none is the first row taken, and then only if the search was unambiguous
 * (a single row). Anything else comes back as "nothing matched" with the
 * count, rather than quietly filling a position with the wrong material -
 * on an issue note that is the kind of mistake that leaves the warehouse.
 */
export function matchWmsItem(rows, keyword) {
  const wanted = String(keyword ?? "").trim().toLowerCase();
  // The normalised item **and the row it came from**: an issue note's
  // `detailList` is WMS's own item row sent straight back (see
  // `wmsIssueDetailRow`), so the row cannot be thrown away here. It is
  // kept out of what the screen is sent - see the /items route.
  const found = (rows ?? [])
    .map((row) => ({ item: normaliseWmsItem(row), raw: row }))
    .filter(({ item }) => item.itemNo || item.itemName);
  const exact = found.find(({ item }) => String(item.itemNo ?? "").trim().toLowerCase() === wanted);
  if (exact) return { ...exact, matched: "exact", count: found.length };
  if (found.length === 1) return { ...found[0], matched: "only", count: 1 };
  return { item: null, raw: null, matched: found.length ? "ambiguous" : "none", count: found.length };
}

let loggedItemFields = false;

/**
 * Look one item up in WMS, as the signed-in person.
 *
 * Returns `{ item, matched, count }` - see `matchWmsItem`. A reply that is
 * not JSON means WMS answered with its own login page, i.e. the session is
 * gone: that comes back as `wms_session_expired` so the caller can ask for
 * a fresh sign-in instead of reporting a missing item.
 */
export async function findWmsItem({ session, orgNo, keyword }) {
  const reply = await wmsPost(
    WMS_ITEM_SEARCH_PATH,
    {
      condition: {
        orgNo: String(orgNo ?? "").trim(),
        keyword: String(keyword ?? "").trim(),
        // WMS's own screen sends 1 here - only items in use, so a
        // discontinued material cannot be put on a new issue note.
        statusCode: 1,
        field: "itemNo",
        order: "asc",
      },
      current: 1,
      size: WMS_ITEM_PAGE_SIZE,
    },
    { cookie: session?.cookie, auth: authInfoFor(session), appModule: WMS_MODULE_ISSUE }
  );

  // Checked before the rows are counted, never after: "not logged in" comes
  // back as a perfectly ordinary 200 with no rows (see wmsNotLoggedIn).
  if (wmsNotLoggedIn(reply)) {
    console.warn(`[wms] item lookup refused (HTTP ${reply.status}):`, refusalReason(reply.data));
    throw wmsError("wms_session_expired", "Sesja WMS wygasła - zaloguj się do WMS ponownie.");
  }

  const rows = wmsRowsFrom(reply.data);

  // Once per server run, and **field names only** - the same rule the login
  // follows. This is what turns ITEM_FIELDS' guesses into the real
  // spellings without anybody's data being written to a log.
  if (!loggedItemFields) {
    loggedItemFields = true;
    console.log(
      "[wms] item lookup reply fields:",
      Object.keys(reply.data ?? {}).join(",") || "(none)",
      "| row fields:",
      rows[0] && typeof rows[0] === "object" ? Object.keys(rows[0]).join(",") : "(no rows)"
    );
  }

  return matchWmsItem(rows, keyword);
}

// --- The header's own lists ---------------------------------------------
// Most of the issue-note header is not free text in WMS: it keeps a list per
// field and its own screen fills a select from each. All captured from
// `addoutnotice`, the first three on 2026-10-14 and the organizations on
// 2026-10-15:
//
//   organizations    POST /ilcwmsbase/bmorg/getbmorglistbyparams
//                    { size: 1000, condition: { statusCode: "1", keyword: "" }, current: 1 }
//   warehouses       POST /ilcwmsbase/bmwarehouse/getbmwarehouselistbyparams
//                    { size: 1000, condition: { statusCode: "1", orgNo, keyword: "" }, current: 1 }
//   document classes POST /ilcwmsbase/bmclassifytype/getBusinessClassifyTypeListByParams
//                    { size: 1000, condition: { statusCode: "1", bigModule: "0", orgNo, keyword: "" }, current: 1 }
//   picking rules    POST /ilcwmsbase/tooracle/getpickrule
//                    { condition: { organizationCode, dateFrom: "", dateTo: "", ruleName: "" } }
//
// **The organizations are the one list that is not scoped by an
// organization** - it is the list of them - so its captured body carries no
// `orgNo` at all. Everything downstream of this file has to know that: the
// route cannot demand an `orgNo` for it and the screen must not clear it
// when the organization changes.
//
// **Each list brings its own body**, which is why the helper below takes one
// rather than assembling a single shape: the picking rules are not paged at
// all and name the organization `organizationCode`, where the other two page
// and call it `orgNo`. `statusCode` is likewise the **string** "1" where the
// item search sends the number 1. Each of those is what that screen sends,
// and handing WMS back exactly its own request is cheaper than finding out
// which spelling it is strict about. `bigModule: "0"` is WMS's own too - the
// classify types belong to several modules and "0" is the set this screen
// offers.
const WMS_ORG_PATH = "/ilcwmsbase/bmorg/getbmorglistbyparams";
const WMS_WAREHOUSE_PATH = "/ilcwmsbase/bmwarehouse/getbmwarehouselistbyparams";
const WMS_CLASSIFY_TYPE_PATH = "/ilcwmsbase/bmclassifytype/getBusinessClassifyTypeListByParams";
const WMS_PICK_RULE_PATH = "/ilcwmsbase/tooracle/getpickrule";

// WMS's own screen asks for 1000, i.e. "all of them": a plant has tens of
// warehouses and a handful of document classes, so each list is one call and
// then a select somebody can read, rather than a search box over something
// that fits on screen.
const WMS_LIST_PAGE_SIZE = 1000;

// Which field holds the code and which the label, per list. Same rule as
// ITEM_FIELDS: tried in order, first non-blank wins, and the real spellings
// come from the field-name log line below.
// Guessed, like the two below it and unlike PICK_RULE_FIELDS: no reply of
// this one has been captured. `orgNo` leads because that is what every
// other request in this file calls an organization, and it is the value a
// document carries.
export const ORG_FIELDS = {
  code: ["orgNo", "organizationCode", "orgCode", "organizationNo", "code", "no"],
  name: ["orgName", "organizationName", "orgNameEn", "orgShortName", "name", "orgNameCn"],
};

export const WAREHOUSE_FIELDS = {
  code: ["warehouseNo", "whNo", "warehouseCode", "whCode", "storeNo", "code", "no"],
  name: ["warehouseName", "whName", "warehouseNameEn", "storeName", "name", "warehouseNameCn"],
};

export const CLASSIFY_TYPE_FIELDS = {
  code: ["classifyType", "classifyTypeNo", "businessClassifyTypeNo", "typeNo", "classifyNo", "classifyTypeCode", "code", "no"],
  name: ["classifyTypeName", "businessClassifyTypeName", "typeName", "classifyName", "name", "classifyTypeNameCn"],
};

// **Captured, not guessed** (2026-10-14): this is the one list of the three
// whose reply we have actually seen, because `getpickrule` turns out not to
// need a session at all - it answers the same list to an expired one. One
// row of org 460, verbatim but for the timestamp:
//   { pickRuleName: "YOFC POL pick", organizationCode: "460",
//     autoShipConfirmFlag: "N", pickRuleId: "510", lastUpdateDate: ... }
// under `data.records`, in an envelope whose success code is `"000001"`
// with `msg: "成功"` - more proof that no `code` value may be read as
// success or failure here (see `wmsSessionFrom`).
//
// `codeFromName` stays as the fallback it was: the id is what a document
// should carry, but a rule WMS one day sends without one is still a rule
// somebody has to be able to pick, and an empty select leaves the field
// unfillable.
export const PICK_RULE_FIELDS = {
  code: ["pickRuleId", "ruleNo", "ruleCode", "pickRuleNo", "pickRuleCode", "code", "id", "no"],
  name: ["pickRuleName", "ruleName", "pickingRuleName", "name", "ruleNameCn"],
  codeFromName: true,
};

/**
 * One list's rows as `[{ code, name }]`, in WMS's own order.
 *
 * A row with **no code is dropped**: an option whose value cannot be
 * submitted is worse than a shorter list. A row with no name is kept - it is
 * still pickable by its code. Codes repeat across pages of some of these
 * lists, so the first of a code wins.
 *
 * `fields.codeFromName` lets a list whose rows may carry no code at all fall
 * back to the name as the value - see `PICK_RULE_FIELDS`.
 */
export function referenceOptions(rows, fields) {
  const seen = new Set();
  const options = [];
  for (const row of rows ?? []) {
    const name = firstFilled(row, fields.name);
    const code = firstFilled(row, fields.code) ?? (fields.codeFromName ? name : null);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    // `raw` for the same reason `matchWmsItem` keeps one: the save sends
    // fields that only the original row has (a picking rule's
    // `autoShipConfirmFlag`). The routes strip it before answering.
    options.push({ code, name, raw: row });
  }
  return options;
}

const loggedListFields = new Set();

/**
 * One of WMS's own lists, as the signed-in person.
 *
 * `orgNo` is not optional and not defaulted anywhere up the chain: a list
 * belonging to another organization is a list of things nobody here can put
 * on a document, and WMS's own screen always sends the organization it is
 * filling in.
 */
async function listWmsReference({ session, path, body, fields, label }) {
  const reply = await wmsPost(path, body, {
    cookie: session?.cookie,
    auth: authInfoFor(session),
    appModule: WMS_MODULE_ISSUE,
  });

  // Before the rows, never after - and the reason bites harder here than on
  // the items (see wmsNotLoggedIn): a dead session is an ordinary 200 with
  // none, which reads as "this organization has no warehouses" and leaves an
  // empty select with nothing on screen to act on.
  if (wmsNotLoggedIn(reply)) {
    console.warn(`[wms] ${label} list refused (HTTP ${reply.status}):`, refusalReason(reply.data));
    throw wmsError("wms_session_expired", "Sesja WMS wygasła - zaloguj się do WMS ponownie.");
  }

  const rows = wmsRowsFrom(reply.data);

  // Once per list per server run, and field **names** only - the same rule
  // the login and the item lookup follow.
  if (!loggedListFields.has(label)) {
    loggedListFields.add(label);
    console.log(
      `[wms] ${label} list reply fields:`,
      Object.keys(reply.data ?? {}).join(",") || "(none)",
      "| row fields:",
      rows[0] && typeof rows[0] === "object" ? Object.keys(rows[0]).join(",") : "(no rows)"
    );
  }

  return referenceOptions(rows, fields);
}

// The paged body the three master-data lists share. It takes the **whole**
// condition rather than an organization and some extras, because one of the
// three has no organization in it: a body that always wrote an `orgNo` would
// have to be told to leave it out, and sending WMS a key its own screen does
// not is exactly the kind of difference this file avoids.
function pagedBody(condition) {
  return {
    size: WMS_LIST_PAGE_SIZE,
    condition: { statusCode: "1", ...condition, keyword: "" },
    current: 1,
  };
}

/**
 * Every organization WMS knows, as `[{ code, name }]`.
 *
 * **The one list here that takes no organization**, for the reason the
 * section comment gives: this is the list of them. It therefore needs no
 * refetch when the document's own organization changes, and a caller with
 * no organization yet can still fill it - which is the point, since this is
 * the field that supplies one.
 */
export function listWmsOrganizations({ session }) {
  return listWmsReference({
    session,
    path: WMS_ORG_PATH,
    body: pagedBody({}),
    fields: ORG_FIELDS,
    label: "organization",
  });
}

/** Every warehouse of one organization, as `[{ code, name }]`. */
export function listWmsWarehouses({ session, orgNo }) {
  return listWmsReference({
    session,
    path: WMS_WAREHOUSE_PATH,
    body: pagedBody({ orgNo: String(orgNo ?? "").trim() }),
    fields: WAREHOUSE_FIELDS,
    label: "warehouse",
  });
}

/** Every document class of one organization, as `[{ code, name }]`. */
export function listWmsDocumentClasses({ session, orgNo }) {
  return listWmsReference({
    session,
    path: WMS_CLASSIFY_TYPE_PATH,
    body: pagedBody({ orgNo: String(orgNo ?? "").trim(), bigModule: "0" }),
    fields: CLASSIFY_TYPE_FIELDS,
    label: "document class",
  });
}

/**
 * Every picking rule of one organization, as `[{ code, name }]`.
 *
 * Its own body: no paging, `organizationCode` rather than `orgNo`, and the
 * two blank dates WMS's screen sends - a rule list is dated, and sending
 * nothing is how that screen asks for all of them.
 *
 * **This endpoint does not check the session** (found 2026-10-14: an
 * all-zeros one gets the same list), so `wmsNotLoggedIn` will never fire
 * for it and a dead session reads as a healthy list here. That is harmless
 * only because the answer is the same either way - do not take it as
 * licence to drop the check anywhere else.
 */
export function listWmsPickRules({ session, orgNo }) {
  return listWmsReference({
    session,
    path: WMS_PICK_RULE_PATH,
    body: {
      condition: {
        organizationCode: String(orgNo ?? "").trim(),
        dateFrom: "",
        dateTo: "",
        ruleName: "",
      },
    },
    fields: PICK_RULE_FIELDS,
    label: "picking rule",
  });
}

// WMS has no batch anything, so a list of 30 items is 30 calls. Four in
// flight keeps that quick without opening thirty connections to somebody
// else's server - the same figure the CIP order searches use.
export const WMS_LOOKUP_CONCURRENCY = 4;

export async function mapWithLimit(values, limit, worker) {
  const results = new Array(values.length);
  let next = 0;
  async function run() {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, run));
  return results;
}

// --- Creating the issue note --------------------------------------------
// The request WMS's own `addoutnotice` screen sends when the list is
// saved, captured 2026-10-14. Note the **different application**:
// `/ilcwmswms/...`, where every read above is `/ilcwmsbase/...`.
//
// Two things in that capture decide the shape of everything below.
//
// **1. A `detailList` row is WMS's own item row, sent back.** Not a
// position built out of five fields - the whole `bmitem` record, every
// `guestCol`, `lotRuleNo`, `shelflife` and `itemPrice` of it, plus
// `applyQty`, `cellNo`, the twelve blank `lotAtt` and `itemFlag`. So the
// items are **looked up again here at save time** and the rows WMS
// answers with are what goes back: the browser never holds them, and
// what is sent cannot have drifted from what WMS currently has.
//
// **2. The header sends codes *and* their labels**, and not in the
// obvious direction - `pickRule` is the rule's **name** while
// `pickRuleName` is `"510-YOFC POL pick"`, its id and name joined. The
// screen therefore sends the code it picked and the labels are resolved
// here against WMS's own lists, never assembled in the browser.
const WMS_ADD_OUT_NOTICE_PATH = "/ilcwmswms/outnoticehead/addoutnoticehead";

// `docNature: "20"` and `standardCol01: "0"` are constants in the capture
// and nothing on the screen sets either. Sent as captured; if a second
// kind of out-notice ever needs another value, this is where it goes.
const WMS_ISSUE_DOC_NATURE = "20";
const WMS_ISSUE_STANDARD_COL01 = "0";

// The only success code we have seen from this family of endpoints
// (`getpickrule`'s own reply, 2026-10-14). Anything else is reported as a
// refusal with WMS's own message rather than guessed at: claiming a
// document exists when it does not is the worse of the two mistakes, and
// the message is what somebody checks in WMS with.
const WMS_OK_CODE = "000001";

const LOT_ATTRIBUTES = Array.from({ length: 12 }, (_, index) => `lotAtt${String(index + 1).padStart(2, "0")}`);

/**
 * One `detailList` row: WMS's item record, plus what this position adds.
 *
 * `id` is **the item row's own** when it has one - this framework keys its
 * records by a 32-hex id and the captured detail row carries exactly such
 * a value - and a fresh one only when WMS sent none, because a row with no
 * id is a row WMS cannot place.
 */
export function wmsIssueDetailRow(raw, { quantity, location } = {}) {
  return {
    ...raw,
    id: raw?.id ?? randomUUID().replace(/-/g, ""),
    // A string in the capture, so a string here - not a number that
    // happens to serialise.
    applyQty: String(quantity ?? "").trim(),
    cellNo: String(location ?? "").trim(),
    combinationLotNo: "",
    ...Object.fromEntries(LOT_ATTRIBUTES.map((attribute) => [attribute, ""])),
    itemFlag: "1",
  };
}

/**
 * The whole head payload, in the capture's own order so the two can be
 * read side by side. Every field the capture sends empty is sent empty
 * here too: a key WMS's screen always sends is not one to leave out on the
 * theory that it is optional.
 */
export function wmsIssueHeadPayload(head = {}, detailList = []) {
  const text = (value) => String(value ?? "").trim();
  return {
    // WMS gives the document its number.
    outNoticeNo: "",
    orgNo: text(head.organization),
    // Both are 460 in the capture. The source organization is the one the
    // document is raised for; with none given it is the organization
    // itself, which is what that capture shows.
    docOrgNo: text(head.sourceOrganization) || text(head.organization),
    classifyType: text(head.documentClass),
    billDate: text(head.billDate),
    warehouseNo: text(head.sourceWarehouse),
    inWarehouseNo: text(head.destinationWarehouse),
    // The cell inside the destination warehouse. The capture sends the
    // warehouse's own code here with a label of "<code>-Cache location",
    // i.e. its default cell; the request that lists the cells has not been
    // captured, so with nothing chosen the destination warehouse stands in
    // and the label is left to WMS. **The one inferred field here.**
    inCellNo: text(head.destinationCell) || text(head.destinationWarehouse),
    inCellNoName: text(head.destinationCellName),
    lockTaskNo: "",
    lockTaskNoName: "",
    selectDocType: "",
    docNo: "",
    // The picking rule's own flag, off its WMS record - not a default
    // somebody here chose.
    autoShipConfirmFlag: text(head.autoShipConfirmFlag) || "N",
    pickRule: text(head.pickRule),
    pickRuleName: text(head.pickRuleName),
    customerNo: "",
    customerCodeName: "",
    guestCol01: "",
    carrierNo: "",
    carrierCodeName: "",
    workshopNo: "",
    docWoNo: "",
    accountAliases: "",
    accountAliasesName: "",
    guestCol02: "",
    remark: text(head.remark),
    standardCol05: "",
    markColor: "",
    guestCol03: "",
    portOutboundBatch: "",
    portOutboundBatchShow: "",
    poNumber: "",
    poNumberShow: "",
    standardCol01: WMS_ISSUE_STANDARD_COL01,
    applicationReason: "",
    detailList,
    docNature: WMS_ISSUE_DOC_NATURE,
    docNatureName: "",
    classifyTypeName: text(head.documentClassName),
  };
}

/** The document number WMS answered with, wherever it put it. */
export function createdOutNoticeNo(data) {
  const fields = ["outNoticeNo", "billNo", "docNo", "outNoticeNumber"];
  for (const source of [data, data?.data]) {
    if (!source || typeof source !== "object") continue;
    const found = firstFilled(source, fields);
    if (found) return found;
  }
  return typeof data?.data === "string" && data.data.trim() ? data.data.trim() : null;
}

/**
 * Create the issue note in WMS, as the signed-in person.
 *
 * `positions` are `[{ itemNo, quantity, location }]` - **item numbers, not
 * materials**: every one is resolved against WMS's item master here and
 * only an exact match is accepted. A position nobody can point at one
 * material is not sent at all; an issue note that leaves the warehouse
 * with the wrong material on it is the mistake this whole screen is
 * arranged to avoid.
 */
export async function createWmsIssueNote({ session, head = {}, positions = [] }) {
  const orgNo = String(head.organization ?? "").trim();

  // The items, four at a time, exactly as the paste itself is resolved -
  // and **only an exact match**, which is what `matched` already decides.
  const answers = await mapWithLimit(positions, WMS_LOOKUP_CONCURRENCY, (position) =>
    findWmsItem({ session, orgNo, keyword: String(position.itemNo ?? "").trim() })
  );
  const unresolved = positions
    .filter((_, index) => answers[index].matched !== "exact" || !answers[index].raw)
    .map((position) => String(position.itemNo ?? "").trim());
  if (unresolved.length) {
    throw wmsError("wms_unknown_items", `WMS nie rozpoznaje pozycji: ${unresolved.join(", ")}.`);
  }
  const resolved = positions.map((position, index) => wmsIssueDetailRow(answers[index].raw, position));

  // The labels, off WMS's own lists. The screen sent codes; what the
  // document carries beside each code is WMS's to say.
  const labels = {};
  const documentClass = String(head.documentClass ?? "").trim();
  if (documentClass) {
    const classes = await listWmsDocumentClasses({ session, orgNo });
    const chosen = classes.find((option) => option.code === documentClass);
    if (!chosen) throw wmsError("wms_unknown_document_class", `WMS nie zna klasy dokumentu ${documentClass}.`);
    labels.documentClassName = chosen.name ?? "";
  }

  const pickingRule = String(head.pickingRule ?? "").trim();
  if (pickingRule) {
    const rules = await listWmsPickRules({ session, orgNo });
    const chosen = rules.find((option) => option.code === pickingRule);
    if (!chosen) throw wmsError("wms_unknown_pick_rule", `WMS nie zna reguły pobrania ${pickingRule}.`);
    // The capture's own direction: the **name** in `pickRule`, "id-name"
    // in `pickRuleName`.
    labels.pickRule = chosen.name ?? "";
    labels.pickRuleName = chosen.name ? `${chosen.code}-${chosen.name}` : chosen.code;
    labels.autoShipConfirmFlag = chosen.raw?.autoShipConfirmFlag ?? "N";
  }

  const payload = wmsIssueHeadPayload({ ...head, ...labels }, resolved);
  const reply = await wmsPost(WMS_ADD_OUT_NOTICE_PATH, payload, {
    cookie: session?.cookie,
    auth: authInfoFor(session),
    appModule: WMS_MODULE_ISSUE,
  });

  if (wmsNotLoggedIn(reply)) {
    console.warn(`[wms] issue note refused (HTTP ${reply.status}):`, refusalReason(reply.data));
    throw wmsError("wms_session_expired", "Sesja WMS wygasła - zaloguj się do WMS ponownie.");
  }

  const code = String(reply.data?.code ?? "");
  if (code !== WMS_OK_CODE) {
    // WMS's own words, not a translation of them: this is what somebody
    // checks the document against, and a save that may or may not have
    // landed must never read as "saved".
    console.warn(`[wms] issue note not accepted (HTTP ${reply.status}):`, refusalReason(reply.data));
    throw wmsError("wms_rejected", `WMS nie przyjął listy: ${refusalReason(reply.data)}`);
  }

  const outNoticeNo = createdOutNoticeNo(reply.data);
  console.log(
    "[wms] issue note created:",
    outNoticeNo ?? "(no number in the reply)",
    "| reply fields:",
    Object.keys(reply.data ?? {}).join(",") || "(none)"
  );
  return { outNoticeNo, positions: resolved.length };
}

// --- The issue notes already in WMS ------------------------------------
// What the `outnotice` screen lists, captured 2026-10-15:
// `POST /ilcwmswms/outnoticehead/getoutnoticeheadlistbyparams` - the same
// application as the save (`ilcwmswms`), not the `ilcwmsbase` every read
// above lives in.
//
// Its condition is **long and almost entirely empty**: fifteen search
// fields WMS's own screen sends blank, which is how it asks for
// everything. They are all sent, for the reason every other body here is
// sent whole - a field WMS's own screen always sends is not one to drop on
// the theory that it is optional.
//
// `field: "updateDate"` + `order: "desc"` is **newest first**, which is
// what this is read for, and the only two values here that are a decision
// rather than a copy. `standardCol01: "0"` is the same constant the save
// sends, so this lists the documents that save creates and not some other
// kind.
const WMS_ISSUE_NOTE_LIST_PATH = "/ilcwmswms/outnoticehead/getoutnoticeheadlistbyparams";
const WMS_ISSUE_NOTE_PAGE_SIZE = 50;
export const WMS_ISSUE_NOTE_MAX_PAGE_SIZE = 200;

// Which field holds what, same rule as ITEM_FIELDS: tried in order, first
// non-blank wins. **These are not guesses the way the warehouses' were**:
// the save's own captured payload names the columns of this very table
// (`outNoticeNo`, `billDate`, `classifyType`, `warehouseNo`, `remark`), and
// `updateDate` is proven to exist by being what the list is sorted on. The
// ones with no such backing are the people and the counts, so those carry
// several spellings and a blank costs an empty cell, not the list.
export const ISSUE_NOTE_FIELDS = {
  outNoticeNo: ["outNoticeNo", "billNo", "docNo"],
  billDate: ["billDate"],
  createdAt: ["createDate", "createTime", "updateDate", "billDate"],
  createdBy: ["createUserName", "createUser", "createBy", "creator"],
  status: ["statusCodeName", "statusName", "statusCode"],
  documentClass: ["classifyTypeName", "classifyType"],
  warehouse: ["warehouseName", "warehouseNo"],
  positions: ["detailCount", "itemCount", "detailNum", "totalRows"],
  remark: ["remark"],
};

/** One listed note, flattened - **never WMS's own row** (see /items). */
export function normaliseWmsIssueNote(row) {
  const note = Object.fromEntries(
    Object.entries(ISSUE_NOTE_FIELDS).map(([key, fields]) => [key, firstFilled(row, fields) ?? null])
  );
  // A count is a number or it is nothing: a screen puts this in a numeric
  // column, where "12" and 12 do not sort the same way. **A count WMS did
  // not send stays null** - `Number(null)` is 0, and a document shown as
  // having no positions is a claim about it, not a missing cell.
  const positions = note.positions === null ? NaN : Number(note.positions);
  note.positions = Number.isFinite(positions) ? positions : null;
  return note;
}

/** The body WMS's own list screen sends, with only the paging varied. */
export function wmsIssueNoteListBody({ orgNo = "", page = 1, size = WMS_ISSUE_NOTE_PAGE_SIZE, auth = "" } = {}) {
  return {
    condition: {
      type: "operation",
      // Blank is every organization, which is what the capture asks for.
      // Scoped only when a caller says so - this screen's table is read to
      // find a document, and one raised for another organization is still
      // a document somebody is looking for.
      orgNo: String(orgNo ?? "").trim(),
      warehouseNo: "",
      customerNoIndistinct: "",
      docNoIndistinct: "",
      orderNoIndistinct: "",
      outNoticeNoIndistinct: "",
      classifyType: "",
      statusCode: "",
      itemNoIndistinct: "",
      enterWarehouseNoIndistinct: "",
      containerNoIndistinct: "",
      standardCol01: WMS_ISSUE_STANDARD_COL01,
      applicationReason: "",
      remarkIndistinct: "",
      dateRange: "",
      // WMS's own screen copies three of its **headers** into the
      // condition - its ajax layer merges them in - and they are sent back
      // the same way. The session id here is the one already travelling in
      // this request's cookie and `authentication-info` header, so it is
      // not a second disclosure; nothing logs a request body.
      "Authentication-Info": auth,
      "Accept-Language": "en-US",
      "App-Module-Number": WMS_MODULE_ISSUE,
      startDate: "",
      endDate: "",
      field: "updateDate",
      order: "desc",
    },
    current: page,
    size,
  };
}

/**
 * The issue notes WMS already holds, newest first.
 *
 * Read-only, and the counterpart of `createWmsIssueNote`: what wps's own
 * table shows is **WMS's list**, not a local note of what this browser
 * once sent. A document raised on WMS's own screen therefore shows up here
 * too, and nothing is lost by reloading the page.
 */
export async function listWmsIssueNotes({ session, orgNo = "", page = 1, size = WMS_ISSUE_NOTE_PAGE_SIZE } = {}) {
  const auth = authInfoFor(session);
  const reply = await wmsPost(WMS_ISSUE_NOTE_LIST_PATH, wmsIssueNoteListBody({ orgNo, page, size, auth }), {
    cookie: session?.cookie,
    auth,
    appModule: WMS_MODULE_ISSUE,
  });

  // Before the rows, for the reason it is everywhere else here: a dead
  // session is an ordinary 200 with none, which reads as an empty table -
  // and an empty table is exactly what somebody would believe.
  if (wmsNotLoggedIn(reply)) {
    console.warn(`[wms] issue note list refused (HTTP ${reply.status}):`, refusalReason(reply.data));
    throw wmsError("wms_session_expired", "Sesja WMS wygasła - zaloguj się do WMS ponownie.");
  }

  const rows = wmsRowsFrom(reply.data);
  if (!loggedListFields.has("issue note")) {
    loggedListFields.add("issue note");
    console.log(
      "[wms] issue note list reply fields:",
      Object.keys(reply.data ?? {}).join(",") || "(none)",
      "| row fields:",
      rows[0] && typeof rows[0] === "object" ? Object.keys(rows[0]).join(",") : "(no rows)"
    );
  }

  // A row with no number is dropped: it cannot be looked up in WMS and it
  // cannot be told apart from the next one on screen.
  return rows.map(normaliseWmsIssueNote).filter((note) => note.outNoticeNo);
}

export function logWmsMode() {
  console.log(
    `[wms] login proxy -> ${WMS_BASE_URL}${WMS_TLS_INSECURE ? " (TLS certificate NOT verified - WMS_TLS_INSECURE=true)" : ""}`
  );
}
