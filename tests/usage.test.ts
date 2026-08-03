import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createServiceContainer } from "../src/application/create-service-container";
import type { ServiceContainer } from "../src/application/service-container";
import { createApp } from "../src/http/app";
import { AiQuotaExceededError } from "../src/domain/quota";
import { getSql } from "../src/infra/postgres/client";
import { createPostgresCredentialsRepository } from "../src/infra/postgres/credentials-repository";
import { createPostgresUsageRepository } from "../src/infra/postgres/usage-repository";
import { createFakeAnthropicClient } from "../src/testing/fake-anthropic-client";
import { createFakeKeyValidator } from "./helpers/fake-key-validator";
import { createTestTenant, deleteTestTenant, localPostgresIsReachable } from "./helpers/local-postgres";

const INTERNAL_TOKEN = "test-internal-token";

function usageEntry(overrides: Partial<Parameters<ServiceContainer["usageService"]["recordUsage"]>[0]> = {}) {
  return {
    tenantId: "",
    feature: "categorize",
    model: "claude-opus-4-8",
    keySource: "platform" as const,
    actions: 1,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0.01,
    ...overrides
  };
}

describe("usage service + /internal/ai/usage", () => {
  let app: ReturnType<typeof createApp>;
  let services: ServiceContainer;
  let reachable = false;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    reachable = await localPostgresIsReachable();
    if (!reachable) {
      console.warn(
        "Local Postgres not reachable -- skipping newgl-ai usage integration tests. " +
          "Run `bunx supabase start` from newgl-api to enable them."
      );
      return;
    }
    const sql = getSql();
    services = createServiceContainer({
      credentialsRepository: createPostgresCredentialsRepository(sql),
      usageRepository: createPostgresUsageRepository(sql),
      keyValidator: createFakeKeyValidator(),
      anthropicClient: createFakeAnthropicClient(),
      encryptionKey: "Eo0pUoxiqHb5h1QlSUcD07lVfiqi3kOcovq2CaSmLew=",
      platformApiKey: "sk-ant-platform-key-for-tests",
      platformModel: "claude-opus-4-8"
    });
    app = createApp(services, INTERNAL_TOKEN);
  });

  afterAll(async () => {
    if (!reachable) return;
    for (const tenantId of tenantIds) {
      await deleteTestTenant(tenantId);
    }
  });

  async function newTenant(name: string): Promise<string> {
    const tenantId = await createTestTenant(name);
    tenantIds.push(tenantId);
    return tenantId;
  }

  test("a tenant with no usage yet summarizes to all zeros", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("usage-empty");

    const { summary } = await services.usageService.getUsageSummary(tenantId);
    expect(summary.totalActions).toBe(0);
    expect(summary.totalTokens).toBe(0);
  });

  test("recordUsage accumulates actions and tokens, split by key source", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("usage-accumulate");

    await services.usageService.recordUsage(usageEntry({ tenantId, keySource: "platform", actions: 3, inputTokens: 100, outputTokens: 50 }));
    await services.usageService.recordUsage(usageEntry({ tenantId, keySource: "platform", actions: 2, inputTokens: 40, outputTokens: 10 }));
    await services.usageService.recordUsage(usageEntry({ tenantId, keySource: "byok", actions: 7, inputTokens: 1000, outputTokens: 500 }));

    const { summary } = await services.usageService.getUsageSummary(tenantId);
    expect(summary.totalActions).toBe(12);
    expect(summary.byKeySource.platform.actions).toBe(5);
    expect(summary.byKeySource.platform.tokens).toBe(200); // 100+50+40+10
    expect(summary.byKeySource.byok.actions).toBe(7);
    expect(summary.byKeySource.byok.tokens).toBe(1500);
    expect(summary.totalTokens).toBe(1700);
  });

  test("GET /internal/ai/usage echoes back the limits it was passed", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("usage-http-limits");

    const res = await app.request(
      `/internal/ai/usage?tenantId=${tenantId}&monthlyAiActions=200&monthlyTokenCap=500000`,
      { headers: { "X-Internal-Token": INTERNAL_TOKEN } }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { limits: { monthlyAiActions: number; monthlyTokenCap: number } | null };
    expect(body.limits).toEqual({ monthlyAiActions: 200, monthlyTokenCap: 500000 });
  });

  test("GET /internal/ai/usage returns null limits when none are provided", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("usage-http-no-limits");

    const res = await app.request(`/internal/ai/usage?tenantId=${tenantId}`, {
      headers: { "X-Internal-Token": INTERNAL_TOKEN }
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { limits: unknown };
    expect(body.limits).toBeNull();
  });

  test("assertWithinQuota throws once recorded usage reaches the plan limit", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("usage-quota-exceeded");
    await services.usageService.recordUsage(usageEntry({ tenantId, actions: 200, inputTokens: 0, outputTokens: 0 }));

    await expect(services.usageService.assertWithinQuota(tenantId, { monthlyAiActions: 200, monthlyTokenCap: 500_000 })).rejects.toBeInstanceOf(
      AiQuotaExceededError
    );
  });

  test("assertWithinQuota does not throw when comfortably under the limit", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("usage-quota-ok");
    await services.usageService.recordUsage(usageEntry({ tenantId, actions: 5, inputTokens: 100, outputTokens: 50 }));

    await expect(
      services.usageService.assertWithinQuota(tenantId, { monthlyAiActions: 200, monthlyTokenCap: 500_000 })
    ).resolves.toBeUndefined();
  });

  test("usage is scoped per tenant -- one tenant's usage never bleeds into another's summary", async () => {
    if (!reachable) return;
    const tenantA = await newTenant("usage-isolation-a");
    const tenantB = await newTenant("usage-isolation-b");
    await services.usageService.recordUsage(usageEntry({ tenantId: tenantA, actions: 50 }));

    const { summary } = await services.usageService.getUsageSummary(tenantB);
    expect(summary.totalActions).toBe(0);
  });
});
