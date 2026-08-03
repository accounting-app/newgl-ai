import type { Hono } from "hono";

export function healthRoutes(app: Hono): void {
  app.get("/internal/health", (context) => {
    return context.json({ status: "ok", timestamp: new Date().toISOString() }, 200);
  });
}
