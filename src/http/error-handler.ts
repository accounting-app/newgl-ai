import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";

import { AiQuotaExceededError } from "@/domain/quota";
import { AppError } from "@/shared/errors";

export const errorHandler: ErrorHandler = (error, context) => {
  // 402, not 429: this is "you're out of quota", not "slow down and retry"
  // -- newgl-api's proxy renders these very differently to the user. See
  // AI_INTEGRATION_PLAN.md Part 8.
  if (error instanceof AiQuotaExceededError) {
    return context.json({ error: { message: error.message, limitType: error.limitType } }, 402);
  }
  if (error instanceof AppError) {
    return context.json({ error: { message: error.message } }, error.statusCode as any);
  }
  if (error instanceof HTTPException) {
    return context.json({ error: { message: error.message } }, error.status);
  }
  console.error(error);
  return context.json({ error: { message: "Internal Server Error" } }, 500);
};
