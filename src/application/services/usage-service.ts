import type { UsageRepository, UsageService } from "@/application/contracts";
import type { PlanLimits, UsageEntry, UsagePeriodSummary } from "@/domain/models";
import { assertWithinQuota } from "@/domain/quota";

export class UsageServiceImpl implements UsageService {
  constructor(private readonly repository: UsageRepository) {}

  async recordUsage(entry: UsageEntry): Promise<void> {
    await this.repository.record(entry);
  }

  async getUsageSummary(
    tenantId: string,
    limits?: PlanLimits
  ): Promise<{ summary: UsagePeriodSummary; limits: PlanLimits | null }> {
    const summary = await this.repository.summarizeCurrentPeriod(tenantId);
    return { summary, limits: limits ?? null };
  }

  // Only ever called for platform-key tenants (enforceQuota === true) --
  // BYOK tenants are metered for display but never blocked. See
  // AI_INTEGRATION_PLAN.md Part 4 / Part 8.
  async assertWithinQuota(tenantId: string, limits: PlanLimits): Promise<void> {
    const summary = await this.repository.summarizeCurrentPeriod(tenantId);
    assertWithinQuota({ actions: summary.totalActions, tokens: summary.totalTokens }, limits);
  }
}
