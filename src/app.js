import express from "express";
import cors from "cors";
import { requireAuth } from "./middleware/auth.js";
import { loadMaterial } from "./middleware/material.js";
import { errorHandler } from "./errorHandler.js";
import authRouter from "./routes/auth.js";
import catalogRouter from "./routes/catalog.js";
import checksRouter from "./routes/checks.js";
import locksRouter from "./routes/locks.js";
import stocksRouter from "./routes/stocks.js";
import itemsRouter from "./routes/items.js";
import smCatalogRouter from "./routes/smCatalog.js";
import smItemsRouter from "./routes/smItems.js";
import smOperationsRouter from "./routes/smOperations.js";
import smSpoolsRouter from "./routes/smSpools.js";
import { cipSyncEnabled, logCipSyncMode } from "./cip.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const api = express.Router();

// cipSync: whether operations are currently being sent to CIP (see src/cip.js).
api.get("/health", (req, res) => res.json({ ok: true, cipSync: cipSyncEnabled() }));
api.use("/auth", authRouter);

api.use(requireAuth);

api.use("/catalog", catalogRouter);
api.use("/checks/:material", loadMaterial, checksRouter);
api.use("/locks/:material", loadMaterial, locksRouter);
api.use("/stocks", stocksRouter);
api.use("/sm-catalog", smCatalogRouter);
api.use("/sm-items", smItemsRouter);
api.use("/sm-operations", smOperationsRouter);
api.use("/sm-spools", smSpoolsRouter);
// Generic item routes last - every other :material key is matched here.
api.use("/:material", loadMaterial, itemsRouter);

app.use("/api", api);
app.use(errorHandler);

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`API listening on :${port}`);
  logCipSyncMode();
});
