import { Router } from "express";
import { listLineMaterialRules, listProductionLines, upsertLineMaterialRule, deleteLineMaterialRule } from "../lineMaterialRules.js";
import { asyncHandler } from "../asyncHandler.js";

const router = Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await listLineMaterialRules());
  })
);

// The line picker's own options - see listProductionLines's own comment.
router.get(
  "/lines",
  asyncHandler(async (req, res) => {
    res.json(await listProductionLines());
  })
);

// Upsert by (lineName, itemNo) - see upsertLineMaterialRule's own comment
// for why this is the one write endpoint for both adding and editing a rule.
router.post(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await upsertLineMaterialRule(req.body ?? {}));
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await deleteLineMaterialRule(req.params.id);
    res.status(204).end();
  })
);

export default router;
