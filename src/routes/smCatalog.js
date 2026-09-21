import { Router } from "express";
import { listSmCatalog, createSmCatalogEntry, importSmCatalogEntries, updateSmCatalogEntry, deleteSmCatalogEntry } from "../smCatalog.js";
import { asyncHandler } from "../asyncHandler.js";

const router = Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await listSmCatalog());
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
