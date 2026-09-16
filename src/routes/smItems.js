import { Router } from "express";
import { listSmItems, upsertSmItem, deleteSmItem } from "../smItems.js";
import { asyncHandler } from "../asyncHandler.js";

const router = Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await listSmItems());
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
