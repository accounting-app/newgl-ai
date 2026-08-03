import type { Hono } from "hono";

import type { ServiceContainer } from "@/application/service-container";
import { categorizeInputSchema } from "@/domain/models";
import { ValidationError } from "@/shared/errors";

export function categorizationRoutes(app: Hono, services: ServiceContainer): void {
  app.post("/internal/ai/categorize", async (context) => {
    const body = await context.req.json().catch(() => null);
    const parsed = categorizeInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map((issue) => issue.message).join("; "));
    }

    const { tenantId, accounts, transactions, monthlyAiActions, monthlyTokenCap } = parsed.data;
    const limits =
      monthlyAiActions !== undefined && monthlyTokenCap !== undefined ? { monthlyAiActions, monthlyTokenCap } : undefined;

    const result = await services.categorizationService.suggestCategorization({ tenantId, accounts, transactions, limits });
    return context.json(result, 200);
  });
}
