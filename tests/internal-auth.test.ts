import { describe, expect, test } from "bun:test";

import { createApp } from "../src/http/app";
import type { ServiceContainer } from "../src/application/service-container";

// A minimal stub container -- these tests only exercise the auth
// middleware, never the actual service logic.
const stubServices: ServiceContainer = {
  credentialsService: {
    setCredential: async () => ({ maskedKey: "sk-ant-...0000", model: "test-model", validatedAt: "now" }),
    removeCredential: async () => {},
    getStatus: async () => ({ keySource: "platform", maskedKey: null, model: "test-model", validatedAt: null }),
    resolveKey: async () => ({ apiKey: "unused", source: "platform", model: "test-model", enforceQuota: true })
  },
  usageService: {
    recordUsage: async () => {},
    getUsageSummary: async () => ({
      summary: { periodStart: "now", totalActions: 0, totalTokens: 0, byKeySource: { platform: { actions: 0, tokens: 0 }, byok: { actions: 0, tokens: 0 } } },
      limits: null
    }),
    assertWithinQuota: async () => {}
  },
  columnMappingService: {
    suggestMapping: async () => ({ mapping: {}, usage: { actions: 0, inputTokens: 0, outputTokens: 0 }, keySource: "platform" })
  },
  payeeRulesService: {
    suggestNormalization: async () => ({ results: [], usage: { actions: 0, inputTokens: 0, outputTokens: 0 }, keySource: null }),
    learnRules: async () => ({ learned: 0 })
  },
  categorizationService: {
    suggestCategorization: async () => ({ results: [], usage: { actions: 0, inputTokens: 0, outputTokens: 0 }, keySource: null })
  }
};

const TENANT_ID = "00000000-0000-0000-0000-000000000000";

describe("internal-auth middleware", () => {
  test("GET /internal/health works with no token at all", async () => {
    const app = createApp(stubServices, "correct-token");
    const res = await app.request("/internal/health");
    expect(res.status).toBe(200);
  });

  test("rejects every other route with no token", async () => {
    const app = createApp(stubServices, "correct-token");
    const res = await app.request(`/internal/ai/status?tenantId=${TENANT_ID}`);
    expect(res.status).toBe(401);
  });

  test("rejects a wrong token", async () => {
    const app = createApp(stubServices, "correct-token");
    const res = await app.request(`/internal/ai/status?tenantId=${TENANT_ID}`, {
      headers: { "X-Internal-Token": "wrong-token" }
    });
    expect(res.status).toBe(401);
  });

  test("accepts the correct token", async () => {
    const app = createApp(stubServices, "correct-token");
    const res = await app.request(`/internal/ai/status?tenantId=${TENANT_ID}`, {
      headers: { "X-Internal-Token": "correct-token" }
    });
    expect(res.status).toBe(200);
  });

  test("fails closed when INTERNAL_SERVICE_TOKEN is not configured, even if a header is sent", async () => {
    const app = createApp(stubServices, undefined);
    const res = await app.request(`/internal/ai/status?tenantId=${TENANT_ID}`, {
      headers: { "X-Internal-Token": "" }
    });
    expect(res.status).toBe(401);
  });
});
