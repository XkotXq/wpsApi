import { pool } from "./db.js";

// "Historia logowania" (wps's Zamówienia/Transporty nav) - see schema.sql's
// login_events comment: which forklift ("wózek") a PDA login happened on,
// written from routes/auth.js whenever the login carried a deviceLabel.

function rowToApi(row) {
  return {
    id: String(row.id),
    employeeNo: row.employee_no,
    deviceLabel: row.device_label,
    loggedInAt: row.logged_in_at,
  };
}

const HISTORY_LIMIT = 200;

export async function listLoginEvents(limit) {
  const capped = Math.min(Number(limit) || HISTORY_LIMIT, HISTORY_LIMIT);
  const { rows } = await pool.query("SELECT * FROM login_events ORDER BY logged_in_at DESC LIMIT $1", [capped]);
  return rows.map(rowToApi);
}

// Called from routes/auth.js right after a successful login - never throws
// into the caller's own response: a login itself must not fail just because
// this one audit insert did (see that route's own try/catch around this).
export async function createLoginEvent({ employeeNo, deviceLabel }) {
  const employee = String(employeeNo ?? "").trim();
  const device = String(deviceLabel ?? "").trim();
  if (!employee || !device) return;
  await pool.query("INSERT INTO login_events (employee_no, device_label) VALUES ($1, $2)", [employee, device]);
}
