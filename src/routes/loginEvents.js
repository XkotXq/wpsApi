import { Router } from "express";
import { listLoginEvents } from "../loginEvents.js";
import { asyncHandler } from "../asyncHandler.js";

const router = Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await listLoginEvents(req.query.limit));
  })
);

export default router;
