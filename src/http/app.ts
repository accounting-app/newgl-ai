import { Hono } from "hono";

import type { ServiceContainer } from "@/application/service-container";
import { errorHandler } from "@/http/error-handler";
import { internalAuth } from "@/http/middleware/internal-auth";
import { columnMappingRoutes } from "@/http/routes/column-mapping";
import { credentialsRoutes } from "@/http/routes/credentials";
import { healthRoutes } from "@/http/routes/health";
import { usageRoutes } from "@/http/routes/usage";

/**
 * newgl-ai has no user sessions and no browser-facing CORS -- every route
 * (other than /internal/health) requires the shared X-Internal-Token header.
 * See AI_INTEGRATION_PLAN.md Part 1b.
 */
export function createApp(services: ServiceContainer, internalServiceToken: string | undefined) {
  const app = new Hono();

  app.use("*", internalAuth(internalServiceToken));
  app.onError(errorHandler);

  healthRoutes(app);
  credentialsRoutes(app, services);
  usageRoutes(app, services);
  columnMappingRoutes(app, services);

  return app;
}
