import { Router } from "express";
import { asyncHandler } from "../respond.js";
import { ApiError } from "../errors.js";
import { MATERIAL_KEYS } from "../materials.js";
import { listItems, createItem, updateItem, deleteItem, reorderItems, transferItem } from "../items.js";

export const itemsRouter = Router();

itemsRouter.param("material", (req, res, next, material) => {
  if (!MATERIAL_KEYS.includes(material)) return next(new ApiError("Nieznany materiał.", 404));
  next();
});

itemsRouter.get(
  "/items/:material",
  asyncHandler(async (req, res) => {
    res.json(await listItems(req.params.material));
  })
);

itemsRouter.post(
  "/items/:material",
  asyncHandler(async (req, res) => {
    res.status(201).json(await createItem(req.params.material, req.body));
  })
);

itemsRouter.patch(
  "/items/:material/:id",
  asyncHandler(async (req, res) => {
    res.json(await updateItem(req.params.material, req.params.id, req.body));
  })
);

itemsRouter.delete(
  "/items/:material/:id",
  asyncHandler(async (req, res) => {
    await deleteItem(req.params.material, req.params.id);
    res.status(204).end();
  })
);

itemsRouter.post(
  "/items/:material/reorder",
  asyncHandler(async (req, res) => {
    res.json(await reorderItems(req.params.material, req.body?.order));
  })
);

itemsRouter.post(
  "/items/:material/transfer",
  asyncHandler(async (req, res) => {
    res.json(await transferItem(req.params.material, req.body));
  })
);
