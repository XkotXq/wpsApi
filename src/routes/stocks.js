import { Router } from "express";
import { asyncHandler } from "../respond.js";
import { ApiError } from "../errors.js";
import { MATERIAL_KEYS } from "../materials.js";
import { createStockSession, listStockSessions, getStockSession, submitStockTake, getSessionMaterialSnapshot, finishStock } from "../stocks.js";

export const stocksRouter = Router();

stocksRouter.param("material", (req, res, next, material) => {
  if (!MATERIAL_KEYS.includes(material)) return next(new ApiError("Nieznany materiał.", 404));
  next();
});

// Starts a new remanent session — call once, then submit each material
// into it as it's counted so they end up grouped together.
stocksRouter.post(
  "/stocks",
  asyncHandler(async (req, res) => {
    res.status(201).json(await createStockSession());
  })
);

stocksRouter.get(
  "/stocks",
  asyncHandler(async (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(await listStockSessions({ limit }));
  })
);

stocksRouter.get(
  "/stocks/:stocksId",
  asyncHandler(async (req, res) => {
    res.json(await getStockSession(req.params.stocksId));
  })
);

// Finishes a stock-take that was counted/edited entirely client-side:
// applies the local item list to *_current and records the tally +
// snapshot, all in one transaction. Registered before the generic
// "/stocks/:stocksId/:material" route below — the literal "finish"
// segment never collides with a real session id.
stocksRouter.post(
  "/stocks/finish/:material",
  asyncHandler(async (req, res) => {
    res.status(201).json(await finishStock(req.params.material, req.body || {}));
  })
);

stocksRouter.post(
  "/stocks/:stocksId/:material",
  asyncHandler(async (req, res) => {
    res.status(201).json(await submitStockTake(req.params.stocksId, req.params.material, req.body || {}));
  })
);

stocksRouter.get(
  "/stocks/:stocksId/:material",
  asyncHandler(async (req, res) => {
    res.json(await getSessionMaterialSnapshot(req.params.stocksId, req.params.material));
  })
);
