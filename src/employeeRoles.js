import { pool } from "./db.js";
import { ApiError } from "./errors.js";

// Who is who, by employee number - the local role-mapping table roadmap
// step 1 needs ("Per-user auth" in AGENTS.md: after a CIP login wpsApi
// issues its own token carrying the employee number from CIP plus a role
// from here).
//
// **Nothing is enforced yet.** There is still one shared API_TOKEN and no
// per-user check anywhere, so a role set here changes no behaviour today -
// it is the mapping that has to exist before the tokens can carry it, and a
// list somebody can fill in now rather than on the day auth lands.
// Whatever reads it later must treat an employee with no row as having no
// role, not as having every role.
//
// Roles are named after the job, one per person. **There is only one of
// them right now** (asked 2026-10-15):
//   forklift   - the operator carrying the transports (smVendor)
// Everything else is **no role**, and that is the absence of a row rather
// than a role named "none": the screen's empty option calls
// `deleteEmployeeRole`, and `upsertEmployeeRole` refuses "" like any other
// value not on this list. So "no role" needs nothing here to exist, which
// is also what makes it the safe default for whatever enforces roles later
// - an employee with no row has no role, never every role.
//
// Dropped here, not deleted from the world: `supervisor` (wps),
// `orderer` (smOrder), `warehouse` (smpda) and `test` (an account for
// trying the apps out, asked for 2026-10-12) were all on this list until
// 2026-10-15. Nothing enforced any of them, so narrowing it costs no
// behaviour - and the screen offering four roles nobody hands out reads
// as a decision somebody has made about who may do what, which is
// exactly what it was not.
//
// **The database's CHECK still allows all five** (`employee_roles` in
// schema.sql) and is deliberately left alone: it is a backstop against
// garbage, not the catalogue, and tightening it would refuse rows that
// already exist. This list is the one thing that decides what may be
// handed out, because the route and the screen both read it.
export const EMPLOYEE_ROLES = ["forklift"];

function rowToApi(row) {
  return {
    employeeNo: row.employee_no,
    role: row.role,
    // Free text for whatever the role does not say - a stand-in on another
    // shift, which area somebody covers. Empty for the ordinary case.
    note: row.note ?? "",
    updatedAt: row.updated_at,
    updatedBy: row.updated_by ?? "",
    // How many times this employee number has logged in to any of the apps,
    // and when it was last seen - so the screen can tell a real person from
    // a typo without anybody maintaining a second list of employees.
    loginCount: Number(row.login_count ?? 0),
    lastLoginAt: row.last_login_at,
  };
}

const LIST_SQL = `
  SELECT r.*,
         (SELECT count(*) FROM login_events e WHERE e.employee_no = r.employee_no) AS login_count,
         (SELECT max(e.logged_in_at) FROM login_events e WHERE e.employee_no = r.employee_no) AS last_login_at
    FROM employee_roles r`;

export async function listEmployeeRoles() {
  const { rows } = await pool.query(`${LIST_SQL} ORDER BY r.role, r.employee_no`);
  return rows.map(rowToApi);
}

/**
 * Everybody who has ever logged in, with the role they have been given (or
 * none). This is the list the screen offers to pick from: `login_events` is
 * the only record of who exists at all - there is no employee table, and CIP
 * is not asked for one.
 */
export async function listKnownEmployees() {
  const { rows } = await pool.query(
    `SELECT e.employee_no,
            count(*) AS login_count,
            max(e.logged_in_at) AS last_login_at,
            r.role,
            r.note
       FROM login_events e
       LEFT JOIN employee_roles r ON r.employee_no = e.employee_no
      GROUP BY e.employee_no, r.role, r.note
      ORDER BY max(e.logged_in_at) DESC`
  );
  return rows.map((row) => ({
    employeeNo: row.employee_no,
    role: row.role ?? "",
    note: row.note ?? "",
    loginCount: Number(row.login_count ?? 0),
    lastLoginAt: row.last_login_at,
  }));
}

export async function upsertEmployeeRole({ employeeNo, role, note, updatedBy }) {
  const who = String(employeeNo ?? "").trim();
  if (!who) throw new ApiError("Podaj numer pracownika.", 400);
  if (!EMPLOYEE_ROLES.includes(role)) throw new ApiError("Nieprawidłowa rola.", 400);

  const { rows } = await pool.query(
    `INSERT INTO employee_roles (employee_no, role, note, updated_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (employee_no) DO UPDATE
       SET role = EXCLUDED.role,
           note = EXCLUDED.note,
           updated_at = now(),
           updated_by = EXCLUDED.updated_by
     RETURNING employee_no`,
    [who, role, String(note ?? "").trim(), String(updatedBy ?? "").trim()]
  );

  const { rows: full } = await pool.query(`${LIST_SQL} WHERE r.employee_no = $1`, [rows[0].employee_no]);
  return rowToApi(full[0]);
}

export async function deleteEmployeeRole(employeeNo) {
  const who = String(employeeNo ?? "").trim();
  const { rowCount } = await pool.query(`DELETE FROM employee_roles WHERE employee_no = $1`, [who]);
  if (rowCount === 0) throw new ApiError("Nie ma takiego przypisania.", 404);
  return { ok: true };
}
