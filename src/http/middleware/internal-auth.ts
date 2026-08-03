import type { MiddlewareHandler } from "hono";

/**
 * newgl-ai has no public IP in production (Fly private network only) --
 * this shared secret is defense-in-depth for the case where network
 * isolation is misconfigured, not the only line of defense.
 * See AI_INTEGRATION_PLAN.md Part 1, "Service-to-service authentication".
 */
export function internalAuth(expectedToken: string | undefined): MiddlewareHandler {
  return async (context, next) => {
    if (context.req.path === "/internal/health") {
      await next();
      return;
    }

    // Fail closed: an unset token must never mean "accept anything".
    if (!expectedToken) {
      return context.json({ error: { message: "INTERNAL_SERVICE_TOKEN is not configured on this server" } }, 401);
    }

    const provided = context.req.header("X-Internal-Token");
    if (!provided || provided !== expectedToken) {
      return context.json({ error: { message: "Missing or invalid X-Internal-Token" } }, 401);
    }

    await next();
  };
}
