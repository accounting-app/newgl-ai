import type { PlanLimits } from "@/domain/models";

export class AiQuotaExceededError extends Error {
  constructor(
    readonly limitType: "actions" | "tokens",
    readonly limit: number
  ) {
    super(`AI ${limitType} quota exceeded (limit ${limit})`);
    this.name = "AiQuotaExceededError";
  }
}

/**
 * Pure quota check -- see AI_INTEGRATION_PLAN.md Part 8. Only ever called
 * when `enforceQuota` is true on the resolved key (i.e. never for BYOK).
 * newgl-ai enforces the quota but does not know what a "plan" is; the
 * caller (newgl-api) passes the limits for this tenant's plan explicitly.
 */
export function assertWithinQuota(usage: { actions: number; tokens: number }, limits: PlanLimits): void {
  if (usage.actions >= limits.monthlyAiActions) {
    throw new AiQuotaExceededError("actions", limits.monthlyAiActions);
  }
  if (usage.tokens >= limits.monthlyTokenCap) {
    throw new AiQuotaExceededError("tokens", limits.monthlyTokenCap);
  }
}
