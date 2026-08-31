import { Router } from "express";
import { listItems, createItem, updateItem, deleteItem, reorderItems, transferItem } from "../items.js";
import { asyncHandler } from "../asyncHandler.js";

const router = Router({ mergeParams: true });

router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await listItems(req.material));
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = await createItem(req.material, req.body);
    res.status(201).json(data);
  })
);

router.post(
  "/reorder",
  asyncHandler(async (req, res) => {
    const data = await reorderItems(req.material, req.body.order);
    res.json(data);
  })
);

router.post(
  "/transfer",
  asyncHandler(async (req, res) => {
    const data = await transferItem(req.material, req.body);
    res.json(data);
  })
);

router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const data = await updateItem(req.material, req.params.id, req.body);
    res.json(data);
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await deleteItem(req.material, req.params.id);
    res.status(204).end();
  })
);

export default router;
