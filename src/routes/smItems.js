import { Router } from "express";
import { listSmItems, getSmItem, upsertSmItem, deleteSmItem } from "../smItems.js";
import { ApiError } from "../errors.js";
import { asyncHandler } from "../asyncHandler.js";

const router = Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await listSmItems());
  })
);

router.get(
  "/:itemNo",
  asyncHandler(async (req, res) => {
    const item = await getSmItem(req.params.itemNo);
    if (!item) throw new ApiError("Nie znaleziono materiału.", 404);
    res.json(item);
  })
);

// A write that represents a receipt/issue carries that as JSON fields
// (cipOperation: "receipt" | "issue", cipQuantity) alongside the item body,
// plus the caller's own CIP token in X-Cip-Token - see upsertSmItem's own
// doc comment for what this does and why. Both are optional together: a
// write with neither is unchanged from before CIP sync existed.
router.put(
  "/:itemNo",
  asyncHandler(async (req, res) => {
    const { cipOperation, cipQuantity, ...item } = req.body ?? {};
    const cipTask = cipOperation ? { operation: cipOperation, quantity: cipQuantity, cipToken: req.header("X-Cip-Token") } : undefined;
    res.json(await upsertSmItem(req.params.itemNo, item, cipTask));
  })
);

router.delete(
  "/:itemNo",
  asyncHandler(async (req, res) => {
    await deleteSmItem(req.params.itemNo);
    res.status(204).end();
  })
);

export default router;
