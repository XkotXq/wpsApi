import { Router } from "express";
import {
  listEmployeeRoles,
  listKnownEmployees,
  upsertEmployeeRole,
  deleteEmployeeRole,
  EMPLOYEE_ROLES,
} from "../employeeRoles.js";
import { asyncHandler } from "../asyncHandler.js";

const router = Router();

// The roles this installation knows, so a client never hard-codes the list
// and a new one appears everywhere at once.
router.get("/roles", (req, res) => res.json(EMPLOYEE_ROLES));

// Everybody who has ever logged in, with whatever role they have - the list
// wps's own screen is built from. Declared before "/" is irrelevant (both
// are literal) but kept above it for reading order.
router.get(
  "/known",
  asyncHandler(async (req, res) => {
    res.json(await listKnownEmployees());
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await listEmployeeRoles());
  })
);

router.put(
  "/:employeeNo",
  asyncHandler(async (req, res) => {
    res.json(await upsertEmployeeRole({ ...(req.body ?? {}), employeeNo: req.params.employeeNo }));
  })
);

router.delete(
  "/:employeeNo",
  asyncHandler(async (req, res) => {
    res.json(await deleteEmployeeRole(req.params.employeeNo));
  })
);

export default router;
