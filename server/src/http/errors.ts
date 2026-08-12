import { getLogger } from "@logtape/logtape";
import type { ErrorHandler } from "hono";
import { RenewalError } from "../domain/session";

const apiLogger = getLogger(["jungle-bell", "api-worker"]);

export const apiErrorHandler: ErrorHandler = (error, context) => {
  if (error instanceof RenewalError) return context.json({ error: error.code }, error.status);
  apiLogger.error("API request failed", {
    method: context.req.method,
    path: context.req.path,
    error: error.message,
  });
  return context.json({ error: "INTERNAL_ERROR" }, 500);
};
