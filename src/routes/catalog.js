import { Router } from "express";
import { asyncHandler } from "../respond.js";
import { listCatalog, createCatalogEntry, updateCatalogEntry, deleteCatalogEntry } from "../catalog.js";

export const catalogRouter = Router();

catalogRouter.get(
  "/catalog",
  asyncHandler(async (req, res) => {
    res.json(await listCatalog());
  })
);

catalogRouter.post(
  "/catalog",
  asyncHandler(async (req, res) => {
    res.status(201).json(await createCatalogEntry(req.body));
  })
);

catalogRouter.patch(
  "/catalog/:itemNumber",
  asyncHandler(async (req, res) => {
    res.json(await updateCatalogEntry(req.params.itemNumber, req.body));
  })
);

catalogRouter.delete(
  "/catalog/:itemNumber",
  asyncHandler(async (req, res) => {
    await deleteCatalogEntry(req.params.itemNumber);
    res.status(204).end();
  })
);
