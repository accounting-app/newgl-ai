import type { AnthropicClient } from "@/application/contracts";
import type { ColumnMappingResult, PayeeNormalizationClientResult } from "@/domain/models";

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
/**
 * Deterministic stand-in for a payee cleanup call: strips the same kind of
 * processor noise `normalizePayeeKey` matches on, then title-cases what's
 * left. Doesn't need to match the real model's exact wording -- tests only
 * assert on the shape of the response and that it survives a batch call.
 */
function fakeCanonicalize(payee: string): string {
  const cleaned = payee
    .replace(/^(sq|sp|tst|pp)\s*\*/i, "")
    .replace(/#\s*\d+/g, "")
    .replace(/\b\d{4,}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return payee;
  return cleaned
    .toLowerCase()
    .split(" ")
    .map((word) => (word.length > 0 ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ");
}

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
    },

    async normalizePayees({ payees }): Promise<PayeeNormalizationClientResult> {
      return {
        results: payees.map((payee) => ({ payee, canonicalPayee: fakeCanonicalize(payee) })),
        usage: { inputTokens: 40 + payees.length * 10, outputTokens: 10 + payees.length * 5 }
      };
    }
  };
}
