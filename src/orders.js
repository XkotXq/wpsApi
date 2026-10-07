import { pool } from "./db.js";
import { ApiError } from "./errors.js";
import { photosByOrderIds } from "./orderPhotos.js";

// Transport orders ("Lista zamówień" / "Historia zamówień" in wps) - backs
// schema.sql's orders/order_items (see that file's own comments, and
// wpsApi's AGENTS.md "Transport orders" section for the full field-by-field
// writeup). Our database is the source of truth; nothing here talks to CIP.

const ORDER_TYPES = ["water_refill", "material_order", "spool_order", "goods_transport", "waste_removal", "warehouse_return", "machine_transport"];

// How urgent the requester said it is - see schema.sql. Ordered least to
// most, which is also the order smOrder shows them in.
export const PRIORITIES = ["normal", "urgent", "critical"];

// DB status <-> wps's own camelCase status strings (STATUS_STYLES/
// STATUS_SETS in OrdersCipListTable.js) - kept as a translation at the
// boundary so neither side has to change for the other's convention.
const STATUS_TO_API = {
  new: "new",
  in_progress: "inProgress",
  problem: "problem",
  delivered: "delivered",
  done: "done",
  cancelled: "cancelled",
};
// 'delivered' stays in "active" (Lista zamówień), not "history" - the
// working part (taking it, issuing everything) is done, but it's still
// open: awaiting the requester's accept/problem-report (or the 10-minute
// auto-accept - see autoAcceptDeliveredOrders), same as
// new/in_progress in that it hasn't reached a final state yet.
const STATUS_SETS = {
  // 'problem' is open work too, and the most urgent kind: it is waiting
  // on the requester, so it must stay on the active list where both sides
  // can see it.
  active: ["new", "in_progress", "problem", "delivered"],
  history: ["done", "cancelled"],
};

// `details`' own key convention differs from the rest of this API: every
// other JSONB-adjacent field here is translated snake_case DB <-> camelCase
// API at the row level (requested_by <-> employeeNo, ...), but `details`
// itself is a free-form JSONB blob whose *contents* schema.sql's own CHECK
// constraint (orders_type_fields) inspects directly by key -
// `details ->> 'production_order_no'` - while OrdersCipListTable.js writes/
// reads `details.productionOrderNo` (camelCase, matching every other field
// name in its own JS). Only this one key needs translating both ways -
// `water` is a single word, no case difference either way. Caught live
// (2026-09-29): every material_order insert failed orders_type_fields
// because `production_order_no` was never actually set under that name.
function detailsToDb(details) {
  const out = { ...details };
  if ("productionOrderNo" in out) {
    out.production_order_no = out.productionOrderNo;
    delete out.productionOrderNo;
  }
  return out;
}
function detailsFromDb(details) {
  const out = { ...(details ?? {}) };
  if ("production_order_no" in out) {
    out.productionOrderNo = out.production_order_no;
    delete out.production_order_no;
  }
  return out;
}

