import { Router } from "express";
import { listChecks, getStatus, submitCheck, resetStatus } from "../checks.js";
import { asyncHandler } from "../asyncHandler.js";

const router = Router({ mergeParams: true });

router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await listChecks(req.params.material, req.query.limit));
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = await submitCheck(req.params.material, req.body);
    res.status(201).json(data);
  })
);

router.get(
  "/status",
  asyncHandler(async (req, res) => {
    res.json(await getStatus(req.params.material));
  })
);

router.post(
  "/reset",
  asyncHandler(async (req, res) => {
    const data = await resetStatus(req.params.material, req.body?.performedBy);
    res.json(data);
  })
);

export default router;
