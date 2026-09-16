import { pool } from "./db.js";
import { ApiError } from "./errors.js";

// Shared by upsertSmItem (src/smItems.js) and createSmOperations's own
// "receipt" entries (src/smOperations.js) - both are where a receipt's
// item number + name actually get persisted, so both need the same check
// rather than trusting whatever wps's own resolveCatalogItemName already
// did client-side (that's a convenience for the operator typing, not a
// guarantee - this is the backstop that can't be bypassed).

// Numer itemu is always a plain CIP-style digit string (see
// materialList.txt / seed-sm-catalog.mjs - every real item number seen so
// far is 15 digits, but this only enforces "digits only" rather than an
// exact length, in case a shorter/longer one is ever legitimate).
const ITEM_NO_FORMAT = /^\d+$/;

// Throws an ApiError (400) if itemNo isn't a plain digit string, or if
// itemNo is a known sm_catalog entry whose name doesn't match itemName
// (case-insensitive) - an item number the catalog doesn't know has
// nothing to check the name against, so it's let through as-is, same rule
// wps's own resolveCatalogItemName follows.
export async function assertValidReceiptItem(itemNo, itemName) {
  if (!ITEM_NO_FORMAT.test(itemNo)) throw new ApiError("Numer itemu musi składać się wyłącznie z cyfr.", 400);
  const { rows } = await pool.query("SELECT item_name FROM sm_catalog WHERE item_no = $1", [itemNo]);
  if (rows.length && rows[0].item_name.toLowerCase() !== itemName.toLowerCase()) {
    throw new ApiError(`Nazwa materiału nie zgadza się z katalogiem - dla ${itemNo} powinno być "${rows[0].item_name}".`, 400);
  }
}
