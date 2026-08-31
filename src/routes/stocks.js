import { Router } from "express";
import { listStocksBundles, getStocksBundle, getBundleMaterialSnapshot, getMaterialTrend } from "../stocks.js";
import { asyncHandler } from "../asyncHandler.js";

const router = Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await listStocksBundles(req.query.limit));
  })
);

// Registered before /:id so e.g. "frp" isn't swallowed as a stocks id -
// the literal "trend" second segment can't collide with /:id/:material
// (a real material key is never literally "trend").
router.get(
  "/:material/trend",
  asyncHandler(async (req, res) => {
    res.json(await getMaterialTrend(req.params.material));
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await getStocksBundle(req.params.id));
  })
);

router.get(
  "/:id/:material",
  asyncHandler(async (req, res) => {
    res.json(await getBundleMaterialSnapshot(req.params.id, req.params.material));
  })
);

export default router;
