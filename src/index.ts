import { createServiceContainer } from "@/application/create-service-container";
import {
  AI_KEY_ENCRYPTION_KEY,
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL,
  APP_ENV,
  APP_PORT,
  INTERNAL_SERVICE_TOKEN
} from "@/configuration";
import { createApp } from "@/http/app";
import { createAnthropicClient } from "@/infra/anthropic/client";
import { createAnthropicKeyValidator } from "@/infra/anthropic/key-validator";
import { getSql } from "@/infra/postgres/client";
import { createPostgresCredentialsRepository } from "@/infra/postgres/credentials-repository";
import { createPostgresPayeeRulesRepository } from "@/infra/postgres/payee-rules-repository";
import { createPostgresUsageRepository } from "@/infra/postgres/usage-repository";
import { createFakeAnthropicClient } from "@/testing/fake-anthropic-client";
import { createFakeKeyValidator } from "@/testing/fake-key-validator";

if (!AI_KEY_ENCRYPTION_KEY) {
  throw new Error("AI_KEY_ENCRYPTION_KEY is not set -- required to store BYOK Anthropic keys.");
}
if (!INTERNAL_SERVICE_TOKEN) {
  console.warn(
    "[newgl-ai] WARNING: INTERNAL_SERVICE_TOKEN is not set -- every request will be rejected with 401."
  );
}
if (!ANTHROPIC_API_KEY) {
  console.warn(
    "[newgl-ai] WARNING: ANTHROPIC_API_KEY is not set -- tenants with no BYOK key will fail key resolution."
  );
}

// Test-only escape hatch: lets this service's own tests and newgl-api's
// cross-service integration tests (which spawn a real newgl-ai process)
// exercise key validation and AI calls without ever touching the real
// Anthropic API or needing a real account. Never set this outside tests.
const testMode = process.env.AI_TEST_MODE === "true";
if (testMode) {
  console.warn("[newgl-ai] AI_TEST_MODE=true -- using fake Anthropic key validation and responses. Test use only.");
}

const sql = getSql();
const services = createServiceContainer({
  credentialsRepository: createPostgresCredentialsRepository(sql),
  usageRepository: createPostgresUsageRepository(sql),
  payeeRulesRepository: createPostgresPayeeRulesRepository(sql),
  keyValidator: testMode ? createFakeKeyValidator(ANTHROPIC_MODEL) : createAnthropicKeyValidator(ANTHROPIC_MODEL),
  anthropicClient: testMode ? createFakeAnthropicClient() : createAnthropicClient(),
  encryptionKey: AI_KEY_ENCRYPTION_KEY,
  platformApiKey: ANTHROPIC_API_KEY,
  platformModel: ANTHROPIC_MODEL
});

const app = createApp(services, INTERNAL_SERVICE_TOKEN);
const { fetch } = app;
const port = APP_PORT;

console.log(`[newgl-ai] env=${APP_ENV} model=${ANTHROPIC_MODEL}`);

const server = Bun.serve({
  fetch: (request, serverInstance) => fetch(request, serverInstance),
  port
});

console.log(`[newgl-ai] listening on http://${server.hostname}:${port} (internal only)`);
