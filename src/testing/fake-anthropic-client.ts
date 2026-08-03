import type { AnthropicClient } from "@/application/contracts";
import type { CategorizationClientResult, ColumnMappingResult, PayeeNormalizationClientResult } from "@/domain/models";

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
    },

    async categorizeTransactions({ accounts, transactions }): Promise<CategorizationClientResult> {
      const results = transactions.map((t) => {
        const lowerPayee = t.payee.toLowerCase();
        // 1. keyword match, either direction -- deliberately loose since
        // this only needs to exercise the pipeline in tests, not be a good
        // classifier.
        let match = accounts.find(
          (a) => lowerPayee.includes(a.name.toLowerCase()) || a.name.toLowerCase().includes(lowerPayee)
        );
        // 2. fall back on the amount-sign hint from the plan: positive ->
        // an INCOME-ish account, negative -> an EXPENSE-ish one.
        if (!match) {
          const wantsIncome = t.amount > 0;
          match = accounts.find((a) => a.category.toUpperCase().includes(wantsIncome ? "INCOME" : "EXPENSE"));
        }
        return { index: t.index, accountIndex: match ? match.index : null, confidence: match ? 0.8 : null };
      });

      return {
        results,
        usage: { inputTokens: 200 + transactions.length * 15, outputTokens: 10 + transactions.length * 5 }
      };
    }
  };
}
