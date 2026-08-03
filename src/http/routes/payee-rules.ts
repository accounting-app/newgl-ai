import type { Hono } from "hono";

import type { ServiceContainer } from "@/application/service-container";
import { learnPayeeRulesInputSchema, normalizePayeesInputSchema } from "@/domain/models";
import { ValidationError } from "@/shared/errors";

export function payeeRulesRoutes(app: Hono, services: ServiceContainer): void {
  app.post("/internal/ai/payees/normalize", async (context) => {
    const body = await context.req.json().catch(() => null);
    const parsed = normalizePayeesInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map((issue) => issue.message).join("; "));
    }

    const { tenantId, payees, monthlyAiActions, monthlyTokenCap } = parsed.data;
    const limits =
      monthlyAiActions !== undefined && monthlyTokenCap !== undefined ? { monthlyAiActions, monthlyTokenCap } : undefined;

    const result = await services.payeeRulesService.suggestNormalization({ tenantId, payees, limits });
    return context.json(result, 200);
  });

  app.post("/internal/ai/rules/learn", async (context) => {
    const body = await context.req.json().catch(() => null);
    const parsed = learnPayeeRulesInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map((issue) => issue.message).join("; "));
    }

    const result = await services.payeeRulesService.learnRules(parsed.data);
    return context.json(result, 200);
  });
}
