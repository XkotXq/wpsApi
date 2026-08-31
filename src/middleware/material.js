import { getMaterial } from "../materials.js";
import { ApiError } from "../errors.js";

export function loadMaterial(req, res, next) {
  const material = getMaterial(req.params.material);
  if (!material) return next(new ApiError("Nieznany materiał.", 404));
  req.material = material;
  next();
}
