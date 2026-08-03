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

// Mirrors newgl-api's importTransactionRowInputSchema minus clientRowId
// (generated client-side) and categoryAccountId (that's categorization,
// Phase 6 -- a CSV header never maps to it). See AI_INTEGRATION_PLAN.md
// Part 7, feature #1.
export const COLUMN_MAPPING_TARGET_FIELDS = ["transactionDate", "payee", "memo", "amount", "referenceNumber"] as const;
export type ColumnMappingTargetField = (typeof COLUMN_MAPPING_TARGET_FIELDS)[number];

// null means "no confident match" -- never guess a wrong column, per Part 7
// ("the AI suggests; a human confirms").
export type ColumnMapping = Partial<Record<ColumnMappingTargetField, number | null>>;

export type ColumnMappingUsage = { inputTokens: number; outputTokens: number };

// Raw, unvalidated shape as returned by the AnthropicClient port -- may
// contain any string keys or out-of-range indices. The service layer
// validates this down to a ColumnMapping before it's trusted anywhere else.
export type ColumnMappingResult = {
  mapping: Record<string, number | null>;
  usage: ColumnMappingUsage;
};

export const columnMappingInputSchema = z.object({
  tenantId: z.string().uuid(),
  csvHeader: z.array(z.string()).min(1).max(100),
  // Capped at 3 -- "header + 3 sample rows" per Part 1b's endpoint contract.
  sampleRows: z.array(z.array(z.string())).min(1).max(3),
  monthlyAiActions: z.number().int().positive().optional(),
  monthlyTokenCap: z.number().int().positive().optional()
});

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
