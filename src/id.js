import crypto from "crypto";

export function newId() {
  return crypto.randomUUID();
}
