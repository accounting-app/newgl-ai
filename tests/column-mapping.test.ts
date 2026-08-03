import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { ColumnMappingServiceImpl } from "../src/application/services/column-mapping-service";
import { CredentialsServiceImpl } from "../src/application/services/credentials-service";
import { UsageServiceImpl } from "../src/application/services/usage-service";
import { createServiceContainer } from "../src/application/create-service-container";
import type { ServiceContainer } from "../src/application/service-container";
import { AiQuotaExceededError } from "../src/domain/quota";
import { COLUMN_MAPPING_TARGET_FIELDS } from "../src/domain/models";
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
const CSV_HEADER = ["Date", "Description", "Amount", "Check #"];
const SAMPLE_ROWS = [["2024-01-01", "Coffee Shop", "-4.50", "1001"]];

describe("column mapping service + /internal/ai/column-mapping", () => {
  let app: ReturnType<typeof createApp>;
  let services: ServiceContainer;
  let reachable = false;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    reachable = await localPostgresIsReachable();
    if (!reachable) {
      console.warn(
        "Local Postgres not reachable -- skipping newgl-ai column-mapping integration tests. " +
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

  test("suggests a mapping for a platform-key tenant well under quota, and records one action", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("colmap-basic");

    const result = await services.columnMappingService.suggestMapping({
      tenantId,
      csvHeader: CSV_HEADER,
      sampleRows: SAMPLE_ROWS,
      limits: { monthlyAiActions: 200, monthlyTokenCap: 500_000 }
    });

    expect(result.mapping).toEqual({ transactionDate: 0, payee: 1, amount: 2, referenceNumber: 3, memo: null });
    expect(result.keySource).toBe("platform");
    expect(result.usage.actions).toBe(1);

    const { summary } = await services.usageService.getUsageSummary(tenantId);
    expect(summary.totalActions).toBe(1);
    expect(summary.byKeySource.platform.actions).toBe(1);
  });

  test("throws AiQuotaExceededError for a platform-key tenant already at the limit, and records nothing new", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("colmap-quota");
    await services.usageService.recordUsage({
      tenantId,
      feature: "column-mapping",
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
      services.columnMappingService.suggestMapping({
        tenantId,
        csvHeader: CSV_HEADER,
        sampleRows: SAMPLE_ROWS,
        limits: { monthlyAiActions: 200, monthlyTokenCap: 500_000 }
      })
    ).rejects.toBeInstanceOf(AiQuotaExceededError);

    const { summary } = await services.usageService.getUsageSummary(tenantId);
    expect(summary.totalActions).toBe(200); // unchanged -- no AI call was made
  });

  test("BYOK tenants bypass quota entirely, even far over the platform limit", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("colmap-byok-bypass");
    await services.credentialsService.setCredential(tenantId, VALID_KEY);
    await services.usageService.recordUsage({
      tenantId,
      feature: "column-mapping",
      model: "claude-opus-4-8",
      keySource: "byok",
      actions: 10_000, // way over any plan's limit
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0
    });

    const result = await services.columnMappingService.suggestMapping({
      tenantId,
      csvHeader: CSV_HEADER,
      sampleRows: SAMPLE_ROWS,
      limits: { monthlyAiActions: 200, monthlyTokenCap: 500_000 }
    });
    expect(result.keySource).toBe("byok");
  });

  test("discards an out-of-range or malformed index instead of trusting the model", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("colmap-malicious");

    // A hostile/buggy AnthropicClient returning garbage -- the service must
    // never pass this straight through (AI_INTEGRATION_PLAN.md Part 7).
    const maliciousClient = {
      suggestColumnMapping: async () => ({
        mapping: {
          transactionDate: 99, // out of range
          payee: -1, // negative
          amount: 1.5, // not an integer
          referenceNumber: "1" as unknown as number, // not a number at all
          memo: null
        },
        usage: { inputTokens: 10, outputTokens: 5 }
      }),
      normalizePayees: async () => ({ results: [], usage: { inputTokens: 0, outputTokens: 0 } })
    };
    const credentialsService = new CredentialsServiceImpl(
      createPostgresCredentialsRepository(getSql()),
      createFakeKeyValidator(),
      "Eo0pUoxiqHb5h1QlSUcD07lVfiqi3kOcovq2CaSmLew=",
      "sk-ant-platform-key-for-tests",
      "claude-opus-4-8"
    );
    const usageService = new UsageServiceImpl(createPostgresUsageRepository(getSql()));
    const service = new ColumnMappingServiceImpl(
      credentialsService,
      usageService,
      maliciousClient,
      COLUMN_MAPPING_TARGET_FIELDS
    );

    const result = await service.suggestMapping({
      tenantId,
      csvHeader: CSV_HEADER, // length 4 -- valid indices are 0..3
      sampleRows: SAMPLE_ROWS,
      limits: { monthlyAiActions: 200, monthlyTokenCap: 500_000 }
    });

    expect(result.mapping).toEqual({
      transactionDate: null,
      payee: null,
      memo: null,
      amount: null,
      referenceNumber: null
    });
  });

  test("POST /internal/ai/column-mapping returns 200 with a valid mapping", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("colmap-route-ok");

    const res = await app.request("/internal/ai/column-mapping", {
      method: "POST",
      headers: { "X-Internal-Token": INTERNAL_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId,
        csvHeader: CSV_HEADER,
        sampleRows: SAMPLE_ROWS,
        monthlyAiActions: 200,
        monthlyTokenCap: 500_000
      })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mapping: Record<string, number | null> };
    expect(body.mapping.transactionDate).toBe(0);
  });

  test("POST /internal/ai/column-mapping returns 402 when the platform-key tenant is over quota", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("colmap-route-402");
    await services.usageService.recordUsage({
      tenantId,
      feature: "column-mapping",
      model: "claude-opus-4-8",
      keySource: "platform",
      actions: 500,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0
    });

    const res = await app.request("/internal/ai/column-mapping", {
      method: "POST",
      headers: { "X-Internal-Token": INTERNAL_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId,
        csvHeader: CSV_HEADER,
        sampleRows: SAMPLE_ROWS,
        monthlyAiActions: 200,
        monthlyTokenCap: 500_000
      })
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { limitType: string } };
    expect(body.error.limitType).toBe("actions");
  });

  test("POST /internal/ai/column-mapping without limits still succeeds for a BYOK tenant", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("colmap-route-byok-no-limits");
    await services.credentialsService.setCredential(tenantId, VALID_KEY);

    const res = await app.request("/internal/ai/column-mapping", {
      method: "POST",
      headers: { "X-Internal-Token": INTERNAL_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId, csvHeader: CSV_HEADER, sampleRows: SAMPLE_ROWS })
    });
    expect(res.status).toBe(200);
  });

  test("POST /internal/ai/column-mapping without limits fails clearly for a platform-key tenant", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("colmap-route-platform-no-limits");

    const res = await app.request("/internal/ai/column-mapping", {
      method: "POST",
      headers: { "X-Internal-Token": INTERNAL_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId, csvHeader: CSV_HEADER, sampleRows: SAMPLE_ROWS })
    });
    expect(res.status).toBe(400);
  });
});
