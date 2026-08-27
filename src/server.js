import "dotenv/config";
import express from "express";
import cors from "cors";
import { auth } from "./middleware/auth.js";
import { errorMiddleware } from "./respond.js";
import { healthRouter } from "./routes/health.js";
import { catalogRouter } from "./routes/catalog.js";
import { itemsRouter } from "./routes/items.js";
import { stocksRouter } from "./routes/stocks.js";

const app = express();

const allowedOrigins = (process.env.CORS_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true }));
app.use(express.json());

app.use(healthRouter);
// Auth disabled for now (per request) — re-enable with `app.use(auth);`
// once there's a real login flow to protect.
app.use(catalogRouter);
app.use(itemsRouter);
app.use(stocksRouter);

app.use(errorMiddleware);

const port = Number(process.env.PORT) || 4000;
app.listen(port, () => {
  console.log(`frp-api listening on :${port}`);
});
