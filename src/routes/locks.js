import { Router } from "express";
import { getLockStatus, acquireLock, heartbeatLock, releaseLock } from "../locks.js";
import { asyncHandler } from "../asyncHandler.js";

const router = Router({ mergeParams: true });

router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await getLockStatus(req.params.material));
  })
);

router.post(
  "/acquire",
  asyncHandler(async (req, res) => {
    const data = await acquireLock(req.params.material, String(req.body.clientId ?? "").trim());
    res.json(data);
  })
);

router.post(
  "/heartbeat",
  asyncHandler(async (req, res) => {
    const data = await heartbeatLock(req.params.material, String(req.body.clientId ?? "").trim());
    res.json(data);
  })
);

router.post(
  "/release",
  asyncHandler(async (req, res) => {
    const data = await releaseLock(req.params.material, String(req.body.clientId ?? "").trim());
    res.json(data);
  })
);

export default router;