function orderRowToApi(row, items, photos = [], lineRuleNote = "", messageCount = 0, unreadCount = 0) {
  return {
    id: String(row.id),
    orderNo: row.order_no,
    type: row.type,
    status: STATUS_TO_API[row.status] ?? row.status,
    // Always a value, even for rows written before the column existed: the
    // default fills those in, so no client has to handle a null here.
    priority: row.priority ?? "normal",
    from: row.from_location,
    to: row.to_location,
    // {water, productionOrderNo} - see detailsFromDb's own comment for why
    // this isn't just `row.details` unchanged.
    details: detailsFromDb(row.details),
    clientOrderNo: row.client_order_no,
    employeeNo: row.requested_by,
    takenBy: row.taken_by,
    takenAt: row.taken_at,
    // Delivered/accepted - see schema.sql's own comment on these columns.
    // Both null outside the delivered/done-via-delivered path (most orders
    // still just go new/in_progress -> done directly).
    deliveredBy: row.delivered_by,
    deliveredAt: row.delivered_at,
    acceptedBy: row.accepted_by,
    acceptedAt: row.accepted_at,
    // Seconds left before the auto-accept sweep closes this one (see
    // autoAcceptDeliveredOrders) - null unless it is actually waiting, and
    // never negative. Sent as a *remaining duration* rather than leaving
    // clients to work it out from deliveredAt: the countdown then runs off
    // this server's clock, not a phone's (which can be minutes out), and
    // AUTO_ACCEPT_MINUTES stays a server-only constant instead of being
    // duplicated in every client. A client ticks it down locally between
    // reads and re-syncs on each one.
    autoAcceptInSeconds: row.status === "delivered" && row.delivered_at ? autoAcceptSecondsLeft(row.delivered_at) : null,
    // Seconds a goods_transport still has to run before "Dostarczone" can be
    // pressed (see MIN_RUN_SECONDS) - null for every other type and status,
    // i.e. "no wait applies". Same shape and reasoning as
    // autoAcceptInSeconds: a remaining duration off this server's clock, so
    // a phone that is minutes out cannot unlock the button early or lock it
    // for good, and the length of the wait lives in one place.
    deliverableInSeconds:
      row.type === "goods_transport" && row.status === "in_progress" && row.taken_at
        ? minRunSecondsLeft(row.taken_at)
        : null,
    // "Zrealizował" - the employee who actually carried the transport out,
    // which is the forklift operator: whoever pressed "Dostarczone"
    // (delivered_by, smVendor) or, for an order that never went through a
    // delivery step, whoever took it (taken_by). NOT completed_by: that's
    // only who *closed* the order - the requester accepting the delivery
    // (acceptOrder sets completed_by = accepted_by), a dashboard user
    // clicking "Zrealizuj" in wps, or literally "auto" for the 10-minute
    // auto-accept sweep - none of which is the person who did the work.
    // completed_by is still the fallback for an order closed without ever
    // being taken (new -> done straight from wps), where it's the only
    // name there is. Raw values stay available as completedBy/acceptedBy
    // below. "-" (not null) - OrderCard/the table both render this
    // straight into a cell, same convention the rest of this API already
    // uses for a blank optional field (see e.g. smItems.js's `note`).
    fulfilledBy: row.delivered_by || row.taken_by || row.completed_by || "-",
    // Who closed the order, unchanged - see fulfilledBy's own comment.
    completedBy: row.completed_by,
    completedAt: row.completed_at,
    // The problem the forklift operator is stuck on right now (status
    // 'problem') - "" once resolved, since it answers what is blocking
    // this order now. Every episode, including resolved ones, is in
    // GET /orders/:id/events.
    problemNote: row.problem_note ?? "",
    problemReportedBy: row.problem_reported_by,
    problemReportedAt: row.problem_reported_at,
    problemResolvedBy: row.problem_resolved_by,
    problemResolvedAt: row.problem_resolved_at,
    // Whose turn it is to answer the open problem: 'inProgress' = the
    // operator got stuck and the requester answers, 'delivered' = the
    // requester disputed the delivery and the operator answers. '' when
    // there is no open problem. The clients key their buttons off this -
    // the row looks the same either way.
    problemReportedFrom: STATUS_TO_API[row.problem_reported_from] ?? "",
    // Being edited by the person who placed it right now, so it is hidden
    // from the forklift operators' queue and cannot be taken (see
    // editLockActive/takeOrder). Only ever true on a 'new' order, and only
    // while the lock is fresh.
    editing: editLockActive(row),
    editingBy: editLockActive(row) ? row.editing_by : null,
    // How many chat messages this order has (see order_messages) - so the
    // "Czat" button can say there is something to read without every client
    // fetching every thread.
    messageCount,
    // ...and how many of them are new for the caller who asked (?viewer=),
    // which is what the badge actually shows. 0 when no viewer was named.
    unreadCount,
    cancelReason: row.cancel_reason,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    note: row.note || "-",
    // `photo` is the first attachment, `photos` all of them - each with a
    // short-lived presigned link (see orderPhotos.js). `photo` stays a
    // single object because that is the shape wps's own table/card already
    // renders; both are null/[] for an order with none, and also when
    // object storage isn't configured or is unreachable, so nothing here
    // fails over an attachment.
    photo: photos[0] ?? null,
    photos,
    // The standing instruction for the destination line itself, whatever
    // is being brought (line_material_rules with item_no IS NULL - see
    // that table). Per order, not per item, because it is about the drive:
    // repeating it under every material would be noise. "" when the line
    // has none.
    lineRuleNote,
    items: items.map((i) => ({
      itemNo: i.item_no,
      itemName: i.item_name,
      quantity: i.quantity,
      unit: i.unit,
      // How much of this line has actually been issued so far - see
      // schema.sql's order_items_progress view (summed live off
      // sm_operations.order_id, nothing stored twice). "0" for a type
      // itemsByOrderIds never asks that view for (see its own comment) -
      // never actually reached today since every order with items is a
      // material_order, but kept a real string rather than undefined so a
      // caller can always compare it against `quantity` the same way.
      issuedQuantity: i.issued_quantity != null ? String(i.issued_quantity) : "0",
      // What to label issuedQuantity with (e.g. "kg", or "szt." for FRP's
      // own drum count) - see order_items_progress's own comment on
      // issued_unit. Never `unit` above (order_items' own unit, always
      // "szt." regardless of category) - that would mislabel a real,
      // summed weight as if it were a piece-count.
      issuedUnit: i.issued_unit ?? "",
      // How many issues happened against this line - the signal for "done"
      // (see order_items_progress.issue_count for why a count and not a
      // quantity comparison).
      issueCount: Number(i.issue_count ?? 0),
      // Every distinct batch number the issuing scan(s) carried, comma-
      // separated - see order_items_progress's own comment on
      // issued_batches. "" (not null) when nothing's been issued yet, or
      // none of what has carried a batch at all.
      issuedBatches: i.issued_batches ?? "",
      // The standing instruction for this material on the destination line -
      // see order_items_progress's own comment on rule_note. "" (not null)
      // for the ordinary case, same blank-optional-field convention as the
      // fields above.
      ruleNote: i.rule_note ?? "",
      // "FRP" (sm_catalog.category) - wps's own per-material "Wydano" line
      // formats this category differently (one segment per drum) - see
      // order_items_progress's own comment.
      category: i.item_category ?? "",
      // The catalog's own real unit (e.g. "KM" for FRP), not issued_unit's
      // own "szt." drum-count label - what the per-drum FRP display is
      // labeled with.
      catalogUnit: i.catalog_unit ?? "",
      // Every individual issue scan against this line - [{itemNo omitted -
      // already the parent item, unitId, quantity}], oldest first. [] (not
      // null) when nothing's been issued yet, so a caller never needs an
      // extra null check before mapping over it.
      issuedEntries: (i.issued_entries ?? []).map((e) => ({ unitId: e.unitId ?? null, quantity: e.quantity })),
      // order_items has no field for "which CIP order line this came from"
      // (the demo seed's own item.note) - always "-" for real orders; the
      // per-line "Wytyczne do transportów" note is looked up client-side
      // instead (see ruleNoteFor in OrdersCipListTable.js), not sent here.
      note: "-",
    })),
  };
}

// order_items_progress (not the bare order_items table) - see that view's
// own comment: same rows, plus issued_quantity summed live off
// sm_operations, so every caller of listOrders/getOrder gets an order's
// fulfillment progress for free instead of a second round-trip once
// something (smpda's "Obsługa zamówień", smVendor's own checklist) needs
// to show it.
/// The line-wide guidelines for these destinations, as Map<line, note> -
/// one query for a whole list rather than per order (same batching as
/// itemsByOrderIds/photosByOrderIds). Looked up live, so an edited rule
/// applies to orders already placed, which is the whole point of this
/// table being reference data rather than copied onto an order.
/**
 * The guideline that rides on the order itself (not on one of its
 * materials): `item_no IS NULL`, matching this order's line, its type, or
 * both - each of those scopes is optional on a rule since 2026-10-07.
 *
 * Keyed by order id rather than by line, because two orders on the same
 * line can now get different notes when they are different kinds of
 * transport.
 *
 * **One note per order**: the most specific match wins (a rule naming both
 * a line and a type beats one naming either), newest on a tie. Showing
 * several would turn a standing instruction into a wall of text on the
 * phone screen it has to be read from.
 */
