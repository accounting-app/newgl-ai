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

// Phase 5 (AI_INTEGRATION_PLAN.md Part 7, #2): payee normalization + learned
// rules. `payee_rules` rows are keyed by a deterministic normalized string
// (src/shared/payee-normalization.ts) so the cascade's exact-match step
// never needs Anthropic once a payee has been seen once.
export const PAYEE_RULE_SOURCES = ["ai", "user"] as const;
export type PayeeRuleSource = (typeof PAYEE_RULE_SOURCES)[number];

export type PayeeRuleRow = {
  normalizedPayee: string;
  canonicalPayee: string;
  accountId: string | null;
  source: PayeeRuleSource;
  confirmedCount: number;
};

export type NormalizedPayeeResult = {
  payee: string; // the original, un-normalized string as given by the caller
  normalizedKey: string;
  canonicalPayee: string;
  accountId: string | null;
  resolvedBy: "rule" | "ai";
};

export type PayeeNormalizationUsage = { inputTokens: number; outputTokens: number };

// Raw, unvalidated shape as returned by the AnthropicClient port -- index-
// aligned with the payees sent in the request. The service layer treats a
// missing/malformed entry as "keep the raw payee", never a hard failure --
// see AI_INTEGRATION_PLAN.md Part 7 on never trusting model output blindly.
export type PayeeNormalizationClientResult = {
  results: Array<{ payee: string; canonicalPayee: string }>;
  usage: PayeeNormalizationUsage;
};

export const normalizePayeesInputSchema = z.object({
  tenantId: z.string().uuid(),
  payees: z.array(z.string().min(1)).min(1).max(200),
  monthlyAiActions: z.number().int().positive().optional(),
  monthlyTokenCap: z.number().int().positive().optional()
});

export const learnPayeeRulesInputSchema = z.object({
  tenantId: z.string().uuid(),
  // Confirmed (payee -> accountId) pairs -- Part 1b: "feeds the cascade".
  // Only ever learned from what a user actually confirmed and imported,
  // never from an unreviewed suggestion (Part 7).
  rules: z
    .array(
      z.object({
        payee: z.string().min(1),
        accountId: z.string().min(1),
        canonicalPayee: z.string().min(1).optional()
      })
    )
    .min(1)
    .max(500)
});

// Phase 6 (AI_INTEGRATION_PLAN.md Part 7, #3): categorization -- suggests
// the counterparty ("target") account for a transaction. The chart of
// accounts is a finite label set, so this is classification into ~50-300
// known labels, not open-ended generation -- the model returns an index
// into the account array it was given, never a name (Part 7's prompt-
// injection mitigation: an out-of-range index fails validation structurally,
// a wrong free-text account name would not).
export type CategorizationAccount = { id: string; name: string; category: string };
export type CategorizationTransaction = { payee: string; memo?: string; amount: number };

export type CategorizationSuggestion = {
  payee: string;
  memo: string | null;
  amount: number;
  accountId: string | null;
  confidence: number | null;
  resolvedBy: "rule" | "ai";
};

export type CategorizationUsage = { inputTokens: number; outputTokens: number };

// Raw, unvalidated shape as returned by the AnthropicClient port. `index`
// aligns to the position of the *unresolved* transaction within the batch
// sent to Anthropic (not the caller's original transaction list -- the
// service re-maps this). `accountIndex` is a position in the compressed
// account catalog sent alongside it.
export type CategorizationClientResult = {
  results: Array<{ index: number; accountIndex: number | null; confidence: number | null }>;
  usage: CategorizationUsage;
};

export const categorizeInputSchema = z.object({
  tenantId: z.string().uuid(),
  // Capped generously above typical chart-of-accounts sizes (Part 7: "~50-300
  // known labels") -- newgl-api sends the tenant's whole chart, this is a
  // sanity ceiling, not a design target.
  accounts: z
    .array(z.object({ id: z.string().min(1), name: z.string().min(1), category: z.string().min(1) }))
    .min(1)
    .max(1000),
  // One Anthropic request per call handles one batch, not one row -- capped
  // so a single request can't blow past the token cap (Part 8: "pre-flight
  // large batches").
  transactions: z
    .array(
      z.object({
        payee: z.string().min(1),
        memo: z.string().optional(),
        amount: z.number()
      })
    )
    .min(1)
    .max(200),
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
