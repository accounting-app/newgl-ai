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

const ACCOUNTS = [
  { id: "acc-cash", name: "Cash", category: "BANK" },
  { id: "acc-coffee", name: "Coffee", category: "EXPENSE" },
  { id: "acc-consulting-income", name: "Consulting Income", category: "INCOME" }
];

describe("categorization service + /internal/ai/categorize", () => {
  let app: ReturnType<typeof createApp>;
  let services: ServiceContainer;
  let reachable = false;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    reachable = await localPostgresIsReachable();
    if (!reachable) {
      console.warn(
        "Local Postgres not reachable -- skipping newgl-ai categorization integration tests. " +
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

  test("suggests an account for each transaction and records one action per AI-resolved row", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("categorize-basic");

    const result = await services.categorizationService.suggestCategorization({
      tenantId,
      accounts: ACCOUNTS,
      transactions: [
        { payee: "Coffee Shop", amount: -4.5 },
        { payee: "Consulting Income", amount: 1000 }
      ],
      limits: { monthlyAiActions: 200, monthlyTokenCap: 500_000 }
    });

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({ accountId: "acc-coffee", resolvedBy: "ai" });
    expect(result.results[1]).toMatchObject({ accountId: "acc-consulting-income", resolvedBy: "ai" });
    expect(result.keySource).toBe("platform");
    // 2 rows sent to the model = 2 actions -- unlike column-mapping/payee
    // normalization, this is metered per row, not per batch (Part 5).
    expect(result.usage.actions).toBe(2);

    const { summary } = await services.usageService.getUsageSummary(tenantId);
    expect(summary.totalActions).toBe(2);
  });

  test("falls back to the amount-sign hint when no keyword matches the payee", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("categorize-sign-fallback");

    const result = await services.categorizationService.suggestCategorization({
      tenantId,
      accounts: ACCOUNTS,
      transactions: [
        { payee: "Some Unknown Vendor", amount: -20 },
        { payee: "Some Unknown Client", amount: 500 }
      ],
      limits: { monthlyAiActions: 200, monthlyTokenCap: 500_000 }
    });

    expect(result.results[0]).toMatchObject({ accountId: "acc-coffee" }); // first EXPENSE account
    expect(result.results[1]).toMatchObject({ accountId: "acc-consulting-income" }); // first INCOME account
  });

  test("a payee previously confirmed via learnRules resolves from the rule with zero new actions", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("categorize-cascade-hit");

    await services.payeeRulesService.learnRules({
      tenantId,
      rules: [{ payee: "SQ *COFFEE SHOP #4432", accountId: "acc-coffee" }]
    });

    const result = await services.categorizationService.suggestCategorization({
      tenantId,
      accounts: ACCOUNTS,
      transactions: [{ payee: "SQ *Coffee Shop #7781", amount: -5 }], // different store number, same merchant
      limits: { monthlyAiActions: 200, monthlyTokenCap: 500_000 }
    });

    expect(result.usage.actions).toBe(0); // no AI call
    expect(result.keySource).toBeNull(); // key never resolved
    expect(result.results[0]).toMatchObject({ accountId: "acc-coffee", confidence: 1, resolvedBy: "rule" });

    const { summary } = await services.usageService.getUsageSummary(tenantId);
    expect(summary.totalActions).toBe(0);
  });

  test("falls through to AI when a learned rule points at an account that no longer exists", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("categorize-stale-rule");

    await services.payeeRulesService.learnRules({
      tenantId,
      rules: [{ payee: "OLD VENDOR", accountId: "acc-deleted-long-ago" }]
    });

    const result = await services.categorizationService.suggestCategorization({
      tenantId,
      accounts: ACCOUNTS, // "acc-deleted-long-ago" isn't in this chart
      transactions: [{ payee: "OLD VENDOR", amount: -10 }],
      limits: { monthlyAiActions: 200, monthlyTokenCap: 500_000 }
    });

    expect(result.results[0]!.resolvedBy).toBe("ai");
    expect(result.usage.actions).toBe(1);
  });

  test("a mixed batch only sends the AI the rows the cascade couldn't resolve", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("categorize-mixed-batch");

    await services.payeeRulesService.learnRules({
      tenantId,
      rules: [{ payee: "SQ *COFFEE SHOP #4432", accountId: "acc-coffee" }]
    });

    const result = await services.categorizationService.suggestCategorization({
      tenantId,
      accounts: ACCOUNTS,
      transactions: [
        { payee: "SQ *Coffee Shop #7781", amount: -5 }, // rule hit
        { payee: "Consulting Income", amount: 1000 } // needs AI
      ],
      limits: { monthlyAiActions: 200, monthlyTokenCap: 500_000 }
    });

    expect(result.usage.actions).toBe(1); // only the second row reached the model
    expect(result.results[0]).toMatchObject({ resolvedBy: "rule", accountId: "acc-coffee" });
    expect(result.results[1]).toMatchObject({ resolvedBy: "ai", accountId: "acc-consulting-income" });
  });

  test("discards an out-of-range or malformed account index instead of trusting the model", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("categorize-malicious");

    const maliciousClient = {
      suggestColumnMapping: async () => ({ mapping: {}, usage: { inputTokens: 0, outputTokens: 0 } }),
      normalizePayees: async () => ({ results: [], usage: { inputTokens: 0, outputTokens: 0 } }),
      categorizeTransactions: async () => ({
        results: [
          { index: 0, accountIndex: 99, confidence: 0.9 }, // out of range
          { index: 1, accountIndex: -1, confidence: 0.9 }, // negative
          { index: 2, accountIndex: 1.5, confidence: 0.9 }, // not an integer
          { index: 3, accountIndex: null, confidence: 2 } // confidence out of [0,1]
        ],
        usage: { inputTokens: 10, outputTokens: 5 }
      })
    };

    const services2 = createServiceContainer({
      credentialsRepository: createPostgresCredentialsRepository(getSql()),
      usageRepository: createPostgresUsageRepository(getSql()),
      payeeRulesRepository: createPostgresPayeeRulesRepository(getSql()),
      keyValidator: createFakeKeyValidator(),
      anthropicClient: maliciousClient,
      encryptionKey: "Eo0pUoxiqHb5h1QlSUcD07lVfiqi3kOcovq2CaSmLew=",
      platformApiKey: "sk-ant-platform-key-for-tests",
      platformModel: "claude-opus-4-8"
    });

    const result = await services2.categorizationService.suggestCategorization({
      tenantId,
      accounts: ACCOUNTS, // length 3 -- valid indices are 0..2
      transactions: [
        { payee: "A", amount: -1 },
        { payee: "B", amount: -1 },
        { payee: "C", amount: -1 },
        { payee: "D", amount: -1 }
      ],
      limits: { monthlyAiActions: 200, monthlyTokenCap: 500_000 }
    });

    expect(result.results.map((r) => r.accountId)).toEqual([null, null, null, null]);
    expect(result.results[3]!.confidence).toBeNull(); // malformed confidence discarded too
  });

  test("throws AiQuotaExceededError for a platform-key tenant already at the limit, without touching the rules table", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("categorize-quota");
    await services.usageService.recordUsage({
      tenantId,
      feature: "categorization",
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
      services.categorizationService.suggestCategorization({
        tenantId,
        accounts: ACCOUNTS,
        transactions: [{ payee: "Some New Payee", amount: -1 }],
        limits: { monthlyAiActions: 200, monthlyTokenCap: 500_000 }
      })
    ).rejects.toBeInstanceOf(AiQuotaExceededError);

    const { summary } = await services.usageService.getUsageSummary(tenantId);
    expect(summary.totalActions).toBe(200);
  });

  test("BYOK tenants bypass quota entirely, even far over the platform limit", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("categorize-byok-bypass");
    await services.credentialsService.setCredential(tenantId, VALID_KEY);
    await services.usageService.recordUsage({
      tenantId,
      feature: "categorization",
      model: "claude-opus-4-8",
      keySource: "byok",
      actions: 10_000,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0
    });

    const result = await services.categorizationService.suggestCategorization({
      tenantId,
      accounts: ACCOUNTS,
      transactions: [{ payee: "Some New Payee", amount: -1 }],
      limits: { monthlyAiActions: 200, monthlyTokenCap: 500_000 }
    });
    expect(result.keySource).toBe("byok");
  });

  test("POST /internal/ai/categorize returns 200 with suggestions", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("categorize-route-ok");

    const res = await app.request("/internal/ai/categorize", {
      method: "POST",
      headers: { "X-Internal-Token": INTERNAL_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId,
        accounts: ACCOUNTS,
        transactions: [{ payee: "Coffee Shop", amount: -4.5 }],
        monthlyAiActions: 200,
        monthlyTokenCap: 500_000
      })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ accountId: string | null }> };
    expect(body.results[0]!.accountId).toBe("acc-coffee");
  });

  test("POST /internal/ai/categorize returns 402 when the platform-key tenant is over quota", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("categorize-route-402");
    await services.usageService.recordUsage({
      tenantId,
      feature: "categorization",
      model: "claude-opus-4-8",
      keySource: "platform",
      actions: 500,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0
    });

    const res = await app.request("/internal/ai/categorize", {
      method: "POST",
      headers: { "X-Internal-Token": INTERNAL_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId,
        accounts: ACCOUNTS,
        transactions: [{ payee: "Some New Payee", amount: -1 }],
        monthlyAiActions: 200,
        monthlyTokenCap: 500_000
      })
    });
    expect(res.status).toBe(402);
  });

  test("POST /internal/ai/categorize without limits still succeeds for a BYOK tenant", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("categorize-route-byok-no-limits");
    await services.credentialsService.setCredential(tenantId, VALID_KEY);

    const res = await app.request("/internal/ai/categorize", {
      method: "POST",
      headers: { "X-Internal-Token": INTERNAL_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId, accounts: ACCOUNTS, transactions: [{ payee: "Coffee Shop", amount: -4.5 }] })
    });
    expect(res.status).toBe(200);
  });

  test("POST /internal/ai/categorize without limits fails clearly for a platform-key tenant", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("categorize-route-platform-no-limits");

    const res = await app.request("/internal/ai/categorize", {
      method: "POST",
      headers: { "X-Internal-Token": INTERNAL_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId, accounts: ACCOUNTS, transactions: [{ payee: "Coffee Shop", amount: -4.5 }] })
    });
    expect(res.status).toBe(400);
  });

  test("POST /internal/ai/categorize rejects an empty transactions array", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("categorize-route-bad-input");

    const res = await app.request("/internal/ai/categorize", {
      method: "POST",
      headers: { "X-Internal-Token": INTERNAL_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId, accounts: ACCOUNTS, transactions: [] })
    });
    expect(res.status).toBe(400);
  });
});