async function orderLevelRulesFor(orders) {
  const rows = orders.filter((o) => o.to_location || o.type);
  if (!rows.length) return new Map();
  const { rows: rules } = await pool.query(
    `SELECT o.id, r.note
       FROM unnest($1::bigint[], $2::text[], $3::text[]) AS o(id, line_name, type)
       JOIN LATERAL (
         SELECT lr.note
           FROM line_material_rules lr
          WHERE lr.item_no IS NULL
            AND (lr.line_name IS NULL OR lr.line_name = o.line_name)
            AND (lr.order_type IS NULL OR lr.order_type = o.type)
          -- Line first, then type: every guideline in this plant was a line
          -- guideline before types existed, and a newly added type rule must
          -- not quietly override one somebody has relied on for months.
          -- A rule naming both still beats either.
          ORDER BY (lr.line_name IS NOT NULL) DESC, (lr.order_type IS NOT NULL) DESC, lr.id DESC
          LIMIT 1
       ) r ON true`,
    [rows.map((o) => o.id), rows.map((o) => o.to_location), rows.map((o) => o.type)]
  );
  return new Map(rules.map((r) => [String(r.id), r.note]));
}

async function itemsByOrderIds(orderIds) {
  if (!orderIds.length) return new Map();
  const { rows } = await pool.query("SELECT * FROM order_items_progress WHERE order_id = ANY($1) ORDER BY item_no", [orderIds]);
  const byOrder = new Map();
  for (const row of rows) {
    if (!byOrder.has(row.order_id)) byOrder.set(row.order_id, []);
    byOrder.get(row.order_id).push(row);
  }
  return byOrder;
}

// scope: "active" (Lista zamówień - new + in_progress) or "history"
// (Historia zamówień - done + cancelled) - same split OrdersCipListTable.js
// already renders locally as STATUS_SETS, now read straight from the
// database instead. Sorted by created_at, not order_no (see schema.sql's
// own note: the random suffix means order_no doesn't sort chronologically).
// Optional paging, for the history screens that would otherwise pull every
// closed order ever on first paint: pass `limit` to get a page, then `before`
// (the last row you already have) to get the next one.
//
// **Keyset, not OFFSET.** Orders close while somebody is scrolling, which
// pushes rows down the list - with OFFSET that silently repeats or skips a
// row at every page boundary, while "everything older than this exact row"
// stays right whatever arrives above it. The cursor needs both columns
// because created_at is not unique (same-second inserts are normal here).
//
// No limit = the whole list, unchanged: wps and smpda both read it that way
// and page nothing.
export async function listOrders(scope, { limit, before, viewer } = {}) {
  const statuses = STATUS_SETS[scope];
  if (!statuses) throw new ApiError("Nieprawidłowy zakres zamówień.", 400);

  const params = [statuses];
  let where = "status = ANY($1)";
  if (before) {
    const at = new Date(before.createdAt);
    if (Number.isNaN(at.getTime()) || !/^\d+$/.test(String(before.id ?? ""))) {
      throw new ApiError("Nieprawidłowy znacznik strony.", 400);
    }
    params.push(at.toISOString(), String(before.id));
    where += ` AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`;
  }
  let sql = `SELECT * FROM orders WHERE ${where} ORDER BY created_at DESC, id DESC`;
  if (limit != null) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 200) throw new ApiError("Nieprawidłowy rozmiar strony.", 400);
    params.push(n);
    sql += ` LIMIT $${params.length}`;
  }
  const { rows: orders } = await pool.query(sql, params);
  const ids = orders.map((o) => o.id);
  const [itemsByOrder, photosByOrder, lineRules, messageCounts, unreadCounts] = await Promise.all([
    itemsByOrderIds(ids),
    photosByOrderIds(ids),
    orderLevelRulesFor(orders),
    messageCountsByOrderIds(ids),
    unreadCountsByOrderIds(ids, viewer),
  ]);
  return orders.map((o) =>
    orderRowToApi(
      o,
      itemsByOrder.get(o.id) ?? [],
      photosByOrder.get(o.id) ?? [],
      lineRules.get(String(o.id)) ?? "",
      messageCounts.get(o.id) ?? 0,
      unreadCounts.get(o.id) ?? 0
    )
  );
}

export async function getOrder(id, { viewer } = {}) {
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [id]);
  if (!rows.length) throw new ApiError("Nie znaleziono zamówienia.", 404);
  const [itemsByOrder, photosByOrder, lineRules, messageCounts, unreadCounts] = await Promise.all([
    itemsByOrderIds([rows[0].id]),
    photosByOrderIds([rows[0].id]),
    orderLevelRulesFor([rows[0]]),
    messageCountsByOrderIds([rows[0].id]),
    unreadCountsByOrderIds([rows[0].id], viewer),
  ]);
  return orderRowToApi(
    rows[0],
    itemsByOrder.get(rows[0].id) ?? [],
    photosByOrder.get(rows[0].id) ?? [],
    lineRules.get(String(rows[0].id)) ?? "",
    messageCounts.get(rows[0].id) ?? 0,
    unreadCounts.get(rows[0].id) ?? 0
  );
}

// Places people have typed that are not suggested (yet) - see
// location_candidates. Most-typed first: the one five people have written is
// the one worth promoting, and a one-off typo sinks to the bottom on its own.
export async function listLocationCandidates() {
  const { rows } = await pool.query(
    `SELECT name, times_used, created_at, last_seen_at
       FROM locations
      WHERE NOT suggested AND dismissed_at IS NULL
      ORDER BY times_used DESC, last_seen_at DESC NULLS LAST`
  );
  return rows.map((r) => ({
    name: r.name,
    timesUsed: r.times_used,
    firstSeenAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  }));
}

