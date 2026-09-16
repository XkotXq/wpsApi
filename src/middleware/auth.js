import { timingSafeEqual } from "node:crypto";

// Single shared bearer token, checked against API_TOKEN. This is an
// internal warehouse tool used by a handful of people from one location,
// not a public multi-tenant app, so a full user/account system would be
// overkill — see README.md for the reasoning.
function tokensMatch(token, expected) {
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch instead of returning
  // false, and checking the length first would itself leak timing info —
  // pad both to the same length so the comparison always runs, then also
  // require the real lengths matched.
  const length = Math.max(a.length, b.length, 1);
  const paddedA = Buffer.alloc(length);
  const paddedB = Buffer.alloc(length);
  a.copy(paddedA);
  b.copy(paddedB);
  return a.length === b.length && timingSafeEqual(paddedA, paddedB);
}

// Dev-only escape hatch for testing against a running server without
// wiring up a matching API_TOKEN on the caller's side yet (e.g. the wps
// dashboard hitting a fresh 401 while its own token isn't set/synced) -
// mirrors wps's own SKIP_CIP_AUTH pattern (see its AGENTS.md): gated on
// NODE_ENV so it can never silently accept every request in a real
// deployment, even if SKIP_API_AUTH ends up left "true" in an env file.
const SKIP_API_AUTH = process.env.SKIP_API_AUTH === "true" && process.env.NODE_ENV !== "production";

export function requireAuth(req, res, next) {
  if (SKIP_API_AUTH) return next();
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token || !process.env.API_TOKEN || !tokensMatch(token, process.env.API_TOKEN)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}
