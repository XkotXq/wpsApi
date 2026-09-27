import fs from "node:fs";
import path from "node:path";
import { ApiError } from "./errors.js";

// Unexpected errors (anything that isn't an ApiError - those are answered with
// their own message and are not logged) also go to logs/errors.log, so what
// caused a bare "Błąd serwera." can be read afterwards even when the server
// was started from a terminal nobody is looking at. Best effort: a logging
// failure must never turn into another error.
const LOG_DIR = path.resolve("logs");
const LOG_FILE = path.join(LOG_DIR, "errors.log");

function logToFile(err, req) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${req.method} ${req.originalUrl}\n${err?.stack ?? err}\n\n`);
  } catch {
    // ignore
  }
}

export function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message, ...(err.data || {}) });
  }
  console.error(err);
  logToFile(err, req);
  res.status(500).json({ error: "Błąd serwera." });
}
