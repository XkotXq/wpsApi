import { toApiError } from "./errors.js";

// Wraps an async Express handler so a thrown/rejected error reaches the
// error middleware instead of crashing the process (Express 5 already
// does this for async handlers, but being explicit keeps the intent
// obvious and works the same on Express 4 if that's ever downgraded).
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function errorMiddleware(err, req, res, next) {
  const apiErr = toApiError(err);
  if (!apiErr.status) console.error(err);
  const status = apiErr.status || 500;
  res.status(status).json({
    error: status >= 500 ? "Błąd serwera." : apiErr.message,
    data: apiErr.data ?? undefined,
  });
}
