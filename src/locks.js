import { pool } from "./db.js";
import { ApiError } from "./errors.js";

function ttlSeconds() {
  return Number(process.env.LOCK_TTL_SECONDS) || 45;
}

function ageSeconds(lockedAt) {
  return (Date.now() - new Date(lockedAt).getTime()) / 1000;
}

// Read-only status check - used for polling so other viewers know whether
// a category is currently locked for editing by someone else.
export async function getLockStatus(materialKey) {
  const { rows } = await pool.query("SELECT * FROM category_locks WHERE material = $1", [materialKey]);
  const lock = rows[0];
  if (!lock || ageSeconds(lock.locked_at) > ttlSeconds()) return { locked: false };
  return {
    locked: true,
    lockedBy: lock.locked_by,
    lockedAt: lock.locked_at,
    expiresInSeconds: Math.max(0, ttlSeconds() - ageSeconds(lock.locked_at)),
  };
}

// Acquires (or renews, if we already own it) the lock for a material.
// Throws 409 if someone else holds a non-expired lock.
export async function acquireLock(materialKey, clientId) {
  if (!clientId) throw new ApiError("Wymagane clientId.", 400);
  const { rows } = await pool.query("SELECT * FROM category_locks WHERE material = $1", [materialKey]);
  const lock = rows[0];
  if (lock && lock.locked_by !== clientId && ageSeconds(lock.locked_at) <= ttlSeconds()) {
    throw new ApiError("Kategoria jest właśnie edytowana przez kogoś innego.", 409, { lockedBy: lock.locked_by });
  }
  await pool.query(
    `INSERT INTO category_locks (material, locked_by, locked_at) VALUES ($1, $2, now())
     ON CONFLICT (material) DO UPDATE SET locked_by = $2, locked_at = now()`,
    [materialKey, clientId]
  );
  return { locked: true, lockedBy: clientId };
}

// Renews an already-held lock so it doesn't expire while someone is still
// actively editing - call this periodically while a category is open.
export async function heartbeatLock(materialKey, clientId) {
  const { rows } = await pool.query("SELECT * FROM category_locks WHERE material = $1", [materialKey]);
  const lock = rows[0];
  if (!lock || lock.locked_by !== clientId) throw new ApiError("Nie posiadasz blokady tej kategorii.", 409);
  await pool.query("UPDATE category_locks SET locked_at = now() WHERE material = $1", [materialKey]);
  return { locked: true, lockedBy: clientId };
}

export async function releaseLock(materialKey, clientId) {
  await pool.query("DELETE FROM category_locks WHERE material = $1 AND locked_by = $2", [materialKey, clientId]);
  return { locked: false };
}
