import type {
  AnthropicClient,
  ColumnMappingService,
  CredentialsService,
  UsageService
} from "@/application/contracts";
import type { ColumnMapping, PlanLimits } from "@/domain/models";
import { ValidationError } from "@/shared/errors";

export class ColumnMappingServiceImpl implements ColumnMappingService {
  constructor(
    private readonly credentialsService: CredentialsService,
    private readonly usageService: UsageService,
    private readonly anthropicClient: AnthropicClient,
    private readonly targetFields: readonly string[]
  ) {}

  async suggestMapping(params: { tenantId: string; csvHeader: string[]; sampleRows: string[][]; limits?: PlanLimits }) {
    const resolved = await this.credentialsService.resolveKey(params.tenantId);

    if (resolved.enforceQuota) {
      if (!params.limits) {
        throw new ValidationError(
          "Plan limits are required to check quota for a platform-key tenant (missing monthlyAiActions/monthlyTokenCap)"
        );
      }
      // Throws AiQuotaExceededError (-> 402) if over. Never enforced for BYOK.
      await this.usageService.assertWithinQuota(params.tenantId, params.limits);
    }

    // Cap defensively even though the route already validates this --
    // "3 sample rows" is a contract, not a client-supplied option.
    const sampleRows = params.sampleRows.slice(0, 3);

    const result = await this.anthropicClient.suggestColumnMapping({
      apiKey: resolved.apiKey,
      model: resolved.model,
      targetFields: this.targetFields,
      csvHeader: params.csvHeader,
      sampleRows
    });

    // Never trust the model's output directly (AI_INTEGRATION_PLAN.md Part
    // 7): every index must be an in-range integer or it's discarded to null.
    const mapping: ColumnMapping = {};
    for (const field of this.targetFields) {
      const index = result.mapping[field];
      mapping[field as keyof ColumnMapping] =
        typeof index === "number" && Number.isInteger(index) && index >= 0 && index < params.csvHeader.length
          ? index
          : null;
    }

    await this.usageService.recordUsage({
      tenantId: params.tenantId,
      feature: "column-mapping",
      model: resolved.model,
      keySource: resolved.source,
      actions: 1,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0
    });

    return {
      mapping,
      usage: { actions: 1, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
      keySource: resolved.source
    };
  }
}
