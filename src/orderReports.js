import { pool } from "./db.js";

// "Raporty" under Transporty in wps: how a shift's transport work actually
// went. Everything here is read-only aggregation over `orders` and
// `order_events` - no new tables, and nothing is written back, so a report
// can never be the reason a number changed.
//
// **A shift is credited at the moment of delivery**, not of acceptance.
// `orders.completed_shift_code` exists and is tempting, but the trigger
// sets it when the order reaches `done` - i.e. when the *requester* (or the
// 10-minute auto-accept) gets round to confirming, which is routinely after
// the operator's shift ended. Crediting the operator for work the next
// shift happened to be on duty for would make the report useless for the
// one thing it is for. So the shift comes from `order_shift(delivered_at)`,
// computed here, and an order still waiting to be confirmed at the end of a
// shift counts for the shift that delivered it.
//
// A delivery that was rejected has no `delivered_at` any more (entering
// `problem` clears it - see schema.sql), so it is not counted until it is
// re-delivered and stands. That is the honest reading: the work counts when
// it holds.

/** Seconds between two timestamp columns, as a median and a mean. */
function durationStats(alias, from, to) {
  const seconds = `EXTRACT(EPOCH FROM (${to} - ${from}))`;
  return `
    percentile_cont(0.5) WITHIN GROUP (ORDER BY ${seconds})
      FILTER (WHERE ${from} IS NOT NULL AND ${to} IS NOT NULL) AS ${alias}_median,
    avg(${seconds}) FILTER (WHERE ${from} IS NOT NULL AND ${to} IS NOT NULL) AS ${alias}_avg,
    count(*) FILTER (WHERE ${from} IS NOT NULL AND ${to} IS NOT NULL) AS ${alias}_n`;
}

const round = (value) => (value === null || value === undefined ? null : Math.round(Number(value)));

/**
 * One period's transport work, split by shift and by the operator who
 * delivered it.
 *
 * `from`/`to` are dates (inclusive/exclusive) in the plant's own timezone -
 * the same Europe/Warsaw the shift function uses, so "5 October" means the
 * day the shift started, not a UTC window that cuts shift C in half.
 */
