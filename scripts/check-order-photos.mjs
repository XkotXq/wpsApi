// Round-trip check for order photos (see src/orderPhotos.js, AGENTS.md's
// "Photos"): uploads a real file through the real HTTP route, reads the
// order back, and fetches the presigned link the API handed out.
// Run (with the dev API and MinIO both up): node scripts/check-order-photos.mjs
//
// Creates one order and one object and deletes both, including the stored
// object itself - order_photos rows cascade with the order, but the bucket
// would otherwise keep the test file forever.
import { config } from "dotenv";
config({ path: ".env" });
const { pool } = await import("../src/db.js");
const { PHOTO_BUCKET, photosConfigured } = await import("../src/orderPhotos.js");
const { Client } = await import("minio");

const BASE = "http://localhost:4000/api";
const TOKEN = process.env.API_TOKEN;

if (!photosConfigured()) {
  console.error("S3_ACCESS_KEY/S3_SECRET_KEY are not set - nothing to check.");
  process.exit(1);
}

// 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`);
};

async function api(path, { method = "GET", body, raw } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: raw ? { Authorization: `Bearer ${TOKEN}` } : { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return JSON.parse(text);
}

let orderId = null;
let storageKey = null;
try {
  const order = await api("/orders", {
    method: "POST",
    body: { type: "waste_removal", from: "SH01", employeeNo: "T-PHOTO" },
  });
  orderId = order.id;
  check("fresh order has no photo", order.photo === null, JSON.stringify(order.photo));

  const form = new FormData();
  form.append("photo", new Blob([PNG], { type: "image/png" }), "test.png");
  form.append("uploadedBy", "T-PHOTO");
  const uploaded = await api(`/orders/${orderId}/photo`, { method: "POST", raw: form });
  check("upload returns a link", typeof uploaded.url === "string" && uploaded.url.startsWith("http"), uploaded.url?.slice(0, 60));
  check("upload records who sent it", uploaded.uploadedBy === "T-PHOTO", uploaded.uploadedBy);

  const { rows } = await pool.query("SELECT storage_key, content_type FROM order_photos WHERE order_id = $1", [orderId]);
  storageKey = rows[0]?.storage_key;
  check("order_photos row written", rows.length === 1, storageKey);
  check("content type stored", rows[0]?.content_type === "image/png", rows[0]?.content_type);
  check("key is foldered by month + order", /^\d{4}-\d{2}\/order-\d+\/[0-9a-f-]+\.png$/.test(storageKey ?? ""), storageKey);

  const reread = await api(`/orders/${orderId}`);
  check("order now carries photo", Boolean(reread.photo?.url), reread.photo?.name);
  check("photos array has exactly one", reread.photos?.length === 1, String(reread.photos?.length));

  // The link must work without any Authorization header - that is the whole
  // point of presigning it (an <img src> can't send one).
  const fetched = await fetch(reread.photo.url);
  check("presigned link serves the file", fetched.status === 200, `HTTP ${fetched.status}`);
  const bytes = Buffer.from(await fetched.arrayBuffer());
  check("bytes come back identical", bytes.equals(PNG), `${bytes.length} vs ${PNG.length} bytes`);
  check("served as an image", (fetched.headers.get("content-type") ?? "").startsWith("image/png"), fetched.headers.get("content-type"));

  const rejected = await fetch(`${BASE}/orders/${orderId}/photo`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: (() => {
      const f = new FormData();
      f.append("photo", new Blob([Buffer.from("not an image")], { type: "text/plain" }), "x.txt");
      f.append("uploadedBy", "T-PHOTO");
      return f;
    })(),
  });
  check("a non-image is refused", rejected.status === 400, `HTTP ${rejected.status}`);
} finally {
  if (storageKey) {
    const s3 = new Client({
      endPoint: process.env.S3_ENDPOINT || "127.0.0.1",
      port: Number(process.env.S3_PORT || 9000),
      useSSL: process.env.S3_USE_SSL === "true",
      accessKey: process.env.S3_ACCESS_KEY,
      secretKey: process.env.S3_SECRET_KEY,
    });
    await s3.removeObject(PHOTO_BUCKET, storageKey).catch((e) => console.error(`cleanup: ${e.message}`));
  }
  if (orderId) {
    await pool.query("DELETE FROM order_photos WHERE order_id = $1", [orderId]);
    await pool.query("DELETE FROM orders WHERE id = $1", [orderId]);
  }
  console.log("\ncleaned up test order and stored object");
  await pool.end();
}

console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
