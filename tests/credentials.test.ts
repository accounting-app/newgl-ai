import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createServiceContainer } from "../src/application/create-service-container";
import type { ServiceContainer } from "../src/application/service-container";
import { createApp } from "../src/http/app";
import { getSql } from "../src/infra/postgres/client";
import { createPostgresCredentialsRepository } from "../src/infra/postgres/credentials-repository";
import { createPostgresUsageRepository } from "../src/infra/postgres/usage-repository";
import { createFakeKeyValidator } from "./helpers/fake-key-validator";
import { createTestTenant, deleteTestTenant, localPostgresIsReachable } from "./helpers/local-postgres";

/**
 * Integration tests for Phase 3 credential management (AI_INTEGRATION_PLAN.md
 * Part 4). Requires the same local Supabase/Postgres stack as newgl-api
 * (`bunx supabase start` from newgl-api); skips with a warning otherwise,
 * mirroring newgl-api's tests/bean-check.test.ts "optional" pattern.
 */

const INTERNAL_TOKEN = "test-internal-token";
const VALID_KEY = "sk-ant-test-valid-1234567890abcdef";
const INVALID_KEY = "sk-ant-test-invalid-key-wont-pass-1234";

describe("credentials service + /internal/ai/credentials, /internal/ai/status", () => {
  let app: ReturnType<typeof createApp>;
  let services: ServiceContainer;
  let reachable = false;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    reachable = await localPostgresIsReachable();
    if (!reachable) {
      console.warn(
        "Local Postgres not reachable -- skipping newgl-ai credentials integration tests. " +
          "Run `bunx supabase start` from newgl-api to enable them."
      );
      return;
    }
    const sql = getSql();
    services = createServiceContainer({
      credentialsRepository: createPostgresCredentialsRepository(sql),
      usageRepository: createPostgresUsageRepository(sql),
      keyValidator: createFakeKeyValidator(),
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

  test("status is 'platform' before any key is configured", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("credentials-status-default");

    const res = await app.request(`/internal/ai/status?tenantId=${tenantId}`, {
      headers: { "X-Internal-Token": INTERNAL_TOKEN }
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keySource: string; maskedKey: string | null };
    expect(body.keySource).toBe("platform");
    expect(body.maskedKey).toBeNull();
  });

  test("PUT rejects a key the validator rejects, and nothing is stored", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("credentials-reject");

    const res = await app.request("/internal/ai/credentials", {
      method: "PUT",
      headers: { "X-Internal-Token": INTERNAL_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId, apiKey: INVALID_KEY })
    });
    expect(res.status).toBe(400);

    const status = await services.credentialsService.getStatus(tenantId);
    expect(status.keySource).toBe("platform");
  });

  test("PUT with a valid key stores it encrypted and returns a masked credential", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("credentials-set");

    const res = await app.request("/internal/ai/credentials", {
      method: "PUT",
      headers: { "X-Internal-Token": INTERNAL_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId, apiKey: VALID_KEY })
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { maskedKey: string; model: string; validatedAt: string };
    expect(body.maskedKey).toBe("sk-ant-...cdef");
    expect(body.maskedKey).not.toContain(VALID_KEY);
    expect(body.model).toBe("claude-opus-4-8");

    // The row in Postgres never holds the plaintext key.
    const rows = await getSql()`select ciphertext from ai_credentials where tenant_id = ${tenantId}`;
    expect(JSON.stringify(rows)).not.toContain(VALID_KEY);

    const status = await services.credentialsService.getStatus(tenantId);
    expect(status.keySource).toBe("byok");
    expect(status.maskedKey).toBe("sk-ant-...cdef");
  });

  test("resolveKey decrypts the stored BYOK key exactly and never enforces quota for it", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("credentials-resolve-byok");
    await services.credentialsService.setCredential(tenantId, VALID_KEY);

    const resolved = await services.credentialsService.resolveKey(tenantId);
    expect(resolved.apiKey).toBe(VALID_KEY);
    expect(resolved.source).toBe("byok");
    expect(resolved.enforceQuota).toBe(false);
  });

  test("resolveKey falls back to the platform key with quota enforced when no BYOK key exists", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("credentials-resolve-platform");

    const resolved = await services.credentialsService.resolveKey(tenantId);
    expect(resolved.source).toBe("platform");
    expect(resolved.apiKey).toBe("sk-ant-platform-key-for-tests");
    expect(resolved.enforceQuota).toBe(true);
  });

  test("a BYOK key can carry a model override, reflected in status", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("credentials-model-override");

    await app.request("/internal/ai/credentials", {
      method: "PUT",
      headers: { "X-Internal-Token": INTERNAL_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId, apiKey: VALID_KEY, modelOverride: "claude-haiku-4" })
    });

    const status = await services.credentialsService.getStatus(tenantId);
    expect(status.model).toBe("claude-haiku-4");
  });

  test("DELETE removes the key and status reverts to platform", async () => {
    if (!reachable) return;
    const tenantId = await newTenant("credentials-delete");
    await services.credentialsService.setCredential(tenantId, VALID_KEY);

    const del = await app.request("/internal/ai/credentials", {
      method: "DELETE",
      headers: { "X-Internal-Token": INTERNAL_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId })
    });
    expect(del.status).toBe(204);

    const status = await services.credentialsService.getStatus(tenantId);
    expect(status.keySource).toBe("platform");

    const resolved = await services.credentialsService.resolveKey(tenantId);
    expect(resolved.source).toBe("platform");
  });

  test("one tenant's key is never visible to another tenant", async () => {
    if (!reachable) return;
    const tenantA = await newTenant("credentials-isolation-a");
    const tenantB = await newTenant("credentials-isolation-b");
    await services.credentialsService.setCredential(tenantA, VALID_KEY);

    const statusB = await services.credentialsService.getStatus(tenantB);
    expect(statusB.keySource).toBe("platform");
    expect(statusB.maskedKey).toBeNull();
  });
});
