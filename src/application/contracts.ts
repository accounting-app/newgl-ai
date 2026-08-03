import type { EncryptedPayload } from "@/shared/crypto";
import type {
  AiStatus,
  ColumnMappingResult,
  KeySource,
  MaskedCredential,
  NormalizedPayeeResult,
  PayeeNormalizationClientResult,
  PayeeRuleRow,
  PayeeRuleSource,
  PlanLimits,
  ResolvedAiKey,
  UsageEntry,
  UsagePeriodSummary
} from "@/domain/models";

export type CredentialRow = EncryptedPayload & {
  lastFour: string;
  modelOverride: string | null;
  validatedAt: string;
};

/** Only newgl-ai ever reads/writes this table -- see AI_INTEGRATION_PLAN.md Part 1. */
export interface CredentialsRepository {
  upsert(tenantId: string, row: CredentialRow): Promise<void>;
  find(tenantId: string): Promise<CredentialRow | null>;
  remove(tenantId: string): Promise<void>;
}

export interface UsageRepository {
  record(entry: UsageEntry): Promise<void>;
  summarizeCurrentPeriod(tenantId: string): Promise<UsagePeriodSummary>;
}

export type KeyValidationResult = { valid: true; model: string } | { valid: false; reason: string };

/**
 * "Validate on save" (AI_INTEGRATION_PLAN.md Part 4): one cheap call before
 * persisting a BYOK key, so a broken key is rejected at settings-save time
 * instead of failing silently at import time. Real implementation calls
 * Anthropic's count_tokens endpoint; tests use a fake so no test ever makes
 * a real network call or needs a real Anthropic account.
 */
export interface AnthropicKeyValidator {
  validate(apiKey: string): Promise<KeyValidationResult>;
}

export interface CredentialsService {
  setCredential(tenantId: string, apiKey: string, modelOverride?: string): Promise<MaskedCredential>;
  removeCredential(tenantId: string): Promise<void>;
  getStatus(tenantId: string): Promise<AiStatus>;
  resolveKey(tenantId: string): Promise<ResolvedAiKey>;
}

export interface UsageService {
  recordUsage(entry: UsageEntry): Promise<void>;
  getUsageSummary(tenantId: string, limits?: PlanLimits): Promise<{ summary: UsagePeriodSummary; limits: PlanLimits | null }>;
  assertWithinQuota(tenantId: string, limits: PlanLimits): Promise<void>;
}

/**
 * Talks to Anthropic for the one feature that exists so far (Part 7, #1:
 * CSV column auto-mapping). Real implementation calls the Messages API;
 * tests use a deterministic fake so no test needs a real Anthropic account.
 */
export interface AnthropicClient {
  suggestColumnMapping(input: {
    apiKey: string;
    model: string;
    targetFields: readonly string[];
    csvHeader: string[];
    sampleRows: string[][];
  }): Promise<ColumnMappingResult>;

  /** Part 7, #2: turn raw processor strings into clean display names, e.g.
   * "SQ *COFFEE #4432" -> "Coffee Shop". Only ever called with payees the
   * `payee_rules` cascade couldn't already resolve. */
  normalizePayees(input: { apiKey: string; model: string; payees: string[] }): Promise<PayeeNormalizationClientResult>;
}

export interface ColumnMappingService {
  suggestMapping(params: {
    tenantId: string;
    csvHeader: string[];
    sampleRows: string[][];
    limits?: PlanLimits;
  }): Promise<{
    mapping: import("@/domain/models").ColumnMapping;
    usage: { actions: number; inputTokens: number; outputTokens: number };
    keySource: KeySource;
  }>;
}

/** Only newgl-ai ever reads/writes this table -- see AI_INTEGRATION_PLAN.md Part 1. */
export interface PayeeRulesRepository {
  findByNormalizedKeys(tenantId: string, normalizedKeys: string[]): Promise<Map<string, PayeeRuleRow>>;
  upsertMany(
    tenantId: string,
    rules: Array<{
      normalizedPayee: string;
      canonicalPayee: string;
      // false for a plain accountId confirmation with no explicit canonical
      // name (e.g. learnRules called with just `payee` + `accountId`) --
      // an existing AI-learned canonical name is worth more than the raw
      // payee string, so it's kept rather than clobbered.
      overwriteCanonicalPayee: boolean;
      accountId: string | null;
      source: PayeeRuleSource;
    }>
  ): Promise<void>;
}

export interface PayeeRulesService {
  /** The Phase 5 cascade (AI_INTEGRATION_PLAN.md Part 7): exact-match
   * against learned rules first, batch whatever's left into one Anthropic
   * call, learn the result for next time. `keySource` is null when every
   * payee was rule-resolved -- no key was ever touched, no quota check ran. */
  suggestNormalization(params: {
    tenantId: string;
    payees: string[];
    limits?: PlanLimits;
  }): Promise<{
    results: NormalizedPayeeResult[];
    usage: { actions: number; inputTokens: number; outputTokens: number };
    keySource: KeySource | null;
  }>;

  /** Confirmed (payee -> accountId) pairs from a completed import -- Part
   * 1b's `POST /internal/ai/rules/learn`. No Anthropic call, no usage/quota
   * involvement; this only ever writes to `payee_rules`. */
  learnRules(params: {
    tenantId: string;
    rules: Array<{ payee: string; accountId: string; canonicalPayee?: string }>;
  }): Promise<{ learned: number }>;
}
