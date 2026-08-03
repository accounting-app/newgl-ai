import type { AnthropicClient } from "@/application/contracts";
import type { ColumnMappingResult } from "@/domain/models";

const FIELD_KEYWORDS: Record<string, string[]> = {
  transactionDate: ["date"],
  payee: ["payee", "description", "merchant", "name"],
  memo: ["memo", "note", "notes"],
  amount: ["amount", "debit", "credit"],
  referenceNumber: ["ref", "reference", "check", "id"]
};

/**
 * Deterministic stand-in for createAnthropicClient -- matches each target
 * field to the first CSV header column whose lowercased name contains one
 * of its keywords. Wired in only when AI_TEST_MODE=true (see src/index.ts),
 * so tests and local demos never call the real Anthropic API.
 */
export function createFakeAnthropicClient(): AnthropicClient {
  return {
    async suggestColumnMapping({ targetFields, csvHeader }): Promise<ColumnMappingResult> {
      const lowerHeader = csvHeader.map((column) => column.toLowerCase());
      const mapping: Record<string, number | null> = {};

      for (const field of targetFields) {
        const keywords = FIELD_KEYWORDS[field] ?? [field.toLowerCase()];
        const index = lowerHeader.findIndex((column) => keywords.some((keyword) => column.includes(keyword)));
        mapping[field] = index === -1 ? null : index;
      }

      return { mapping, usage: { inputTokens: 120, outputTokens: 24 } };
    }
  };
}
