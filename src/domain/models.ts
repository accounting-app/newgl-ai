import { z } from "zod";

export type KeySource = "byok" | "platform";

/** What key-resolution hands to a (future) AI feature -- nothing downstream
 * needs to know whether it came from a tenant's own account or the platform's. */
export type ResolvedAiKey = {
  apiKey: string;
  source: KeySource;
  model: string;
  enforceQuota: boolean; // false for byok -- see AI_INTEGRATION_PLAN.md Part 4
};

export type PlanLimits = {
  monthlyAiActions: number;
  monthlyTokenCap: number;
};

export type MaskedCredential = {
  maskedKey: string;
  model: string;
  validatedAt: string;
};

export type AiStatus = {
  keySource: KeySource;
  maskedKey: string | null;
  model: string;
  validatedAt: string | null;
};

export type UsageEntry = {
  tenantId: string;
  feature: string;
  model: string;
  keySource: KeySource;
  actions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
};

export type UsagePeriodSummary = {
  periodStart: string; // ISO timestamp, start of the current UTC calendar month
  totalActions: number;
  totalTokens: number; // input + output + cache read + cache creation
  byKeySource: Record<KeySource, { actions: number; tokens: number }>;
};

export const setCredentialInputSchema = z.object({
  tenantId: z.string().uuid(),
  apiKey: z.string().min(20, "apiKey looks too short to be a real Anthropic key"),
  modelOverride: z.string().min(1).optional()
});

export const tenantIdInputSchema = z.object({
  tenantId: z.string().uuid()
});

export const usageQuerySchema = z.object({
  tenantId: z.string().uuid(),
  monthlyAiActions: z.coerce.number().int().positive().optional(),
  monthlyTokenCap: z.coerce.number().int().positive().optional()
});

export const errorResponseSchema = z.object({
  error: z.object({ message: z.string() })
});
