export class ApiError extends Error {
  constructor(message, status = 400, data = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

// Translates common Postgres constraint-violation error codes into a
// friendly ApiError instead of letting a raw pg error (and its SQL text)
// leak to the client.
export function toApiError(err) {
  if (err instanceof ApiError) return err;
  if (err && err.code === "23505") return new ApiError("Taka wartość już istnieje.", 409);
  if (err && err.code === "23503") return new ApiError("Ten rekord jest w użyciu i nie można go usunąć/zmienić.", 409);
  if (err && err.code === "23514") return new ApiError("Nieprawidłowa wartość pola.", 400);
  return err;
}
