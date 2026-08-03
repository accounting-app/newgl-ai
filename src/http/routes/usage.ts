import type { Hono } from "hono";

import type { ServiceContainer } from "@/application/service-container";
import { usageQuerySchema } from "@/domain/models";
import { ValidationError } from "@/shared/errors";

export function usageRoutes(app: Hono, services: ServiceContainer): void {
  app.get("/internal/ai/usage", async (context) => {
    const parsed = usageQuerySchema.safeParse({
      tenantId: context.req.query("tenantId"),
      monthlyAiActions: context.req.query("monthlyAiActions"),
      monthlyTokenCap: context.req.query("monthlyTokenCap")
    });
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map((issue) => issue.message).join("; "));
    }

    const { tenantId, monthlyAiActions, monthlyTokenCap } = parsed.data;
    const limits =
      monthlyAiActions !== undefined && monthlyTokenCap !== undefined
        ? { monthlyAiActions, monthlyTokenCap }
        : undefined;

    const result = await services.usageService.getUsageSummary(tenantId, limits);
    return context.json(result, 200);
  });
}
