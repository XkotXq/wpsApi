// Single shared bearer token, checked against API_TOKEN. This is an
// internal warehouse tool used by a handful of people from one location,
// not a public multi-tenant app, so a full user/account system would be
// overkill - see README.md for the reasoning.
export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token || token !== process.env.API_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}
