// Asserts how a WMS login reply is read - **needs neither WMS nor a
// password**, which is the point: the alternative is somebody's real
// credentials and a production login endpoint every time this is touched.
//
// Every reply shape below but the success ones was captured live from
// wms.yofc.com:8181 on 2026-10-13 with an account that does not exist.
import {
  authInfoFor,
  matchWmsItem,
  normaliseWmsItem,
  refusalReason,
  sessionCookie,
  sessionToken,
  wmsNotLoggedIn,
  wmsRowsFrom,
  wmsSessionFrom,
  CLASSIFY_TYPE_FIELDS,
  ORG_FIELDS,
  PICK_RULE_FIELDS,
  WAREHOUSE_FIELDS,
  createdOutNoticeNo,
  normaliseWmsIssueNote,
  referenceOptions,
  wmsIssueDetailRow,
  wmsIssueHeadPayload,
  wmsIssueNoteListBody,
} from "../src/wms.js";

let failures = 0;

function check(what, ok, got) {
  if (ok) {
    console.log(`  ok   ${what}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${what}${got === undefined ? "" : ` (got: ${got})`}`);
}

// ── A refusal ────────────────────────────────────────────────────────────
// WMS answers **HTTP 200** for a wrong password and says so only in the
// body, while blanking the session cookie. Reading the status, or trusting
// a Set-Cookie to mean "logged in", both read this as a success.
const refused = {
  status: 200,
  data: { msg: "Login failed, please re-enter user and password!", code: "sys0049" },
  setCookie: ["WMS_AUTH=; Path=/; Secure; HttpOnly; SameSite=Lax"],
};

console.log("A refused login:");
check("is not accepted, though WMS answered 200", wmsSessionFrom(refused).accepted === false);
check("leaves no cookie to send back", wmsSessionFrom(refused).cookie === null);
check("leaves no token either", wmsSessionFrom(refused).token === null);
check(
  "and its reason names both the message and the code",
  refusalReason(refused.data) === "Login failed, please re-enter user and password! / code sys0049",
  refusalReason(refused.data)
);

// ── An accepted login ────────────────────────────────────────────────────
console.log("\nAn accepted login:");
const accepted = {
  status: 200,
  data: { msg: null, code: "0" },
  setCookie: ["WMS_AUTH=9f2c1ab4e7; Path=/; Secure; HttpOnly; SameSite=Lax"],
};
check("is accepted on the strength of the session alone", wmsSessionFrom(accepted).accepted === true);
check(
  "and the cookie goes back without its attributes",
  wmsSessionFrom(accepted).cookie === "WMS_AUTH=9f2c1ab4e7",
  wmsSessionFrom(accepted).cookie
);

// A result code is deliberately not read: nothing tells us which of
// sys0049's siblings means yes, and guessing it wrong would refuse somebody
// whose password was right.
check(
  "a session with an unfamiliar code is still a session",
  wmsSessionFrom({ ...accepted, data: { code: "sys0000", msg: "OK" } }).accepted === true
);

// ── Shapes we have not seen but may ──────────────────────────────────────
console.log("\nShapes WMS may also answer with:");
check(
  "a session split across two cookies travels as one header",
  sessionCookie(["WMS_AUTH=abc; Path=/; HttpOnly", "JSESSIONID=def; Path=/"]) === "WMS_AUTH=abc; JSESSIONID=def",
  sessionCookie(["WMS_AUTH=abc; Path=/; HttpOnly", "JSESSIONID=def; Path=/"])
);
check(
  "a cleared cookie among a real one does not come along",
  sessionCookie(["WMS_AUTH=abc; Path=/", "OTHER=; Path=/"]) === "WMS_AUTH=abc",
  sessionCookie(["WMS_AUTH=abc; Path=/", "OTHER=; Path=/"])
);
check("no Set-Cookie at all is no cookie", sessionCookie([]) === null && sessionCookie(undefined) === null);
check("a token in the body is found", sessionToken({ token: "t-1" }) === "t-1");
check("so is one under data", sessionToken({ code: "0", data: { accessToken: "t-2" } }) === "t-2");
check("a numeric session id counts", sessionToken({ data: { sessionId: 4601270 } }) === "4601270");
check("a blank token field does not", sessionToken({ token: "   " }) === null);
check(
  "a body token is enough on its own, with no cookie",
  wmsSessionFrom({ status: 200, data: { token: "t-3" }, setCookie: [] }).accepted === true
);

// The framework answers an unauthenticated call with its own login page -
// HTML, not JSON, which wmsPost reports as data: null.
check(
  "the login page instead of an answer is not a login",
  wmsSessionFrom({ status: 200, data: null, setCookie: [] }).accepted === false
);
check("and says so rather than listing fields", refusalReason(null).includes("not JSON"));
check(
  "an HTTP error is refused even if it carried a cookie",
  wmsSessionFrom({ status: 500, data: null, setCookie: ["WMS_AUTH=abc; Path=/"] }).accepted === false
);

// ── What a later call sends back ─────────────────────────────────────────
// WMS's pages carry the session twice: the WMS_AUTH cookie and the same id
// again as `authentication-info`.
console.log("\nThe session on a later call:");
check("comes from the body token when there is one", authInfoFor({ token: "t-1", cookie: "WMS_AUTH=abc" }) === "t-1");
check("otherwise out of the cookie", authInfoFor({ cookie: "WMS_AUTH=abc" }) === "abc");
check(
  "and is found when WMS_AUTH is not the first cookie",
  authInfoFor({ cookie: "JSESSIONID=x; WMS_AUTH=abc" }) === "abc",
  authInfoFor({ cookie: "JSESSIONID=x; WMS_AUTH=abc" })
);
check("no session, nothing to send", authInfoFor(null) === null && authInfoFor({ cookie: "OTHER=1" }) === null);

// ── A session WMS has dropped ────────────────────────────────────────────
// The one that has to be told apart from "no such item": captured live on
// 2026-10-14 with an all-zeros session id, a lookup on a dead session is an
// ordinary HTTP 200 carrying no rows. Count rows and a whole pasted list
// reads as unknown materials, with nothing on screen about signing in.
console.log("\nA session WMS has dropped:");
const notLoggedIn = { status: 200, data: { code: "000701", msg: "User not logged in" } };
check("is recognised by its code, not its status", wmsNotLoggedIn(notLoggedIn) === true);
check("and would otherwise look like an empty result", wmsRowsFrom(notLoggedIn.data).length === 0);
check(
  "the message alone is enough under another code",
  wmsNotLoggedIn({ status: 200, data: { code: "000999", msg: "User not logged in" } }) === true
);
check("so is the login page instead of JSON", wmsNotLoggedIn({ status: 200, data: null }) === true);
check(
  "a real result is not mistaken for it",
  wmsNotLoggedIn({ status: 200, data: { code: "0", data: { records: [] } } }) === false
);
check(
  "and neither is a genuinely empty search",
  wmsNotLoggedIn({ status: 200, data: { code: "0", msg: null, data: { records: [] } } }) === false
);

// ── Reading an item lookup ───────────────────────────────────────────────
// The reply's own shape has not been seen (the probe needed a live session,
// and a session is somebody's password), so every container this family of
// frameworks uses is accepted rather than one being assumed.
console.log("\nAn item lookup:");
const row = { itemNo: "995402000010002", itemName: "FRP 2.0mm", unitNo: "KM", spec: "2.0mm" };
check("rows under data.records are found", wmsRowsFrom({ code: "0", data: { records: [row] } }).length === 1);
check("so are data.list and data.rows", wmsRowsFrom({ data: { list: [row] } }).length === 1 && wmsRowsFrom({ data: { rows: [row] } }).length === 1);
check("so is data itself being the array", wmsRowsFrom({ data: [row] }).length === 1);
check("and the body itself being one", wmsRowsFrom([row]).length === 1);
check("nothing recognisable is no rows, not a crash", wmsRowsFrom({ code: "sys0049" }).length === 0 && wmsRowsFrom(null).length === 0);

const item = normaliseWmsItem(row);
check("an item carries its number, name, unit and spec", item.itemNo === "995402000010002" && item.itemName === "FRP 2.0mm" && item.unit === "KM" && item.spec === "2.0mm");
check(
  "a different spelling of the same field still reads",
  normaliseWmsItem({ itemCode: "404", materialName: "FRP 1.8", unitName: "KM" }).itemName === "FRP 1.8"
);
check("a field WMS did not send is null, never undefined", normaliseWmsItem({ itemNo: "1" }).spec === null);

// A search, not a get: "9954020000" comes back with everything starting
// that way, so which row the keyword meant has to be decided.
console.log("\nWhich row a keyword meant:");
const several = [row, { itemNo: "995402000010003", itemName: "FRP 2.4mm", unitNo: "KM" }];
check("an exact item number wins", matchWmsItem(several, "995402000010003").item.itemName === "FRP 2.4mm");
check("and is not the first row just because it is first", matchWmsItem(several, "995402000010003").matched === "exact");
check("a single hit is taken as the answer", matchWmsItem([row], "99540200001").matched === "only");
check(
  "several hits and no exact match fill nothing",
  matchWmsItem(several, "9954020000").item === null && matchWmsItem(several, "9954020000").matched === "ambiguous"
);
check("and say how many there were", matchWmsItem(several, "9954020000").count === 2);
check("no hits at all is 'none'", matchWmsItem([], "404").matched === "none");
check("a row with neither number nor name is not a hit", matchWmsItem([{ createdBy: "x" }], "404").matched === "none");
check("case does not decide an exact match", matchWmsItem([{ itemNo: "AB-1", itemName: "x" }], "ab-1").matched === "exact");

// The two header selects' own lists. Same tolerance as the items: the
// replies' real field names have not been seen, so an unexpected spelling
// must cost one row, not the whole select.
console.log("\nThe header's own lists:");
const wh = (rows) => referenceOptions(rows, WAREHOUSE_FIELDS);
const dc = (rows) => referenceOptions(rows, CLASSIFY_TYPE_FIELDS);
const warehouse = { warehouseNo: "4601", warehouseName: "FRP store" };
check("a warehouse carries its code and name", wh([warehouse])[0].code === "4601" && wh([warehouse])[0].name === "FRP store");
check(
  "a different spelling of the same field still reads",
  wh([{ whNo: "4602", whName: "Raw materials" }])[0].name === "Raw materials"
);
check("a numeric code is a string", wh([{ warehouseNo: 4603 }])[0].code === "4603");
check(
  "a row with no name is still selectable by its code",
  wh([{ warehouseNo: "4604" }]).length === 1 && wh([{ warehouseNo: "4604" }])[0].name === null
);
// An option whose value cannot be submitted is worse than a shorter list.
check("a row with no code is dropped", wh([{ warehouseName: "Nameless" }]).length === 0);
check("the same code twice is one option", wh([warehouse, { warehouseNo: "4601" }]).length === 1);
check(
  "WMS's own order is kept",
  wh([{ warehouseNo: "9" }, { warehouseNo: "1" }]).map((option) => option.code).join(",") === "9,1"
);
check("no rows is an empty list, not a crash", wh([]).length === 0 && wh(null).length === 0);
// The document classes are the same call with another path and condition,
// so only their field names are their own.
check(
  "a document class reads its own field names",
  dc([{ classifyTypeNo: "OM01", classifyTypeName: "Production issue" }])[0].name === "Production issue"
);
check(
  "and a sibling spelling of them",
  dc([{ businessClassifyTypeNo: "OM02", typeName: "Sales issue" }])[0].code === "OM02"
);
check("a warehouse row is not a document class", dc([{ warehouseNo: "4601" }]).length === 0);

// The picking rules are the one list whose reply we have actually seen -
// `getpickrule` needs no session, so this row is WMS's own, captured on
// 2026-10-14 for org 460.
const pr = (rows) => referenceOptions(rows, PICK_RULE_FIELDS);
const pickRuleRow = {
  pickRuleName: "YOFC POL pick",
  organizationCode: "460",
  autoShipConfirmFlag: "N",
  pickRuleId: "510",
  lastUpdateDate: "2021-11-30 11:13:36",
};
check(
  "WMS's own picking-rule row reads as id and name",
  pr([pickRuleRow])[0].code === "510" && pr([pickRuleRow])[0].name === "YOFC POL pick",
  JSON.stringify(pr([pickRuleRow]))
);
check(
  "and it is found under data.records, in an envelope whose code is 000001",
  wmsRowsFrom({ code: "000001", msg: "成功", data: { records: [pickRuleRow], total: 1 } }).length === 1
);
check(
  "a picking rule with another spelling of the id still uses it",
  pr([{ ruleNo: "PR1", ruleName: "FIFO by batch" }])[0].code === "PR1"
);
check(
  "a picking rule with only a name is still selectable",
  pr([{ pickRuleName: "FIFO by batch" }])[0].code === "FIFO by batch" &&
    pr([{ pickRuleName: "FIFO by batch" }])[0].name === "FIFO by batch"
);
check(
  "and a row with neither is still dropped",
  pr([{ createdBy: "x" }]).length === 0
);
// The fallback is this list's alone: a warehouse with no number is a row
// nothing can be done with, not one to name by its own label.
check(
  "the name never stands in as a code for the other lists",
  wh([{ warehouseName: "FRP store" }]).length === 0 && dc([{ classifyTypeName: "Production" }]).length === 0
);
// The same 200-with-no-rows trap the items have: a dead session must not
// read as "this organization has no warehouses".
check(
  "a not-logged-in reply is not an empty list",
  wmsNotLoggedIn({ status: 200, data: { code: "000701", msg: "User not logged in" } }) === true
);

// ── The saved document ───────────────────────────────────────────────────
// Asserted against WMS's **own captured save** (2026-10-14,
// `addoutnoticehead`), because that payload is the only statement of what
// WMS expects and a field quietly dropped from it is a document refused at
// the far end with nothing on screen to explain it.
console.log("\nThe issue note that gets sent:");

// One item row as WMS answers it, cut to the fields that matter here.
const itemRow = {
  id: "75e5553163f34e558a4bb76adbefb72c",
  orgNo: "460",
  orgName: "YOFC Poland",
  itemNo: "993403000000001",
  itemName: "General tube filling gel",
  itemSpec: "General tube filling gel",
  itemType: 2,
  unitNo: "KG",
  itemPrice: 5.8186,
  guestCol01: "99",
  statusCode: 1,
};

const detail = wmsIssueDetailRow(itemRow, { quantity: "850", location: "" });
check(
  "a position is WMS's own item row, sent back whole",
  detail.itemPrice === 5.8186 && detail.guestCol01 === "99" && detail.statusCode === 1 && detail.orgName === "YOFC Poland"
);
check("with the quantity as a string, as the capture has it", detail.applyQty === "850");
check(
  "the twelve lot attributes, the combination lot and the cell are all sent, all empty",
  Array.from({ length: 12 }, (_, i) => `lotAtt${String(i + 1).padStart(2, "0")}`).every((k) => detail[k] === "") &&
    detail.combinationLotNo === "" &&
    detail.cellNo === ""
);
check("and itemFlag is 1", detail.itemFlag === "1");
// The item record is keyed by a 32-hex id in this framework and the
// captured detail row carries exactly such a value, so the row's own id is
// the one to send.
check("the row keeps the id WMS gave it", detail.id === "75e5553163f34e558a4bb76adbefb72c");
check(
  "and gets one only when WMS gave none",
  /^[0-9a-f]{32}$/.test(wmsIssueDetailRow({ itemNo: "X" }, { quantity: "1" }).id)
);
check("the location typed in the grid is the cell", wmsIssueDetailRow(itemRow, { quantity: "1", location: "A-01" }).cellNo === "A-01");

// The head, against the capture key for key.
const head = wmsIssueHeadPayload(
  {
    organization: "460",
    documentClass: "POLAND005",
    documentClassName: "Material requisitioned",
    billDate: "2026-10-14",
    sourceWarehouse: "POLAND-CTR01",
    destinationWarehouse: "POLAND-CWR01",
    pickRule: "YOFC POL pick",
    pickRuleName: "510-YOFC POL pick",
    autoShipConfirmFlag: "N",
    remark: "",
  },
  [detail]
);
const captured = [
  "outNoticeNo", "orgNo", "docOrgNo", "classifyType", "billDate", "warehouseNo",
  "inWarehouseNo", "inCellNo", "inCellNoName", "lockTaskNo", "lockTaskNoName",
  "selectDocType", "docNo", "autoShipConfirmFlag", "pickRule", "pickRuleName",
  "customerNo", "customerCodeName", "guestCol01", "carrierNo", "carrierCodeName",
  "workshopNo", "docWoNo", "accountAliases", "accountAliasesName", "guestCol02",
  "remark", "standardCol05", "markColor", "guestCol03", "portOutboundBatch",
  "portOutboundBatchShow", "poNumber", "poNumberShow", "standardCol01",
  "applicationReason", "detailList", "docNature", "docNatureName", "classifyTypeName",
];
check(
  "every key the capture sends is sent, in its order, and none besides",
  Object.keys(head).join(",") === captured.join(","),
  Object.keys(head).join(",")
);
check("the number is WMS's to give", head.outNoticeNo === "");
// Both are 460 in the capture, and a document raised for nobody else is
// raised for its own organization.
check("the source organization defaults to the organization", head.docOrgNo === "460");
check(
  "a source organization of its own is kept",
  wmsIssueHeadPayload({ organization: "460", sourceOrganization: "470" }).docOrgNo === "470"
);
// Not the obvious direction: the capture puts the rule's **name** in
// `pickRule` and "id-name" in `pickRuleName`.
check(
  "the picking rule goes in by name, with id-name beside it",
  head.pickRule === "YOFC POL pick" && head.pickRuleName === "510-YOFC POL pick"
);
check(
  "the document class goes in by code, with its label beside it",
  head.classifyType === "POLAND005" && head.classifyTypeName === "Material requisitioned"
);
check("the two constants of the capture are sent as captured", head.docNature === "20" && head.standardCol01 === "0");
// The one inferred field: the capture's `inCellNo` is the destination
// warehouse's own code, and the cell list has not been captured.
check("with no cell chosen, the destination warehouse stands in", head.inCellNo === "POLAND-CWR01");
check(
  "and a cell that was chosen is used",
  wmsIssueHeadPayload({ destinationWarehouse: "W", destinationCell: "W-02" }).inCellNo === "W-02"
);
check(
  "every field the capture sends empty is sent, not left out",
  ["lockTaskNo", "selectDocType", "docNo", "customerNo", "carrierNo", "workshopNo", "docWoNo",
   "accountAliases", "guestCol01", "guestCol02", "guestCol03", "markColor", "poNumber",
   "portOutboundBatch", "applicationReason", "standardCol05", "docNatureName"].every(
    (key) => head[key] === ""
  )
);

// Where WMS puts the number it gave the document.
check("the document number is read off the reply", createdOutNoticeNo({ code: "000001", data: { outNoticeNo: "OM2026-1" } }) === "OM2026-1");
check("or off a plain data string", createdOutNoticeNo({ code: "000001", data: "OM2026-2" }) === "OM2026-2");
check("and a reply without one is not invented", createdOutNoticeNo({ code: "000001", data: { ok: true } }) === null);

// ── The organizations list ───────────────────────────────────────────────
// Its request was captured on 2026-10-15; its reply has not been, so the
// field spellings are candidates like the warehouses' - what is asserted
// here is the shape, not WMS's naming.
const org = (rows) => referenceOptions(rows, ORG_FIELDS);
check(
  "an organization row reads as code and name",
  JSON.stringify(org([{ orgNo: "460", orgName: "YOFC Poland" }]).map(({ code, name }) => [code, name])) ===
    JSON.stringify([["460", "YOFC Poland"]])
);
check(
  "the organization code wins over a warehouse-ish spelling",
  org([{ organizationCode: "461", warehouseNo: "W1", orgName: "X" }])[0].code === "461"
);
check(
  "an organization with no code at all is dropped, like a warehouse",
  org([{ orgName: "Nameless" }]).length === 0
);

// ── The list of issue notes ──────────────────────────────────────────────
// The body WMS's own `outnotice` screen sends, captured 2026-10-15. Almost
// all of it is empty search fields: a key WMS always sends is not one to
// drop on the theory that it is optional, so the key list is asserted
// against the capture the same way the save's is.
const listBody = wmsIssueNoteListBody({ page: 2, size: 20, auth: "sess-1" });
const capturedCondition = [
  "type", "orgNo", "warehouseNo", "customerNoIndistinct", "docNoIndistinct", "orderNoIndistinct",
  "outNoticeNoIndistinct", "classifyType", "statusCode", "itemNoIndistinct", "enterWarehouseNoIndistinct",
  "containerNoIndistinct", "standardCol01", "applicationReason", "remarkIndistinct", "dateRange",
  "Authentication-Info", "Accept-Language", "App-Module-Number", "startDate", "endDate", "field", "order",
];
check(
  "the list condition carries every key of the capture, in its order",
  Object.keys(listBody.condition).join(",") === capturedCondition.join(","),
  Object.keys(listBody.condition).join(",")
);
check(
  "it asks for the newest first - the only two values here that are a choice",
  listBody.condition.field === "updateDate" && listBody.condition.order === "desc"
);
check(
  "and for the same kind of document the save creates",
  listBody.condition.standardCol01 === "0" && listBody.condition.type === "operation"
);
check(
  "the paging is the caller's, the rest of the condition empty",
  listBody.current === 2 &&
    listBody.size === 20 &&
    ["warehouseNo", "statusCode", "classifyType", "startDate", "endDate", "dateRange", "orgNo"].every(
      (key) => listBody.condition[key] === ""
    )
);
check(
  "an organization is sent only when the caller asks for one",
  wmsIssueNoteListBody({ orgNo: "460" }).condition.orgNo === "460"
);
check(
  "the three headers WMS copies into its own condition are copied back",
  listBody.condition["Authentication-Info"] === "sess-1" &&
    listBody.condition["App-Module-Number"] === "100400010001" &&
    listBody.condition["Accept-Language"] === "en-US"
);

// A listed row, flattened. The first-choice spellings are the save
// capture's own key names - the columns of this very table - so these are
// not guesses in the way the warehouses' are.
const note = normaliseWmsIssueNote({
  outNoticeNo: "OM26101500001",
  billDate: "2026-10-15",
  createDate: "2026-10-15 09:12:33",
  createUserName: "4601270",
  statusCodeName: "Created",
  classifyTypeName: "Material requisitioned",
  warehouseNo: "POLAND-MAG01",
  detailCount: "3",
  remark: "zmiana szpuli",
  guestCol01: "something WMS added",
});
check("a listed note reads its number off WMS's own column", note.outNoticeNo === "OM26101500001");
check("and the person, the status and the class", note.createdBy === "4601270" && note.status === "Created" && note.documentClass === "Material requisitioned");
check("a count is a number, not WMS's string", note.positions === 3 && typeof note.positions === "number");
check(
  "nothing of WMS's own row is passed on but the fields asked for",
  Object.keys(note).join(",") ===
    "outNoticeNo,billDate,createdAt,createdBy,status,documentClass,warehouse,positions,remark"
);
check(
  "a status WMS sends only as a code is still a status",
  normaliseWmsIssueNote({ outNoticeNo: "X", statusCode: "10" }).status === "10"
);
check(
  "a field WMS did not send is null, never undefined or a stray string",
  normaliseWmsIssueNote({ outNoticeNo: "X" }).positions === null &&
    normaliseWmsIssueNote({ outNoticeNo: "X" }).createdBy === null
);
check(
  "a row with no number at all has none - the list drops it",
  normaliseWmsIssueNote({ billDate: "2026-10-15" }).outNoticeNo === null
);

console.log();
if (failures) {
  console.error(`${failures} sprawdzenie(a) nie przeszło.`);
  process.exit(1);
}
console.log("Wszystkie sprawdzenia przeszły");
