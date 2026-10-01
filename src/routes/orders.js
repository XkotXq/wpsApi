import { Router } from "express";
import multer from "multer";
import {
  listOrders,
  getOrder,
  listAllLocations,
  createOrder,
  takeOrder,
  completeOrder,
  cancelOrder,
  deliverOrder,
  acceptOrder,
  reportOrderProblem,
  resolveOrderProblem,
  listOrderEvents,
} from "../orders.js";
import { saveOrderPhoto } from "../orderPhotos.js";
import { asyncHandler } from "../asyncHandler.js";

const router = Router();

// ?scope=active|history - see listOrders's own comment. Required (no
// all-statuses default): "Lista zamówień" and "Historia zamówień" are the
// only two views today, and defaulting to "everything" would silently hand
// back a mix the first time a caller forgets the param.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await listOrders(req.query.scope));
  })
);

// The free-text place picker's own suggestion pool - see listAllLocations.
router.get(
  "/locations",
  asyncHandler(async (req, res) => {
    res.json(await listAllLocations());
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await getOrder(req.params.id));
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    res.status(201).json(await createOrder(req.body ?? {}));
  })
);

router.post(
  "/:id/take",
  asyncHandler(async (req, res) => {
    res.json(await takeOrder(req.params.id, req.body ?? {}));
  })
);

router.post(
  "/:id/complete",
  asyncHandler(async (req, res) => {
    res.json(await completeOrder(req.params.id, req.body ?? {}));
  })
);

router.post(
  "/:id/cancel",
  asyncHandler(async (req, res) => {
    res.json(await cancelOrder(req.params.id, req.body ?? {}));
  })
);

// "Dostarczone" (smVendor) - see deliverOrder's own comment.
router.post(
  "/:id/deliver",
  asyncHandler(async (req, res) => {
    res.json(await deliverOrder(req.params.id, req.body ?? {}));
  })
);

// The requester's "Akceptuj" - wps's own "Zgadza się" on a delivered
// order. "Zgłoś problem" reuses POST /:id/cancel as-is (same DB
// transition, delivered -> cancelled).
router.post(
  "/:id/accept",
  asyncHandler(async (req, res) => {
    res.json(await acceptOrder(req.params.id, req.body ?? {}));
  })
);

// POST /api/orders/:id/photo - multipart/form-data, one file under "photo"
// plus an `uploadedBy` field (the employee number, same client-asserted
// value every other write here takes). Kept in memory rather than spooled
// to disk: these are phone photos shrunk client-side before sending (see
// smOrder's own picker), and the only thing done with the buffer is handing
// it to object storage - see saveOrderPhoto.
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
});
router.post(
  "/:id/photo",
  photoUpload.single("photo"),
  asyncHandler(async (req, res) => {
    res.json(await saveOrderPhoto(req.params.id, req.file, req.body?.uploadedBy));
  })
);

// "Zgłoś problem" from the forklift operator while fulfilling - see
// reportOrderProblem. Not a cancellation: the order waits for the
// requester to resolve it.
router.post(
  "/:id/problem",
  asyncHandler(async (req, res) => {
    res.json(await reportOrderProblem(req.params.id, req.body ?? {}));
  })
);

// The requester's "Problem rozwiązany" - back to in_progress.
router.post(
  "/:id/problem/resolve",
  asyncHandler(async (req, res) => {
    res.json(await resolveOrderProblem(req.params.id, req.body ?? {}));
  })
);

// The whole history of one order, for reconstructing what happened.
router.get(
  "/:id/events",
  asyncHandler(async (req, res) => {
    res.json(await listOrderEvents(req.params.id));
  })
);

export default router;
