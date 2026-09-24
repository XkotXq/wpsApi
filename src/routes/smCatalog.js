import { Router } from "express";
import {
  listSmCatalog,
  getSmCatalogEntry,
  createSmCatalogEntry,
  importSmCatalogEntries,
  setSmCatalogCategoryUnit,
  updateSmCatalogEntry,
  deleteSmCatalogEntry,
} from "../smCatalog.js";
import { ApiError } from "../errors.js";
import { asyncHandler } from "../asyncHandler.js";

const router = Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await listSmCatalog());
  })
);

router.get(
  "/:itemNo",
  asyncHandler(async (req, res) => {
    const entry = await getSmCatalogEntry(req.params.itemNo);
    if (!entry) throw new ApiError("Nie znaleziono pozycji w katalogu.", 404);
    res.json(entry);
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = await createSmCatalogEntry(req.body);
    res.status(201).json(data);
  })
);

router.post(
  "/import",
  asyncHandler(async (req, res) => {
    res.json(await importSmCatalogEntries(req.body?.entries));
  })
);

router.post(
  "/category-unit",
  asyncHandler(async (req, res) => {
    res.json(await setSmCatalogCategoryUnit(req.body?.category, req.body?.unit));
  })
);

router.patch(
  "/:itemNo",
  asyncHandler(async (req, res) => {
    const data = await updateSmCatalogEntry(req.params.itemNo, req.body);
    res.json(data);
  })
);

router.delete(
  "/:itemNo",
  asyncHandler(async (req, res) => {
    await deleteSmCatalogEntry(req.params.itemNo);
    res.status(204).end();
  })
);

export default router;
