export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const assert = (condition, status, message) => {
  if (!condition) throw new HttpError(status, message);
};
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const requestId = req.id;
  let status = err.status || 500;
  let message =
    err instanceof HttpError || status < 500
      ? err.message
      : "The server could not complete this request";
  if (err.name === "ZodError") {
    status = 422;
    message = err.issues
      .map((i) => `${i.path.join(".") || "Input"}: ${i.message}`)
      .join("; ");
  }
  if (err.code === "23505") {
    status = 409;
    message = "That username, email, case number, or record already exists";
  }
  if (["23503", "23001"].includes(err.code)) {
    status = 409;
    message =
      "This record is referenced by another record. Remove or reassign those links first";
  }
  if (err.code === "LIMIT_FILE_SIZE") {
    status = 413;
    message = "File exceeds the configured upload size limit";
  }
  if (err.name === "MulterError") {
    status = 422;
    message =
      err.code === "LIMIT_FILE_SIZE"
        ? "File exceeds the configured upload size limit"
        : "Choose one file per upload";
  }
  if (status >= 500)
    console.error(
      JSON.stringify({
        event: "legalflow.request.failed", requestId,
        code: err.code || err.name || "UNKNOWN", status,
        method: req.method, route: req.route?.path,
        operation: err.operation, step: err.failureStep,
        // Names and stack frames identify failures without logging SQL, values,
        // request bodies, credentials, cookies or provider responses.
        table: err.table, constraint: err.constraint,
        frames: typeof err.stack === "string" ? err.stack.split("\n").slice(1, 5).map(s => s.trim()) : undefined,
      }),
    );
  const diagnostic = status >= 500 && err.operation === "case.delete" && req.user?.role === "owner"
    ? {diagnosticCode: err.code || err.name || "UNKNOWN", failedStep: err.failureStep}
    : {};
  res.status(status).json({ error: message, requestId, ...diagnostic });
}