export async function shiftReport({ from, to }) {
  // Delivered work, with the shift that delivered it.
  const delivered = await pool.query(
    `WITH d AS (
       SELECT o.id, o.type, o.to_location, o.delivered_by, o.delivered_at,
              o.created_at, o.taken_at, o.accepted_at, o.status,
              s.shift_code, s.shift_date
         FROM orders o,
              LATERAL order_shift(o.delivered_at) s
        WHERE o.delivered_at IS NOT NULL
          AND o.delivered_at >= $1::date AT TIME ZONE 'Europe/Warsaw'
          AND o.delivered_at <  ($2::date + 1) AT TIME ZONE 'Europe/Warsaw'
     )
     SELECT shift_code,
            coalesce(nullif(delivered_by, ''), '-') AS operator,
            count(*)::int AS delivered,
            -- Still on the requester's desk at the time of the report: the
            -- work is done, the paperwork is not.
            count(*) FILTER (WHERE status = 'delivered')::int AS awaiting_accept,
            ${durationStats("reaction", "created_at", "taken_at")},
            ${durationStats("haul", "taken_at", "delivered_at")},
            ${durationStats("confirm", "delivered_at", "accepted_at")}
       FROM d
      GROUP BY shift_code, operator
      ORDER BY shift_code, operator`,
    [from, to]
  );

  // Problems, counted per shift from the audit trail rather than from the
  // current status: an order that hit a problem and was put right is still
  // an order that hit a problem, and `status` no longer says so.
  const problems = await pool.query(
    `SELECT s.shift_code, count(DISTINCT e.order_id)::int AS orders_with_problem
       FROM order_events e
       JOIN orders o ON o.id = e.order_id,
            LATERAL order_shift(e.at) s
      WHERE e.kind = 'problem'
        AND e.at >= $1::date AT TIME ZONE 'Europe/Warsaw'
        AND e.at <  ($2::date + 1) AT TIME ZONE 'Europe/Warsaw'
      GROUP BY s.shift_code`,
    [from, to]
  );

  // Cancellations have no delivery to be credited for, so they are counted
  // against the shift that **placed** the order (orders.shift_code, set at
  // insert): this is demand that evaporated, which belongs to the shift
  // that raised it.
  const cancelled = await pool.query(
    `SELECT shift_code, count(*)::int AS cancelled
       FROM orders
      WHERE status = 'cancelled'
        AND cancelled_at IS NOT NULL
        AND cancelled_at >= $1::date AT TIME ZONE 'Europe/Warsaw'
        AND cancelled_at <  ($2::date + 1) AT TIME ZONE 'Europe/Warsaw'
      GROUP BY shift_code`,
    [from, to]
  );

  // What the work was, and where it went. Both over delivered orders, so
  // they add up to the same total as the shift table above.
  const byType = await pool.query(
    `SELECT o.type, count(*)::int AS delivered
       FROM orders o
      WHERE o.delivered_at IS NOT NULL
        AND o.delivered_at >= $1::date AT TIME ZONE 'Europe/Warsaw'
        AND o.delivered_at <  ($2::date + 1) AT TIME ZONE 'Europe/Warsaw'
      GROUP BY o.type
      ORDER BY delivered DESC`,
    [from, to]
  );

  const byLine = await pool.query(
    `SELECT coalesce(o.to_location, o.from_location) AS place, count(*)::int AS delivered
       FROM orders o
      WHERE o.delivered_at IS NOT NULL
        AND coalesce(o.to_location, o.from_location) IS NOT NULL
        AND o.delivered_at >= $1::date AT TIME ZONE 'Europe/Warsaw'
        AND o.delivered_at <  ($2::date + 1) AT TIME ZONE 'Europe/Warsaw'
      GROUP BY place
      ORDER BY delivered DESC
      LIMIT 12`,
    [from, to]
  );

  const problemByShift = new Map(problems.rows.map((r) => [r.shift_code, r.orders_with_problem]));
  const cancelledByShift = new Map(cancelled.rows.map((r) => [r.shift_code, r.cancelled]));

  // Every shift the plant runs, present whether or not it delivered
  // anything: a shift with nothing on it is a finding, not a row to hide.
  const shiftCodes = (await pool.query(`SELECT code FROM shifts ORDER BY code`)).rows.map((r) => r.code);

  const shifts = shiftCodes.map((code) => {
    const rows = delivered.rows.filter((r) => r.shift_code === code);
    const total = rows.reduce((sum, r) => sum + r.delivered, 0);
    return {
      code,
      delivered: total,
      awaitingAccept: rows.reduce((sum, r) => sum + r.awaiting_accept, 0),
      ordersWithProblem: problemByShift.get(code) ?? 0,
      cancelled: cancelledByShift.get(code) ?? 0,
      // The split the report exists for: within one shift the operators'
      // shares add up to 100, however many of them were on (often two,
      // sometimes one).
      operators: rows
        .map((r) => ({
          employeeNo: r.operator,
          delivered: r.delivered,
          sharePercent: total === 0 ? 0 : Math.round((r.delivered / total) * 1000) / 10,
          reactionMedianSeconds: round(r.reaction_median),
          haulMedianSeconds: round(r.haul_median),
        }))
        .sort((a, b) => b.delivered - a.delivered),
      reactionMedianSeconds: round(median(rows, "reaction_median", "reaction_n")),
      haulMedianSeconds: round(median(rows, "haul_median", "haul_n")),
      confirmMedianSeconds: round(median(rows, "confirm_median", "confirm_n")),
    };
  });

  const grandTotal = shifts.reduce((sum, s) => sum + s.delivered, 0);
  for (const shift of shifts) {
    // A shift's share of the whole period, which is a different question
    // from an operator's share of their shift.
    shift.sharePercent = grandTotal === 0 ? 0 : Math.round((shift.delivered / grandTotal) * 1000) / 10;
  }

  return {
    from,
    to,
    delivered: grandTotal,
    shifts,
    types: byType.rows.map((r) => ({ type: r.type, delivered: r.delivered })),
    places: byLine.rows.map((r) => ({ place: r.place, delivered: r.delivered })),
  };
}

/**
 * A shift's median across its operators' rows. Weighted by how many orders
 * each row covers rather than averaging two medians flat, which would let
 * an operator who delivered one order swing the shift's number as hard as
 * one who delivered twenty.
 */
function median(rows, valueKey, countKey) {
  const usable = rows.filter((r) => r[valueKey] !== null && Number(r[countKey]) > 0);
  if (usable.length === 0) return null;
  const weight = usable.reduce((sum, r) => sum + Number(r[countKey]), 0);
  const total = usable.reduce((sum, r) => sum + Number(r[valueKey]) * Number(r[countKey]), 0);
  return total / weight;
}
