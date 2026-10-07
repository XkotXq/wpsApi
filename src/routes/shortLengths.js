import { Router } from "express";
import multer from "multer";
import { listShortLengthReports, createShortLengthReport, getShortLengthReport } from "../shortLengths.js";
import { saveShortLengthPhoto } from "../orderPhotos.js";
import { asyncHandler } from "../asyncHandler.js";

const router = Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await listShortLengthReports({ limit: req.query.limit }));
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    res.status(201).json(await createShortLengthReport(req.body ?? {}));
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await getShortLengthReport(req.params.id));
  })
);

// Same shape as the order photo upload (see routes/orders.js): multipart,
// one file under "photo" plus an `uploadedBy` field, kept in memory because
// the only thing done with the buffer is handing it to object storage.
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
});

router.post(
  "/:id/photo",
  photoUpload.single("photo"),
  asyncHandler(async (req, res) => {
    res.json(await saveShortLengthPhoto(req.params.id, req.file, req.body?.uploadedBy));
  })
);

export default router;
