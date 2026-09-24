import { pool } from "./db.js";
import { ApiError } from "./errors.js";

// Shared by upsertSmItem (src/smItems.js) and createSmOperations's own
// entries (src/smOperations.js) - both are where an item number + name
// actually get persisted. The server, not the caller, decides the name: a
// material the catalog (sm_catalog) knows is always saved under the
// catalog's name, whatever the caller sent - so a client can leave it blank,
// hold an old one, or mistype it, and the stored name is still right.

// Numer itemu is always a plain CIP-style digit string (see
// materialList.txt / seed-sm-catalog.mjs - every real item number seen so
// far is 15 digits, but this only enforces "digits only" rather than an
// exact length, in case a shorter/longer one is ever legitimate).
const ITEM_NO_FORMAT = /^\d+$/;

// Throws an ApiError (400) if itemNo isn't a plain digit string.
export function assertItemNoFormat(itemNo) {
  if (!ITEM_NO_FORMAT.test(itemNo)) throw new ApiError("Numer itemu musi składać się wyłącznie z cyfr.", 400);
}

// The catalog's name for this item number, or null when the catalog doesn't
// know it - an item number the catalog doesn't know keeps whatever name the
// caller gave it.
export async function catalogItemName(itemNo) {
  const { rows } = await pool.query("SELECT item_name FROM sm_catalog WHERE item_no = $1", [itemNo]);
  return rows.length ? rows[0].item_name : null;
}
