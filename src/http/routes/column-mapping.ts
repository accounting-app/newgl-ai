import type { Hono } from "hono";

import type { ServiceContainer } from "@/application/service-container";
import { columnMappingInputSchema } from "@/domain/models";
import { ValidationError } from "@/shared/errors";

export function columnMappingRoutes(app: Hono, services: ServiceContainer): void {
  app.post("/internal/ai/column-mapping", async (context) => {
    const body = await context.req.json().catch(() => null);
    const parsed = columnMappingInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map((issue) => issue.message).join("; "));
    }

    const { tenantId, csvHeader, sampleRows, monthlyAiActions, monthlyTokenCap } = parsed.data;
    const limits =
      monthlyAiActions !== undefined && monthlyTokenCap !== undefined ? { monthlyAiActions, monthlyTokenCap } : undefined;

    const result = await services.columnMappingService.suggestMapping({ tenantId, csvHeader, sampleRows, limits });
    return context.json(result, 200);
  });
}
