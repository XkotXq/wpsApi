import { randomUUID } from "node:crypto";
import { Client } from "minio";
import { pool } from "./db.js";
import { ApiError } from "./errors.js";

// Order photos live in S3-compatible object storage (MinIO locally - see
// ../dockerPostgresql/docker-compose.yml), not in Postgres and not on the
// API's own disk: `order_photos` keeps only the key (see schema.sql, and
// AGENTS.md's "Photos"). The `minio` client talks plain S3, so pointing
// S3_ENDPOINT at real S3 (or any other S3 service) is the whole migration.
//
// S3_ENDPOINT must be a host the *phone and browser* can reach, not
// "localhost"/"minio": a photo is shown through a presigned URL generated
// here, and that URL carries this endpoint's own host. On the warehouse LAN
// that means the same machine address wpsApi itself is reached at.
const endPoint = process.env.S3_ENDPOINT || "127.0.0.1";
const port = Number(process.env.S3_PORT || 9000);
const useSSL = process.env.S3_USE_SSL === "true";
const accessKey = process.env.S3_ACCESS_KEY || "";
const secretKey = process.env.S3_SECRET_KEY || "";
export const PHOTO_BUCKET = process.env.S3_BUCKET || "order-photos";

// How long a photo link stays valid. Short on purpose - every client
// re-reads the order (wps polls, the Flutter apps poll) and gets a fresh
// link with it, so nothing needs a long-lived URL floating around.
const LINK_TTL_SECONDS = 60 * 60;

/** Whether object storage is configured at all - without keys there is nothing to talk to. */
export function photosConfigured() {
  return Boolean(accessKey && secretKey);
}

let client = null;
function s3() {
  if (!photosConfigured()) {
    throw new ApiError("Magazyn zdjęć nie jest skonfigurowany (S3_ACCESS_KEY/S3_SECRET_KEY).", 503);
  }
  client ??= new Client({ endPoint, port, useSSL, accessKey, secretKey });
  return client;
}

/// Creates the bucket if it isn't there - the compose file also asks MinIO
/// to make it on first start, but doing it here too is what keeps this
/// working against a fresh S3 endpoint nobody prepared by hand. Logs and
/// carries on if storage is unreachable at boot: the API must still serve
/// everything that has nothing to do with photos.
export async function ensurePhotoBucket() {
  if (!photosConfigured()) {
    console.log("Order photos: storage not configured (no S3_ACCESS_KEY/S3_SECRET_KEY) - uploads will be refused.");
    return;
  }
  try {
    const exists = await s3().bucketExists(PHOTO_BUCKET);
    if (!exists) await s3().makeBucket(PHOTO_BUCKET);
    console.log(`Order photos: bucket "${PHOTO_BUCKET}" ready at ${endPoint}:${port}.`);
  } catch (err) {
    console.error(`Order photos: storage unreachable at ${endPoint}:${port} - ${err.message}`);
  }
}

const EXT_BY_TYPE = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};

/// Stores one photo for an order and records it in `order_photos`.
/// `file` is multer's in-memory file ({ buffer, mimetype, size }).
export async function saveOrderPhoto(orderId, file, uploadedBy) {
  const by = String(uploadedBy ?? "").trim();
  if (!by) throw new ApiError("Brak numeru pracownika - zaloguj się ponownie.", 400);
  if (!file?.buffer?.length) throw new ApiError("Brak pliku zdjęcia.", 400);
  const contentType = String(file.mimetype ?? "");
  const ext = EXT_BY_TYPE[contentType];
  if (!ext) throw new ApiError(`Nieobsługiwany format zdjęcia: ${contentType || "nieznany"}.`, 400);

  const { rows } = await pool.query("SELECT id FROM orders WHERE id = $1", [orderId]);
  if (!rows.length) throw new ApiError("Nie znaleziono zamówienia.", 404);

  // Keyed by order and a fresh uuid, foldered by month so the bucket stays
  // browsable by hand (and old months are easy to archive) rather than
  // being one flat directory of thousands of objects.
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const storageKey = `${month}/order-${orderId}/${randomUUID()}.${ext}`;

  await s3().putObject(PHOTO_BUCKET, storageKey, file.buffer, file.buffer.length, { "Content-Type": contentType });
  const { rows: saved } = await pool.query(
    `INSERT INTO order_photos (order_id, storage_key, content_type, uploaded_by)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [orderId, storageKey, contentType, by]
  );
  return photoRowToApi(saved[0], await linkFor(storageKey));
}

async function linkFor(storageKey) {
  return s3().presignedGetObject(PHOTO_BUCKET, storageKey, LINK_TTL_SECONDS);
}

function photoRowToApi(row, url) {
  return {
    id: String(row.id),
    // `name` is what wps's own <img title>/alt shows - the key's own file
    // name is meaningless to a person, so this is "order photo" plus when
    // it was taken, which is what distinguishes two of them.
    name: `Zdjęcie ${new Date(row.uploaded_at).toLocaleString("pl-PL")}`,
    url,
    contentType: row.content_type,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
  };
}

/// Every order's photos, as `Map<orderId, photo[]>`, each with a fresh
/// presigned link. Returns an empty map when storage isn't configured (or
/// is down), so an order list never fails over a photo - the orders
/// themselves matter more than their attachments.
export async function photosByOrderIds(orderIds) {
  const byOrder = new Map();
  if (!orderIds.length || !photosConfigured()) return byOrder;
  const { rows } = await pool.query(
    "SELECT * FROM order_photos WHERE order_id = ANY($1) ORDER BY uploaded_at",
    [orderIds]
  );
  if (!rows.length) return byOrder;
  try {
    const withLinks = await Promise.all(rows.map(async (row) => photoRowToApi(row, await linkFor(row.storage_key))));
    for (const [i, photo] of withLinks.entries()) {
      const key = rows[i].order_id;
      byOrder.set(key, [...(byOrder.get(key) ?? []), photo]);
    }
  } catch (err) {
    console.error(`Order photos: could not sign links - ${err.message}`);
  }
  return byOrder;
}
