import type {
  AnthropicClient,
  CategorizationService,
  CredentialsService,
  PayeeRulesRepository,
  UsageService
} from "@/application/contracts";
import type { CategorizationAccount, CategorizationSuggestion, CategorizationTransaction, KeySource, PlanLimits } from "@/domain/models";
import { ValidationError } from "@/shared/errors";
import { normalizePayeeKey } from "@/shared/payee-normalization";

export class CategorizationServiceImpl implements CategorizationService {
  constructor(
    private readonly credentialsService: CredentialsService,
    private readonly usageService: UsageService,
    private readonly anthropicClient: AnthropicClient,
    private readonly payeeRulesRepository: PayeeRulesRepository
  ) {}

  async suggestCategorization(params: {
    tenantId: string;
    accounts: CategorizationAccount[];
    transactions: CategorizationTransaction[];
    limits?: PlanLimits;
  }) {
    const { tenantId, accounts, transactions, limits } = params;
    const accountById = new Map(accounts.map((account) => [account.id, account]));

    const normalizedKeys = transactions.map((t) => normalizePayeeKey(t.payee));
    const rules = await this.payeeRulesRepository.findByNormalizedKeys(tenantId, [...new Set(normalizedKeys)]);

    const results: CategorizationSuggestion[] = new Array(transactions.length);
    const unresolvedIndices: number[] = [];

    transactions.forEach((t, index) => {
      const rule = rules.get(normalizedKeys[index]!);
      // Only trust a learned rule if its account still exists in the
      // tenant's current chart of accounts -- an account can be renamed or
      // archived after the rule was learned, and a stale reference is worse
      // than falling through to the AI cascade.
      if (rule?.accountId && accountById.has(rule.accountId)) {
        results[index] = {
          payee: t.payee,
          memo: t.memo ?? null,
          amount: t.amount,
          accountId: rule.accountId,
          confidence: 1,
          resolvedBy: "rule"
        };
      } else {
        unresolvedIndices.push(index);
      }
    });

    let usage = { actions: 0, inputTokens: 0, outputTokens: 0 };
    let keySource: KeySource | null = null;

    if (unresolvedIndices.length > 0) {
      const resolved = await this.credentialsService.resolveKey(tenantId);
      keySource = resolved.source;

      if (resolved.enforceQuota) {
        if (!limits) {
          throw new ValidationError(
            "Plan limits are required to check quota for a platform-key tenant (missing monthlyAiActions/monthlyTokenCap)"
          );
        }
        // Throws AiQuotaExceededError (-> 402) if over. Never enforced for BYOK.
        await this.usageService.assertWithinQuota(tenantId, limits);
      }

      // Compressed catalog per Part 7: index + name + category only, no id
      // -- the model can only ever point at a position, never fabricate an
      // account. The real id is resolved back out of `accounts` below.
      const compressedAccounts = accounts.map((account, index) => ({ index, name: account.name, category: account.category }));
      const clientTransactions = unresolvedIndices.map((originalIndex, batchIndex) => {
        const t = transactions[originalIndex]!;
        return { index: batchIndex, payee: t.payee, memo: t.memo, amount: t.amount };
      });

      const clientResult = await this.anthropicClient.categorizeTransactions({
        apiKey: resolved.apiKey,
        model: resolved.model,
        accounts: compressedAccounts,
        transactions: clientTransactions
      });

      const byBatchIndex = new Map(clientResult.results.map((r) => [r.index, r]));
      unresolvedIndices.forEach((originalIndex, batchIndex) => {
        const t = transactions[originalIndex]!;
        const raw = byBatchIndex.get(batchIndex);

        // Never trust the model's output directly (AI_INTEGRATION_PLAN.md
        // Part 7): the index must be an in-range integer or it's discarded.
        const accountIndex = raw?.accountIndex;
        const validAccountIndex =
          typeof accountIndex === "number" && Number.isInteger(accountIndex) && accountIndex >= 0 && accountIndex < accounts.length
            ? accountIndex
            : null;
        const confidence = typeof raw?.confidence === "number" && raw.confidence >= 0 && raw.confidence <= 1 ? raw.confidence : null;

        results[originalIndex] = {
          payee: t.payee,
          memo: t.memo ?? null,
          amount: t.amount,
          accountId: validAccountIndex !== null ? accounts[validAccountIndex]!.id : null,
          confidence: validAccountIndex !== null ? confidence : null,
          resolvedBy: "ai"
        };
      });

      // Part 5: unlike column-mapping/payee-normalization (1 action per
      // batch), one categorized ROW = 1 action here -- count only rows
      // actually sent to the model, regardless of how confident the result.
      await this.usageService.recordUsage({
        tenantId,
        feature: "categorization",
        model: resolved.model,
        keySource: resolved.source,
        actions: unresolvedIndices.length,
        inputTokens: clientResult.usage.inputTokens,
        outputTokens: clientResult.usage.outputTokens,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0
      });
      usage = {
        actions: unresolvedIndices.length,
        inputTokens: clientResult.usage.inputTokens,
        outputTokens: clientResult.usage.outputTokens
      };
    }

    return { results, usage, keySource };
  }
}
