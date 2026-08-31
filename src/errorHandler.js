import { ApiError } from "./errors.js";

export function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message, ...(err.data || {}) });
  }
  console.error(err);
  res.status(500).json({ error: "Błąd serwera." });
}
