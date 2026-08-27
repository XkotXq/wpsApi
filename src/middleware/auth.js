import { ApiError } from "../errors.js";

// Simple bearer-token check — same scheme as before: one shared secret
// (API_TOKEN) baked into whatever frontend calls this API.
export function auth(req, res, next) {
  if (req.path === "/health") return next();

  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!process.env.API_TOKEN || token !== process.env.API_TOKEN) {
    return next(new ApiError("Brak autoryzacji.", 401));
  }
  next();
}
