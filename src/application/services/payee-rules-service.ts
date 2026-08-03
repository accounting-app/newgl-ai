import type {
  AnthropicClient,
  CredentialsService,
  PayeeRulesRepository,
  PayeeRulesService,
  UsageService
} from "@/application/contracts";
import type { KeySource, NormalizedPayeeResult, PlanLimits } from "@/domain/models";
import { normalizePayeeKey } from "@/shared/payee-normalization";
import { ValidationError } from "@/shared/errors";

export class PayeeRulesServiceImpl implements PayeeRulesService {
  constructor(
    private readonly credentialsService: CredentialsService,
    private readonly usageService: UsageService,
    private readonly anthropicClient: AnthropicClient,
    private readonly repository: PayeeRulesRepository
  ) {}

  async suggestNormalization(params: { tenantId: string; payees: string[]; limits?: PlanLimits }) {
    const { tenantId, payees, limits } = params;

    const withKeys = payees.map((payee) => ({ payee, key: normalizePayeeKey(payee) }));
    const uniqueKeys = [...new Set(withKeys.map(({ key }) => key))];

    // Cascade step 1 (AI_INTEGRATION_PLAN.md Part 7): exact match against
    // what's already been learned -- zero API calls for anything found here.
    const existingRules = await this.repository.findByNormalizedKeys(tenantId, uniqueKeys);
    const unresolvedKeys = uniqueKeys.filter((key) => !existingRules.has(key));

    let keySource: KeySource | null = null;
    let usage = { actions: 0, inputTokens: 0, outputTokens: 0 };
    const aiCanonicalByKey = new Map<string, string>();

    if (unresolvedKeys.length > 0) {
      // Batch everything unresolved into exactly one call, regardless of how
      // many raw payees shared a key -- this is the "one batch of payees
      // normalized = 1 action" unit from Part 5.
      const representativeByKey = new Map<string, string>();
      for (const { payee, key } of withKeys) {
        if (!representativeByKey.has(key) && unresolvedKeys.includes(key)) {
          representativeByKey.set(key, payee);
        }
      }
      const representatives = unresolvedKeys.map((key) => representativeByKey.get(key) ?? key);

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

      const clientResult = await this.anthropicClient.normalizePayees({
        apiKey: resolved.apiKey,
        model: resolved.model,
        payees: representatives
      });

      // Index-aligned with `representatives`/`unresolvedKeys` -- never trust
      // a missing or malformed entry, just fall back to the raw payee
      // (AI_INTEGRATION_PLAN.md Part 7: the model only ever pre-fills a
      // field a human can still see and correct).
      unresolvedKeys.forEach((key, index) => {
        const raw = representatives[index]!;
        const canonical = clientResult.results[index]?.canonicalPayee;
        aiCanonicalByKey.set(key, typeof canonical === "string" && canonical.trim().length > 0 ? canonical.trim() : raw);
      });

      await this.repository.upsertMany(
        tenantId,
        unresolvedKeys.map((key) => ({
          normalizedPayee: key,
          canonicalPayee: aiCanonicalByKey.get(key)!,
          overwriteCanonicalPayee: true,
          accountId: null,
          source: "ai" as const
        }))
      );

      await this.usageService.recordUsage({
        tenantId,
        feature: "payee-normalization",
        model: resolved.model,
        keySource: resolved.source,
        actions: 1,
        inputTokens: clientResult.usage.inputTokens,
        outputTokens: clientResult.usage.outputTokens,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0
      });
      usage = { actions: 1, inputTokens: clientResult.usage.inputTokens, outputTokens: clientResult.usage.outputTokens };
    }

    const results: NormalizedPayeeResult[] = withKeys.map(({ payee, key }) => {
      const rule = existingRules.get(key);
      if (rule) {
        return {
          payee,
          normalizedKey: key,
          canonicalPayee: rule.canonicalPayee,
          accountId: rule.accountId,
          resolvedBy: "rule"
        };
      }
      return {
        payee,
        normalizedKey: key,
        canonicalPayee: aiCanonicalByKey.get(key) ?? payee,
        accountId: null,
        resolvedBy: "ai"
      };
    });

    return { results, usage, keySource };
  }

  async learnRules(params: { tenantId: string; rules: Array<{ payee: string; accountId: string; canonicalPayee?: string }> }) {
    const rows = params.rules.map((rule) => {
      const explicitCanonical = rule.canonicalPayee?.trim();
      return {
        normalizedPayee: normalizePayeeKey(rule.payee),
        canonicalPayee: explicitCanonical || rule.payee.trim(),
        // Only replace an already-learned canonical name (e.g. one Phase 5
        // itself produced) when the caller explicitly supplied one -- a bare
        // accountId confirmation shouldn't regress a good display name back
        // to the raw processor string.
        overwriteCanonicalPayee: Boolean(explicitCanonical),
        accountId: rule.accountId,
        source: "user" as const
      };
    });

    await this.repository.upsertMany(params.tenantId, rows);
    return { learned: rows.length };
  }
}
