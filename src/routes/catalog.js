import { Router } from "express";
import { listCatalog, createCatalogEntry, updateCatalogEntry, deleteCatalogEntry } from "../catalog.js";
import { asyncHandler } from "../asyncHandler.js";

const router = Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await listCatalog());
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = await createCatalogEntry(req.body);
    res.status(201).json(data);
  })
);

router.patch(
  "/:number",
  asyncHandler(async (req, res) => {
    const data = await updateCatalogEntry(req.params.number, req.body);
    res.json(data);
  })
);

router.delete(
  "/:number",
  asyncHandler(async (req, res) => {
    await deleteCatalogEntry(req.params.number);
    res.status(204).end();
  })
);

export default router;