// "Dodaj do sugerowanych" - the candidate becomes a real place and stops
// being a candidate. Never a production line (`is_line` false): those are
// the fixed list every other order type is restricted to, and a typed place
// is not one of them.
export async function promoteLocationCandidate({ name }) {
  const typed = String(name ?? "").trim();
  if (!typed) throw new ApiError("Podaj nazwę lokalizacji.", 400);
  const { rows } = await pool.query(
    "UPDATE locations SET suggested = true, dismissed_at = NULL WHERE lower(name) = lower($1) AND NOT suggested RETURNING name",
    [typed]
  );
  if (!rows.length) throw new ApiError("Nie znaleziono takiej wpisanej lokalizacji.", 404);
  return { name: rows[0].name, promoted: true };
}

// Dismissing one - a typo, or a place nobody should be typing. **Marked, not
// deleted**: orders already placed point at it (from_location/to_location are
// foreign keys), so the row has to stay. It comes back on the list if
// somebody types it again, which is the point - the list says what is *being*
// typed, not what was once decided about it.
export async function deleteLocationCandidate(name) {
  const typed = String(name ?? "").trim();
  const { rowCount } = await pool.query(
    "UPDATE locations SET dismissed_at = now() WHERE lower(name) = lower($1) AND NOT suggested",
    [typed]
  );
  if (!rowCount) throw new ApiError("Nie znaleziono takiej wpisanej lokalizacji.", 404);
  return { dismissed: true };
}

// Every known place - the free-text "Transport półproduktów"/"skąd"·"dokąd"
// suggestion pool (LocationInput in OrdersCipListTable.js): the fixed
// production lines first, then everything else typed on an earlier
// goods_transport order, alphabetically within each group.
export async function listAllLocations() {
  // Only the suggested ones: a place somebody typed on an order lives here
  // too, but it is not offered to anybody until it is promoted (see
  // listLocationCandidates and locations.suggested).
  const { rows } = await pool.query("SELECT name FROM locations WHERE suggested ORDER BY is_line DESC, name");
  return rows.map((r) => r.name);
}

// Inserts the order and its items (material_order/spool_order only) in one
// transaction - order_items_before_write needs the parent row to already
// exist (it looks up its type), and orders_require_items (a deferred
// constraint trigger) checks at commit that a material/spool order got at
// least one, so both inserts have to land in the same transaction or neither
// sticks. `type`/`from`/`to`/`details`/`note`/`employeeNo`/`items` are the
// exact shape NewOrderPanel's onCreate already builds in
// OrdersCipListTable.js - unchanged from what used to just be pushed onto
// local state.
// How long an edit lock counts for. Short on purpose: it exists to stop a
// forklift operator taking an order mid-rewrite, and the cost of it
// expiring too early (the operator sees the order again while somebody is
// still typing) is far smaller than the cost of it never expiring (the
// order is invisible until somebody notices and fixes the row by hand).
// Every save or keep-alive pushes it out again.
const EDIT_LOCK_MINUTES = 5;

function editLockActive(row) {
  if (!row.editing_by || !row.editing_at) return false;
  if (row.status !== "new") return false;
  return Date.now() - new Date(row.editing_at).getTime() < EDIT_LOCK_MINUTES * 60_000;
}

// Reads the order and refuses unless it is still editable: only the person
// who placed it, and only before anybody started it. Shared by every edit
// entry point so the rule is stated once.
async function assertEditable(id, employeeNo) {
  const who = String(employeeNo ?? "").trim();
  if (!who) throw new ApiError("Brak numeru pracownika - zaloguj się ponownie.", 400);
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [id]);
  if (!rows.length) throw new ApiError("Nie znaleziono zamówienia.", 404);
  const row = rows[0];
  if (row.status !== "new") {
    throw new ApiError("Zamówienie jest już realizowane - nie można go zmienić.", 409);
  }
  if (row.requested_by !== who) {
    throw new ApiError("Zmienić zamówienie może tylko osoba, która je złożyła.", 403);
  }
  return row;
}

// "Edytuję" - takes the lock (or refreshes it, which is also the keep-alive
// a form open for a while sends). Returns the order as every other action
// does, so the client can show it straight away.
export async function startOrderEdit(id, { employeeNo }) {
  await assertEditable(id, employeeNo);
  const who = String(employeeNo).trim();
  const { rows } = await pool.query(
    "UPDATE orders SET editing_by = $2, editing_at = now() WHERE id = $1 RETURNING *",
    [id, who]
  );
  return withItems(rows[0]);
}

// Leaving the form - saved or abandoned. Not an error if the lock is already
// gone or somebody else's: the point is only that it is not held any more.
export async function stopOrderEdit(id, { employeeNo }) {
  const who = String(employeeNo ?? "").trim();
  const { rows } = await pool.query(
    "UPDATE orders SET editing_by = NULL, editing_at = NULL WHERE id = $1 AND (editing_by = $2 OR editing_by IS NULL) RETURNING *",
    [id, who]
  );
  if (!rows.length) {
    const { rows: now } = await pool.query("SELECT * FROM orders WHERE id = $1", [id]);
    if (!now.length) throw new ApiError("Nie znaleziono zamówienia.", 404);
    return withItems(now[0]);
  }
  return withItems(rows[0]);
}

