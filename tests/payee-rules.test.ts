import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createServiceContainer } from "../src/application/create-service-container";
import type { ServiceContainer } from "../src/application/service-container";
import { AiQuotaExceededError } from "../src/domain/quota";
import { createApp } from "../src/http/app";
import { getSql } from "../src/infra/postgres/client";
import { createPostgresCredentialsRepository } from "../src/infra/postgres/credentials-repository";
import { createPostgresPayeeRulesRepository } from "../src/infra/postgres/payee-rules-repository";
import { createPostgresUsageRepository } from "../src/infra/postgres/usage-repository";
import { createFakeAnthropicClient } from "../src/testing/fake-anthropic-client";
import { createFakeKeyValidator } from "./helpers/fake-key-validator";
import { createTestTenant, deleteTestTenant, localPostgresIsReachable } from "./helpers/local-postgres";

const INTERNAL_TOKEN = "test-internal-token";
const VALID_KEY = "sk-ant-test-valid-1234567890abcdef";

describe("payee rules service + /internal/ai/payees/normalize + /internal/ai/rules/learn", () => {
  let app: ReturnType<typeof createApp>;
  let services: ServiceContainer;
  let reachable = false;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    reachable = await localPostgresIsReachable();
    if (!reachable) {
      console.warn(
        "Local Postgres not reachable -- skipping newgl-ai payee-rules integration tests. " +
          "Run `bunx supabase start` from newgl-api to enable them."
      );
      return;
    }
    const sql = getSql();
    services = createServiceContainer({
      credentialsRepository: createPostgresCredentialsRepository(sql),
      usageRepository: createPostgresUsageRepository(sql),
      payeeRulesRepository: createPostgresPayeeRulesRepository(sql),
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

  test("normalizes a fresh batch via the AI client and records exactly one action for the whole batch", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("payee-basic");

    const result = await services.payeeRulesService.suggestNormalization({
      tenantId,
      payees: ["SQ *COFFEE SHOP #4432", "UBER TRIP 8213409"],
      limits: { monthlyAiActions: 200, monthlyTokenCap: 500_000 }
    });

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({
      payee: "SQ *COFFEE SHOP #4432",
      canonicalPayee: "Coffee Shop",
      resolvedBy: "ai",
      accountId: null
    });
    expect(result.results[1]).toMatchObject({ payee: "UBER TRIP 8213409", canonicalPayee: "Uber Trip", resolvedBy: "ai" });
    expect(result.keySource).toBe("platform");
    expect(result.usage.actions).toBe(1); // one batch call, not one per payee

    const { summary } = await services.usageService.getUsageSummary(tenantId);
    expect(summary.totalActions).toBe(1);
  });

  test("a second, later batch with the same merchant (different store number) resolves from the rule with zero API calls", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("payee-cascade-hit");

    const first = await services.payeeRulesService.suggestNormalization({
      tenantId,
      payees: ["SQ *COFFEE SHOP #4432"],
      limits: { monthlyAiActions: 200, monthlyTokenCap: 500_000 }
    });
    expect(first.usage.actions).toBe(1);

    const second = await services.payeeRulesService.suggestNormalization({
      tenantId,
      payees: ["SQ *Coffee Shop #7781"], // different store number, same merchant
      limits: { monthlyAiActions: 200, monthlyTokenCap: 500_000 }
    });

    expect(second.usage.actions).toBe(0); // no AI call -- the cascade's whole point
    expect(second.keySource).toBeNull(); // key was never even resolved
    expect(second.results[0]).toMatchObject({ canonicalPayee: "Coffee Shop", resolvedBy: "rule" });

    const { summary } = await services.usageService.getUsageSummary(tenantId);
    expect(summary.totalActions).toBe(1); // unchanged since the first call
  });

  test("a batch that mixes a known and an unknown payee only calls the AI for the unknown one", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("payee-mixed-batch");

    await services.payeeRulesService.suggestNormalization({
      tenantId,
      payees: ["SQ *COFFEE SHOP #4432"],
      limits: { monthlyAiActions: 200, monthlyTokenCap: 500_000 }
    });

    const result = await services.payeeRulesService.suggestNormalization({
      tenantId,
      payees: ["SQ *Coffee Shop #7781", "PAYPAL *ACME LLC"],
      limits: { monthlyAiActions: 200, monthlyTokenCap: 500_000 }
    });

    expect(result.usage.actions).toBe(1); // one call for the one unresolved payee
    const byPayee = Object.fromEntries(result.results.map((r) => [r.payee, r]));
    expect(byPayee["SQ *Coffee Shop #7781"]).toMatchObject({ resolvedBy: "rule", canonicalPayee: "Coffee Shop" });
    expect(byPayee["PAYPAL *ACME LLC"]).toMatchObject({ resolvedBy: "ai" });
  });

  test("throws AiQuotaExceededError for a platform-key tenant already at the limit, without touching the rules table", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("payee-quota");
    await services.usageService.recordUsage({
      tenantId,
      feature: "payee-normalization",
      model: "claude-opus-4-8",
      keySource: "platform",
      actions: 200,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0
    });

    await expect(
      services.payeeRulesService.suggestNormalization({
        tenantId,
        payees: ["SOME NEW PAYEE"],
        limits: { monthlyAiActions: 200, monthlyTokenCap: 500_000 }
      })
    ).rejects.toBeInstanceOf(AiQuotaExceededError);

    const { summary } = await services.usageService.getUsageSummary(tenantId);
    expect(summary.totalActions).toBe(200); // unchanged
  });

  test("BYOK tenants bypass quota entirely, even far over the platform limit", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("payee-byok-bypass");
    await services.credentialsService.setCredential(tenantId, VALID_KEY);
    await services.usageService.recordUsage({
      tenantId,
      feature: "payee-normalization",
      model: "claude-opus-4-8",
      keySource: "byok",
      actions: 10_000,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0
    });

    const result = await services.payeeRulesService.suggestNormalization({
      tenantId,
      payees: ["SOME NEW PAYEE"],
      limits: { monthlyAiActions: 200, monthlyTokenCap: 500_000 }
    });
    expect(result.keySource).toBe("byok");
  });

  test("learnRules writes a confirmed (payee -> accountId) pair that later normalization calls surface with zero API calls", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("payee-learn");

    const learned = await services.payeeRulesService.learnRules({
      tenantId,
      rules: [{ payee: "ACME OFFICE SUPPLY #99", accountId: "Expenses:Office:Supplies", canonicalPayee: "Acme Office Supply" }]
    });
    expect(learned.learned).toBe(1);

    const result = await services.payeeRulesService.suggestNormalization({
      tenantId,
      payees: ["ACME OFFICE SUPPLY #12"], // different store number
      limits: { monthlyAiActions: 200, monthlyTokenCap: 500_000 }
    });

    expect(result.usage.actions).toBe(0);
    expect(result.results[0]).toMatchObject({
      resolvedBy: "rule",
      canonicalPayee: "Acme Office Supply",
      accountId: "Expenses:Office:Supplies"
    });

    const { summary } = await services.usageService.getUsageSummary(tenantId);
    expect(summary.totalActions).toBe(0); // learning never touches usage/quota
  });

  test("a later user confirmation upgrades an AI-guessed rule with an account, without losing the canonical name", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("payee-upgrade-ai-rule");

    await services.payeeRulesService.suggestNormalization({
      tenantId,
      payees: ["SQ *COFFEE SHOP #4432"],
      limits: { monthlyAiActions: 200, monthlyTokenCap: 500_000 }
    });

    await services.payeeRulesService.learnRules({
      tenantId,
      rules: [{ payee: "SQ *Coffee Shop #7781", accountId: "Expenses:Food:Coffee" }]
    });

    const result = await services.payeeRulesService.suggestNormalization({
      tenantId,
      payees: ["SQ *Coffee Shop #9999"],
      limits: { monthlyAiActions: 200, monthlyTokenCap: 500_000 }
    });

    expect(result.results[0]).toMatchObject({
      canonicalPayee: "Coffee Shop",
      accountId: "Expenses:Food:Coffee"
    });
  });

  test("POST /internal/ai/payees/normalize returns 200 with normalized results", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("payee-route-ok");

    const res = await app.request("/internal/ai/payees/normalize", {
      method: "POST",
      headers: { "X-Internal-Token": INTERNAL_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId,
        payees: ["SQ *COFFEE SHOP #4432"],
        monthlyAiActions: 200,
        monthlyTokenCap: 500_000
      })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ canonicalPayee: string }> };
    expect(body.results[0]!.canonicalPayee).toBe("Coffee Shop");
  });

  test("POST /internal/ai/payees/normalize returns 402 when the platform-key tenant is over quota", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("payee-route-402");
    await services.usageService.recordUsage({
      tenantId,
      feature: "payee-normalization",
      model: "claude-opus-4-8",
      keySource: "platform",
      actions: 500,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0
    });

    const res = await app.request("/internal/ai/payees/normalize", {
      method: "POST",
      headers: { "X-Internal-Token": INTERNAL_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId, payees: ["A BRAND NEW PAYEE"], monthlyAiActions: 200, monthlyTokenCap: 500_000 })
    });
    expect(res.status).toBe(402);
  });

  test("POST /internal/ai/rules/learn returns 200 and an ack count", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("payee-route-learn");

    const res = await app.request("/internal/ai/rules/learn", {
      method: "POST",
      headers: { "X-Internal-Token": INTERNAL_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId,
        rules: [{ payee: "ACME OFFICE SUPPLY #99", accountId: "Expenses:Office:Supplies" }]
      })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { learned: number };
    expect(body.learned).toBe(1);
  });

  test("POST /internal/ai/rules/learn rejects an empty rules array", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("payee-route-learn-empty");

    const res = await app.request("/internal/ai/rules/learn", {
      method: "POST",
      headers: { "X-Internal-Token": INTERNAL_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId, rules: [] })
    });
    expect(res.status).toBe(400);
  });
});
