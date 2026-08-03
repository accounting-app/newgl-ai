import type { AnthropicKeyValidator, KeyValidationResult } from "@/application/contracts";

const ANTHROPIC_VERSION = "2023-06-01";

/**
 * "Validate on save" (AI_INTEGRATION_PLAN.md Part 4): count_tokens is a free
 * Anthropic endpoint, so this costs the tenant nothing and doesn't touch
 * their quota. Never call this from tests -- it's real network I/O against
 * a real account; tests use FakeAnthropicKeyValidator instead.
 */
export function createAnthropicKeyValidator(model: string): AnthropicKeyValidator {
  return {
    async validate(apiKey: string): Promise<KeyValidationResult> {
      try {
        const response = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "ping" }]
          })
        });

        if (response.ok) {
          return { valid: true, model };
        }
        if (response.status === 401 || response.status === 403) {
          return { valid: false, reason: "Anthropic rejected the key (unauthorized)" };
        }
        return { valid: false, reason: `Anthropic returned ${response.status}` };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown network error";
        return { valid: false, reason: `Could not reach Anthropic: ${message}` };
      }
    }
  };
}
