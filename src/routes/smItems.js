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

router.put(
  "/:itemNo",
  asyncHandler(async (req, res) => {
    res.json(await upsertSmItem(req.params.itemNo, req.body));
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
