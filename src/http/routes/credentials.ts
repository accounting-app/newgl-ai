import type { Hono } from "hono";

import type { ServiceContainer } from "@/application/service-container";
import { setCredentialInputSchema, tenantIdInputSchema } from "@/domain/models";
import { ValidationError } from "@/shared/errors";

export function credentialsRoutes(app: Hono, services: ServiceContainer): void {
  app.put("/internal/ai/credentials", async (context) => {
    const body = await context.req.json().catch(() => null);
    const parsed = setCredentialInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map((issue) => issue.message).join("; "));
    }

    const result = await services.credentialsService.setCredential(
      parsed.data.tenantId,
      parsed.data.apiKey,
      parsed.data.modelOverride
    );
    return context.json(result, 200);
  });

  app.delete("/internal/ai/credentials", async (context) => {
    const body = await context.req.json().catch(() => null);
    const parsed = tenantIdInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map((issue) => issue.message).join("; "));
    }

    await services.credentialsService.removeCredential(parsed.data.tenantId);
    return context.body(null, 204);
  });

  app.get("/internal/ai/status", async (context) => {
    const parsed = tenantIdInputSchema.safeParse({ tenantId: context.req.query("tenantId") });
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map((issue) => issue.message).join("; "));
    }

    const status = await services.credentialsService.getStatus(parsed.data.tenantId);
    return context.json(status, 200);
  });
}
