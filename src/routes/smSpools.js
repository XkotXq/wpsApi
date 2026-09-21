import { Router } from "express";
import { asyncHandler } from "../asyncHandler.js";
import { getSpoolSeries, setSpoolSeries, nextSpoolNumber, listUnlabeledFrp, labelSpool } from "../smSpools.js";

const router = Router();

// FRP waiting for spool numbers - what smpda's FRP module lists.
router.get(
  "/unlabeled",
  asyncHandler(async (req, res) => {
    res.json(await listUnlabeledFrp());
  })
);

// The number the next spool will get. Doesn't reserve anything - asking twice
// gives the same number until a spool actually takes it (POST /label).
router.get(
  "/next",
  asyncHandler(async (req, res) => {
    res.json({ unitId: await nextSpoolNumber() });
  })
);

router.post(
  "/label",
  asyncHandler(async (req, res) => {
    try {
      res.status(201).json(await labelSpool(req.body ?? {}));
    } catch (err) {
      // "That number is taken" comes with the number to use instead.
      if (err.next) return res.status(409).json({ error: err.message, next: err.next });
      throw err;
    }
  })
);

// Which numbers get handed out: a list of series, tried in order.
//   [{ "prefix": "Y", "digits": 3, "from": 1, "to": 999 }, { "prefix": "Z", ... }]
router.get(
  "/settings",
  asyncHandler(async (req, res) => {
    res.json({ series: await getSpoolSeries() });
  })
);

router.put(
  "/settings",
  asyncHandler(async (req, res) => {
    res.json({ series: await setSpoolSeries(req.body?.series) });
  })
);

export default router;