// Saving an edit. Places, details, the note and the whole item list can
// change; the type, who ordered it, its number and when it was placed
// cannot (orders_before_update refuses those outright). Items are replaced
// wholesale rather than diffed - the form sends the list it ended up with,
// and (order_id, item_no) is the key, so a diff would be more code for the
// same result. The lock is released by the same call: saving is leaving.
export async function updateOrder(id, body) {
  const row = await assertEditable(id, body?.employeeNo);
  const from = body?.from ? String(body.from).trim() : null;
  const to = body?.to ? String(body.to).trim() : null;
  const details = detailsToDb(body?.details && typeof body.details === "object" ? body.details : {});
  const note = String(body?.note ?? "").trim();
  const items = Array.isArray(body?.items) ? body.items : [];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let updated;
    try {
      ({ rows: [updated] } = await client.query(
        `UPDATE orders SET from_location = $2, to_location = $3, details = $4, note = $5,
                editing_by = NULL, editing_at = NULL
          WHERE id = $1 RETURNING *`,
        [id, from, to, JSON.stringify(details), note]
      ));
    } catch (err) {
      // Same shape as createOrder's: a CHECK or a RAISE from the triggers is
      // the caller's input, not a server fault.
      if (err.code === "23514" || err.code === "P0001") throw new ApiError(err.message, 400);
      throw err;
    }

    await client.query("DELETE FROM order_items WHERE order_id = $1", [id]);
    for (const item of items) {
      const itemNo = String(item?.itemNo ?? "").trim();
      const quantity = String(item?.quantity ?? "").trim();
      if (!itemNo || !(parseFloat(quantity) > 0)) continue;
      try {
        await client.query(
          "INSERT INTO order_items (order_id, item_no, item_name, quantity, unit) VALUES ($1, $2, $3, $4, $5)",
          [id, itemNo, String(item?.itemName ?? "").trim(), quantity, String(item?.unit ?? "").trim()]
        );
      } catch (err) {
        if (err.code === "P0001") throw new ApiError(err.message, 400);
        throw err;
      }
    }
    // orders_require_items is DEFERRED, so a material/spool order left with
    // no items fails here, on COMMIT - which is the point: the edit is
    // refused as a whole rather than leaving the order empty.
    try {
      await client.query("COMMIT");
    } catch (err) {
      if (err.code === "23514" || err.code === "P0001") throw new ApiError(err.message, 400);
      throw err;
    }
    return withItems(updated, { refetch: true });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Deleting one's own order, again only before anybody started it. A real
// delete and not a cancellation: this is for an order placed by mistake, and
// a cancelled order would sit in "Historia" as something that happened.
// Everything hanging off it goes with it (items, photos, chat, events - all
// ON DELETE CASCADE).
export async function deleteOrder(id, { employeeNo }) {
  await assertEditable(id, employeeNo);
  await pool.query("DELETE FROM orders WHERE id = $1", [id]);
  return { deleted: true };
}

// Re-reads an order's items (and line rule) and shapes it like every other
// response. `refetch` re-reads the row too, for a caller holding one from
// before a trigger touched it.
async function withItems(row, { refetch = false } = {}) {
  let current = row;
  if (refetch) {
    const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [row.id]);
    current = rows[0] ?? row;
  }
  const [itemsByOrder, lineRules, messageCounts] = await Promise.all([
    itemsByOrderIds([current.id]),
    orderLevelRulesFor([current]),
    messageCountsByOrderIds([current.id]),
  ]);
  return orderRowToApi(
    current,
    itemsByOrder.get(current.id) ?? [],
    [],
    lineRules.get(String(current.id)) ?? "",
    messageCounts.get(current.id) ?? 0
  );
}

