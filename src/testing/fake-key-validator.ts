import type { AnthropicKeyValidator, KeyValidationResult } from "@/application/contracts";

/**
 * Deterministic stand-in for the real Anthropic key validator, wired in at
 * boot only when AI_FAKE_KEY_VALIDATION=true (see src/index.ts). Exists so
 * that both this service's own tests and newgl-api's cross-service
 * integration tests (which spawn a real newgl-ai process) never make a
 * network call to Anthropic or need a real account. Any key starting with
 * "sk-ant-test-valid" is treated as valid -- never wire this in when that
 * env var isn't explicitly set to "true".
 */
export function createFakeKeyValidator(model = "claude-opus-4-8"): AnthropicKeyValidator {
  return {
    async validate(apiKey: string): Promise<KeyValidationResult> {
      if (apiKey.startsWith("sk-ant-test-valid")) {
        return { valid: true, model };
      }
      return { valid: false, reason: "fake validator rejected this key" };
    }
  };
}
