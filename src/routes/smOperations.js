import { Router } from "express";
import { listSmOperations, listSmOperationsForItem, createSmOperations } from "../smOperations.js";
import { asyncHandler } from "../asyncHandler.js";

const router = Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await listSmOperations(req.query.limit, req.query.offset));
  })
);

// One item's full history (oldest first, unpaginated) - powers the "Stan w
// czasie" chart. Registered before "/" above can't shadow it since this is
// a more specific path, but keep it above any future "/:something" route
// added to this router.
router.get(
  "/item/:itemNo",
  asyncHandler(async (req, res) => {
    res.json(await listSmOperationsForItem(req.params.itemNo));
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = await createSmOperations(req.body?.entries);
    res.status(201).json(data);
  })
);

export default router;