export async function createOrder(body) {
  const type = String(body?.type ?? "").trim();
  if (!ORDER_TYPES.includes(type)) throw new ApiError("Nieprawidłowy typ zamówienia.", 400);
  const requestedBy = String(body?.employeeNo ?? "").trim();
  if (!requestedBy) throw new ApiError("Brak numeru pracownika - zaloguj się ponownie.", 400);
  const from = body?.from ? String(body.from).trim() : null;
  const to = body?.to ? String(body.to).trim() : null;
  const details = detailsToDb(body?.details && typeof body.details === "object" ? body.details : {});
  const note = String(body?.note ?? "").trim();
  const items = Array.isArray(body?.items) ? body.items : [];
  // Unknown or absent falls back to the ordinary level rather than being
  // refused: priority is a label, and an older client that sends none must
  // still be able to place an order.
  const priority = PRIORITIES.includes(body?.priority) ? body.priority : "normal";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let row;
    try {
      ({
        rows: [row],
      } = await client.query(
        `INSERT INTO orders (type, requested_by, from_location, to_location, details, note, priority)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [type, requestedBy, from, to, JSON.stringify(details), note, priority]
      ));
    } catch (err) {
      // orders_type_fields (required fields per type) or the "must be a
      // production line"/"place to itself" RAISE EXCEPTIONs from
      // orders_before_insert - both are the caller's input, not a server
      // error, so surface the message rather than a bare 500.
      if (err.code === "23514" || err.code === "P0001") throw new ApiError(err.message, 400);
      throw err;
    }

    for (const item of items) {
      const itemNo = String(item?.itemNo ?? "").trim();
      const quantity = String(item?.quantity ?? "").trim();
      if (!itemNo || !(parseFloat(quantity) > 0)) continue;
      try {
        await client.query(
          `INSERT INTO order_items (order_id, item_no, item_name, quantity, unit) VALUES ($1, $2, $3, $4, $5)`,
          [row.id, itemNo, String(item?.itemName ?? "").trim(), quantity, String(item?.unit ?? "").trim()]
        );
      } catch (err) {
        if (err.code === "P0001") throw new ApiError(err.message, 400);
        throw err;
      }
    }

    const { rows: itemRows } = await client.query("SELECT * FROM order_items WHERE order_id = $1 ORDER BY item_no", [row.id]);
    await client.query("COMMIT");
    const lineRules = await orderLevelRulesFor([row]);
    return orderRowToApi(row, itemRows, [], lineRules.get(String(row.id)) ?? "");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// The status actions the schema's orders_before_update trigger allows (see
// schema.sql): new -> in_progress ("Weź" - a forklift operator picks it
// up), new/in_progress -> done ("Zrealizuj"), new/in_progress -> cancelled
// ("Anuluj"), in_progress -> delivered ("Dostarczone" - smVendor, once
// every item is fully issued), delivered -> done (accept, by the
// requester or autoAcceptDeliveredOrders below) or -> cancelled (the
// requester reporting a problem - see cancelOrder, reused as-is for this
// too since the DB side is the same transition either way). Timestamps and
// the fulfilling shift are filled by the trigger itself, not here - see
// that trigger's own comment.
/// `note` is the text that belongs to the event this status change
/// produces - a problem's description, a cancellation reason. It has to
/// reach orders_after_update (the trigger that writes order_events), which
/// cannot see a function argument, so it is set as a transaction-local GUC
/// and the UPDATE runs on that same connection. `set_config(..., true)`
/// makes it local to the transaction, so it cannot leak into the next
/// statement on a pooled connection.
async function setOrderStatus(id, fields, sql, note = "") {
  let row;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('wps.event_note', $1, true)", [note]);
    ({ rows: [row] } = await client.query(sql, [id, ...fields]));
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.code === "P0001") throw new ApiError(err.message, 400);
    throw err;
  } finally {
    client.release();
  }
  if (!row) throw new ApiError("Nie znaleziono zamówienia.", 404);
  const [itemsByOrder, lineRules, messageCounts] = await Promise.all([
    itemsByOrderIds([row.id]),
    orderLevelRulesFor([row]),
    messageCountsByOrderIds([row.id]),
  ]);
  return orderRowToApi(
    row,
    itemsByOrder.get(row.id) ?? [],
    [],
    lineRules.get(String(row.id)) ?? "",
    messageCounts.get(row.id) ?? 0
  );
}

// "Rozpocznij zadanie" - new -> in_progress, and **only** from new.
//
// The `AND status = 'new'` is what makes two operators pressing it at the
// same moment safe. Without it the second UPDATE still matched (the row is
// found by id), and because in_progress -> in_progress is not a status
// change it slipped past the transition guard entirely: the later writer
// silently took over `taken_by` while order_events still credited the
// first. Both phones then showed the order as theirs. Now the loser is told
// who has it instead.
//
// The status is also read before the update, purely so the common case -
// pressing a card that somebody took a minute ago - gets the same clear
// message without relying on a failed update to produce it.
export async function takeOrder(id, { takenBy }) {
  const by = String(takenBy ?? "").trim();
  if (!by) throw new ApiError("Brak numeru pracownika - zaloguj się ponownie.", 400);

  const taken = (row) =>
    new ApiError(
      row.taken_by ? `Zamówienie przyjął już ${row.taken_by}.` : "Zamówienie jest już realizowane.",
      409
    );

  const { rows: before } = await pool.query("SELECT * FROM orders WHERE id = $1", [id]);
  if (!before.length) throw new ApiError("Nie znaleziono zamówienia.", 404);
  if (before[0].status !== "new") throw taken(before[0]);
  // Being rewritten right now - the queue hides it, and this is the same
  // rule enforced for a client that did not notice (see editLockActive).
  if (editLockActive(before[0])) {
    throw new ApiError("Zamawiający właśnie zmienia to zamówienie.", 409);
  }

  try {
    return await setOrderStatus(
      id,
      [by],
      "UPDATE orders SET status = 'in_progress', taken_by = $2 WHERE id = $1 AND status = 'new' RETURNING *"
    );
  } catch (err) {
    // Lost the race in the gap between the read above and the update: the
    // guarded UPDATE matched nothing, which setOrderStatus reports as "not
    // found". Say what actually happened.
    if (err instanceof ApiError && err.status === 404) {
      const { rows: now } = await pool.query("SELECT status, taken_by FROM orders WHERE id = $1", [id]);
      if (now.length && now[0].status !== "new") throw taken(now[0]);
    }
    throw err;
  }
}

export async function completeOrder(id, { completedBy }) {
  const by = String(completedBy ?? "").trim();
  if (!by) throw new ApiError("Brak numeru pracownika - zaloguj się ponownie.", 400);
  return setOrderStatus(id, [by], "UPDATE orders SET status = 'done', completed_by = $2 WHERE id = $1 RETURNING *");
}

// "Anuluj" - only ever a **not-yet-started** order (`new -> cancelled`),
// e.g. one placed by mistake. The moment a forklift operator takes it, the
// only ways out are completion or the problem loop: a transport somebody is
// already carrying must not be able to vanish from under them, and a
// problem is explicitly not a cancellation. The transition guard in
// schema.sql refuses it too, so this check is the readable error rather
// than the only line of defence.
export async function cancelOrder(id, { reason }) {
  const text = String(reason ?? "").trim();
  const { rows } = await pool.query("SELECT status FROM orders WHERE id = $1", [id]);
  if (!rows.length) throw new ApiError("Nie znaleziono zamówienia.", 404);
  if (rows[0].status !== "new") {
    throw new ApiError(
      rows[0].status === "done" || rows[0].status === "cancelled"
        ? "Zamówienie jest już zamknięte."
        : "Zamówienia w realizacji nie można anulować - zgłoś problem.",
      400
    );
  }
  return setOrderStatus(
    id,
    [text || null],
    "UPDATE orders SET status = 'cancelled', cancel_reason = $2 WHERE id = $1 RETURNING *",
    text
  );
}

// "Zgłoś problem" from the forklift operator *while fulfilling*
// (in_progress -> problem). The order is deliberately **not** cancelled: it
// stays open, waiting for the requester to deal with whatever is wrong and
// mark it resolved (see resolveOrderProblem). The description is kept both
// on the row - so "what is wrong right now" is one field away - and in
// order_events, so an earlier problem is not overwritten by a later one.
export async function reportOrderProblem(id, { reportedBy, note }) {
  const by = String(reportedBy ?? "").trim();
  if (!by) throw new ApiError("Brak numeru pracownika - zaloguj się ponownie.", 400);
  const text = String(note ?? "").trim();
  if (!text) throw new ApiError("Opisz, na czym polega problem.", 400);
  // `problem_reported_from = status` reads the row's **old** status (an
  // UPDATE's right-hand side always does), which is exactly what is wanted:
  // it records whether this came from in_progress (the operator is stuck -
  // the requester answers) or from delivered (the requester rejects what
  // arrived - the operator answers). The before-update trigger clears
  // delivered_at/_by when entering 'problem', so a disputed delivery is
  // un-delivered and the auto-accept sweep can no longer close it.
  return setOrderStatus(
    id,
    [text, by],
    `UPDATE orders SET status = 'problem', problem_note = $2, problem_reported_by = $3, problem_reported_at = now(),
            problem_reported_from = status, problem_resolved_at = NULL, problem_resolved_by = NULL
      WHERE id = $1 RETURNING *`,
    text
  );
}

// "Problem rozwiązany" (problem -> in_progress), pressed by **whichever
// side the problem was reported to** (see problem_reported_from): the
// requester answering a stuck operator, or the operator answering a
// rejected delivery. Either way the work carries on from in_progress - a
// rejected delivery therefore has to be delivered again, which is the
// point. The note is kept for the timeline; the row's own problem_note is
// cleared, because it answers "what is blocking this now" and nothing is.
export async function resolveOrderProblem(id, { resolvedBy, note }) {
  const by = String(resolvedBy ?? "").trim();
  if (!by) throw new ApiError("Brak numeru pracownika - zaloguj się ponownie.", 400);
  const text = String(note ?? "").trim();
  return setOrderStatus(
    id,
    [by],
    `UPDATE orders SET status = 'in_progress', problem_note = '', problem_reported_from = '',
            problem_resolved_by = $2, problem_resolved_at = now()
      WHERE id = $1 RETURNING *`,
    text
  );
}

// The chat on one order, oldest first (see order_messages). `afterId` is
// how the clients stay current without re-reading the thread: they poll
// every second with the last id they hold, which is an empty array almost
// every time and one row when somebody has just said something. That is
// what makes it feel immediate without a socket - and a dropped poll on
// warehouse Wi-Fi costs one second, not a reconnect.
export async function listOrderMessages(id, { afterId } = {}) {
  const params = [id];
  let where = "order_id = $1";
  if (afterId != null && String(afterId).trim() !== "") {
    if (!/^\d+$/.test(String(afterId))) throw new ApiError("Nieprawidłowy znacznik wiadomości.", 400);
    params.push(String(afterId));
    where += ` AND id > $${params.length}::bigint`;
  }
  const { rows } = await pool.query(
    `SELECT id, author, body, at FROM order_messages WHERE ${where} ORDER BY id LIMIT 500`,
    params
  );
  return rows.map((r) => ({ id: String(r.id), author: r.author, body: r.body, at: r.at }));
}

// Posting one. The order has to exist (a message with nothing to belong to
// is a client bug, and the FK would fail with a 23503 nobody can read), but
// its status is deliberately not checked: people carry on explaining things
// after an order closes, and a chat is not a state change.
export async function createOrderMessage(id, { author, body }) {
  const who = String(author ?? "").trim();
  if (!who) throw new ApiError("Brak numeru pracownika - zaloguj się ponownie.", 400);
  const text = String(body ?? "").trim();
  if (!text) throw new ApiError("Wiadomość jest pusta.", 400);
  if (text.length > 2000) throw new ApiError("Wiadomość jest za długa.", 400);
  const { rows: order } = await pool.query("SELECT id FROM orders WHERE id = $1", [id]);
  if (!order.length) throw new ApiError("Nie znaleziono zamówienia.", 404);
  const { rows } = await pool.query(
    "INSERT INTO order_messages (order_id, author, body) VALUES ($1, $2, $3) RETURNING id, author, body, at",
    [id, who, text]
  );
  const r = rows[0];
  return { id: String(r.id), author: r.author, body: r.body, at: r.at };
}

// How many messages each of these orders has, for the list payload - so a
// "Czat" button can say there is something to read without every client
// fetching every thread.
async function messageCountsByOrderIds(ids) {
  if (!ids.length) return new Map();
  const { rows } = await pool.query(
    "SELECT order_id, count(*)::int AS n FROM order_messages WHERE order_id = ANY($1) GROUP BY order_id",
    [ids]
  );
  return new Map(rows.map((r) => [r.order_id, r.n]));
}

// How many messages are new **for one person**: newer than their own read
// mark (order_message_reads) and not written by them. Their own messages are
// excluded deliberately - a badge that counts what you just said yourself is
// noise, and it would never clear until you re-opened the thread.
//
// `viewer` is an employee number the client sends as ?viewer=; with none
// (wps, or any caller that has no single person behind it) this is empty and
// every unreadCount is 0.
async function unreadCountsByOrderIds(ids, viewer) {
  const who = String(viewer ?? "").trim();
  if (!ids.length || !who) return new Map();
  const { rows } = await pool.query(
    `SELECT m.order_id, count(*)::int AS n
       FROM order_messages m
       LEFT JOIN order_message_reads r ON r.order_id = m.order_id AND r.employee_no = $2
      WHERE m.order_id = ANY($1)
        AND m.author <> $2
        AND m.id > COALESCE(r.last_read_id, 0)
      GROUP BY m.order_id`,
    [ids, who]
  );
  return new Map(rows.map((r) => [r.order_id, r.n]));
}

// "I have read up to here", sent by the chat screen as it shows messages.
// GREATEST so a late-arriving call from a screen that was behind can never
// move the mark backwards and resurrect messages as unread.
export async function markOrderMessagesRead(id, { employeeNo, lastReadId }) {
  const who = String(employeeNo ?? "").trim();
  if (!who) throw new ApiError("Brak numeru pracownika - zaloguj się ponownie.", 400);
  if (!/^\d+$/.test(String(lastReadId ?? ""))) throw new ApiError("Nieprawidłowy znacznik wiadomości.", 400);
  const { rows } = await pool.query(
    `INSERT INTO order_message_reads (order_id, employee_no, last_read_id)
     VALUES ($1, $2, $3::bigint)
     ON CONFLICT (order_id, employee_no)
       DO UPDATE SET last_read_id = GREATEST(order_message_reads.last_read_id, EXCLUDED.last_read_id), at = now()
     RETURNING last_read_id`,
    [id, who, String(lastReadId)]
  );
  return { lastReadId: String(rows[0].last_read_id) };
}

/// Everything that ever happened to an order, oldest first - what makes the
/// whole episode reconstructible (see order_events in schema.sql).
export async function listOrderEvents(id) {
  const { rows } = await pool.query(
    "SELECT kind, actor, note, at FROM order_events WHERE order_id = $1 ORDER BY at, id",
    [id]
  );
  return rows.map((r) => ({
    kind: STATUS_TO_API[r.kind] ?? r.kind,
    actor: r.actor,
    note: r.note,
    at: r.at,
  }));
}

// "Dostarczone" (smVendor) - in_progress -> delivered. Re-checks server-side
// that every order_item is actually fully issued (order_items_progress)
// rather than trusting the client's own checklist state - a client that's
// gone stale (another PDA issued the last item a moment ago and this
// client hasn't polled yet) must not be able to mark delivery early.
export async function deliverOrder(id, { deliveredBy }) {
  const by = String(deliveredBy ?? "").trim();
  if (!by) throw new ApiError("Brak numeru pracownika - zaloguj się ponownie.", 400);
  const { rows: items } = await pool.query("SELECT * FROM order_items_progress WHERE order_id = $1", [id]);
  // An order with no items (water_refill, goods_transport, waste_removal,
  // warehouse_return) is deliverable as soon as it is taken - there is
  // nothing to issue, the forklift operator just does it and says so. This
  // used to be refused outright, which left those four types with no
  // delivery step at all, and therefore no confirmation from the person who
  // ordered them: they could only be closed from wps. Every type goes
  // through the same delivered -> confirm/report-problem path now.
  // Issued **at least once** per line, not "issued up to the ordered
  // amount": see order_items_progress.issue_count. The old comparison was
  // between a piece count and a weight, so an order could be impossible to
  // deliver however much was issued.
  const unfulfilled = items.filter((i) => Number(i.issue_count ?? 0) === 0);
  if (unfulfilled.length) {
    throw new ApiError(`Nie wszystkie pozycje zostały wydane (brakuje: ${unfulfilled.map((i) => i.item_no).join(", ")}).`, 400);
  }
  return setOrderStatus(id, [by], "UPDATE orders SET status = 'delivered', delivered_by = $2 WHERE id = $1 RETURNING *");
}

// The requester's "Akceptuj" - delivered -> done. No UI calls this yet (see
// AGENTS.md roadmap) - built ahead of it so the 10-minute window/auto-accept
// below has something real to race against once that UI exists.
export async function acceptOrder(id, { acceptedBy }) {
  const by = String(acceptedBy ?? "").trim();
  if (!by) throw new ApiError("Brak numeru pracownika - zaloguj się ponownie.", 400);
  return setOrderStatus(id, [by, by], "UPDATE orders SET status = 'done', completed_by = $2, accepted_by = $3 WHERE id = $1 RETURNING *");
}

// Swept periodically (see startAutoAcceptSweep) - a delivered order nobody
// accepted or reported a problem on within AUTO_ACCEPT_MINUTES closes
// itself, completed_by/accepted_by = 'auto' so it's plainly distinguishable
// from a real person's employee number in the history/audit trail.
const AUTO_ACCEPT_MINUTES = 10;

// How long a delivered order still has, in seconds, measured against this
// server's own clock - what orderRowToApi sends as `autoAcceptInSeconds`
// (see its comment for why a remaining duration and not a deadline). Floors
// at 0: the sweep only runs once a minute, so "overdue but not yet closed"
// is a normal state and reads as 0:00 rather than a negative number. A
// `function` declaration on purpose - it is hoisted, so orderRowToApi can
// call it from further up the file.
function autoAcceptSecondsLeft(deliveredAt) {
  const deadline = new Date(deliveredAt).getTime() + AUTO_ACCEPT_MINUTES * 60_000;
  return Math.max(0, Math.round((deadline - Date.now()) / 1000));
}

// A "Transport półproduktów" (goods_transport) cannot be marked delivered
// for the first MIN_RUN_SECONDS after it was taken. It is the one type with
// nothing to issue *and* a real distance to cover, so it is otherwise
// takeable and deliverable in the same second - which records a transport
// that cannot have happened. Every other type either has items to issue
// first or is a short job at one place.
//
// A display-only wait: it disables the button in smVendor rather than being
// refused server-side, so an operator is never stuck with work done and no
// way to report it.
const MIN_RUN_SECONDS = 30;

function minRunSecondsLeft(takenAt) {
  const deadline = new Date(takenAt).getTime() + MIN_RUN_SECONDS * 1000;
  return Math.max(0, Math.round((deadline - Date.now()) / 1000));
}

export async function autoAcceptDeliveredOrders() {
  const { rows } = await pool.query(
    `UPDATE orders SET status = 'done', completed_by = 'auto', accepted_by = 'auto'
     WHERE status = 'delivered' AND delivered_at < now() - ($1 || ' minutes')::interval
     RETURNING id, order_no`,
    [AUTO_ACCEPT_MINUTES]
  );
  return rows;
}

// Called once from app.js at server startup. A plain in-process interval
// (this app is one Node process on one machine - see AGENTS.md's own
// "Project context" - no pg_cron/external scheduler needed for a check this
// cheap). Runs immediately once too, so an order already overdue when the
// server restarts doesn't wait a full CHECK_INTERVAL to be caught.
const CHECK_INTERVAL_MS = 60_000;

export function startAutoAcceptSweep() {
  const sweep = () =>
    autoAcceptDeliveredOrders()
      .then((rows) => {
        if (rows.length) console.log(`[orders] auto-accepted ${rows.length} order(s): ${rows.map((r) => r.order_no).join(", ")}`);
      })
      .catch((err) => console.error("[orders] auto-accept sweep failed:", err));
  sweep();
  setInterval(sweep, CHECK_INTERVAL_MS);
}
