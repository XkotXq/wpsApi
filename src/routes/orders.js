import { Router } from "express";
import multer from "multer";
import {
  listOrders,
  getOrder,
  listAllLocations,
  listLocationCandidates,
  promoteLocationCandidate,
  deleteLocationCandidate,
  createOrder,
  takeOrder,
  completeOrder,
  cancelOrder,
  deliverOrder,
  acceptOrder,
  reportOrderProblem,
  resolveOrderProblem,
  listOrderEvents,
  listOrderMessages,
  createOrderMessage,
  markOrderMessagesRead,
  startOrderEdit,
  stopOrderEdit,
  updateOrder,
  deleteOrder,
} from "../orders.js";
import { saveOrderPhoto } from "../orderPhotos.js";
import { shiftReport } from "../orderReports.js";
import { asyncHandler } from "../asyncHandler.js";

const router = Router();

// ?scope=active|history - see listOrders's own comment. Required (no
// all-statuses default): "Lista zamówień" and "Historia zamówień" are the
// only two views today, and defaulting to "everything" would silently hand
// back a mix the first time a caller forgets the param.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    // ?limit=N&beforeCreatedAt=ISO&beforeId=123 - optional paging for the
    // history screens (see listOrders). Both cursor parts travel together or
    // not at all; a half-cursor is a client bug, not a first page.
    const { limit, beforeCreatedAt, beforeId } = req.query;
    const before = beforeCreatedAt && beforeId ? { createdAt: beforeCreatedAt, id: beforeId } : undefined;
    // ?viewer=<nr pracownika> - whose unread counts to compute (see
    // unreadCountsByOrderIds). Omitted by callers with no single person
    // behind them, e.g. wps.
    res.json(await listOrders(req.query.scope, { limit, before, viewer: req.query.viewer }));
  })
);

// Places people have typed that are not suggestions - the review list (see
// listLocationCandidates). Must be declared **before** "/:id", or Express
// matches "location-candidates" as an order id.
router.get(
  "/location-candidates",
  asyncHandler(async (req, res) => {
    res.json(await listLocationCandidates());
  })
);

router.post(
  "/location-candidates/promote",
  asyncHandler(async (req, res) => {
    res.json(await promoteLocationCandidate(req.body ?? {}));
  })
);

router.delete(
  "/location-candidates/:name",
  asyncHandler(async (req, res) => {
    res.json(await deleteLocationCandidate(req.params.name));
  })
);

// "Raporty" under Transporty in wps - see orderReports.js. Declared with
// the other fixed paths **above** /:id, or Express reads "reports" as an
// order id.
//
// ?from=&to= are plant-local dates, inclusive at both ends; without them it
// reports the last seven days up to today.
router.get(
  "/reports/shifts",
  asyncHandler(async (req, res) => {
    const today = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    const weekAgo = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);
    const from = typeof req.query.from === "string" && req.query.from ? req.query.from : iso(weekAgo);
    const to = typeof req.query.to === "string" && req.query.to ? req.query.to : iso(today);
    res.json(await shiftReport({ from, to }));
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
    res.json(await getOrder(req.params.id, { viewer: req.query.viewer }));
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

// Editing one's own not-yet-started order. /edit/start takes the lock that
// hides it from the forklift queue (and is re-sent as a keep-alive while
// the form is open), PATCH saves and releases it, /edit/stop just releases.
router.post(
  "/:id/edit/start",
  asyncHandler(async (req, res) => {
    res.json(await startOrderEdit(req.params.id, req.body ?? {}));
  })
);

router.post(
  "/:id/edit/stop",
  asyncHandler(async (req, res) => {
    res.json(await stopOrderEdit(req.params.id, req.body ?? {}));
  })
);

router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await updateOrder(req.params.id, req.body ?? {}));
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await deleteOrder(req.params.id, req.body ?? {}));
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

// The chat on one order. ?afterId=N returns only what is newer, which is
// what the clients poll with (see listOrderMessages).
router.get(
  "/:id/messages",
  asyncHandler(async (req, res) => {
    res.json(await listOrderMessages(req.params.id, { afterId: req.query.afterId }));
  })
);

// "I have read up to here" - the chat screen sends this as it shows
// messages, which is what makes unreadCount mean anything.
router.post(
  "/:id/messages/read",
  asyncHandler(async (req, res) => {
    res.json(await markOrderMessagesRead(req.params.id, req.body ?? {}));
  })
);

router.post(
  "/:id/messages",
  asyncHandler(async (req, res) => {
    res.status(201).json(await createOrderMessage(req.params.id, req.body ?? {}));
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
