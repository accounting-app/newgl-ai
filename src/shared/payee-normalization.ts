/**
 * Deterministic, non-AI normalization of a raw bank payee string down to a
 * matching key -- e.g. "SQ *COFFEE SHOP #4432" and "SQ *Coffee Shop #7781"
 * (a different store number, same merchant) both collapse to "coffee shop".
 *
 * This is the cascade's step 1 (AI_INTEGRATION_PLAN.md Part 7): a raw payee
 * that normalizes to a key already in `payee_rules` never reaches Anthropic
 * at all. It must be pure and stable -- the same input always produces the
 * same key, with no clock, randomness, or external state -- since the key is
 * both the cache lookup and the thing stored in the database.
 *
 * This intentionally does not attempt fuzzy/similarity matching (step 2 in
 * the plan's cascade) -- that's a real algorithmic addition, not a one-line
 * heuristic, and exact-key matching alone already resolves the common case
 * (the same merchant's processor string repeating across statements).
 */

// Common card-network / payment-processor prefixes that carry no merchant
// signal on their own.
const PREFIX_PATTERNS: RegExp[] = [
  /^(sq|sp|tst|pp|ck|ivy|paypal)\s*\*/i,
  // Longer, more specific phrases must come before their own prefixes in the
  // alternation -- JS regex alternation takes the first alternative that
  // matches at a position, not the longest, so "pos debit" would never be
  // reached if "pos" came first.
  /^(pos debit|pos purchase|debit card purchase|debit purchase|pos|ach|pmt|purchase|payment to|payment from|online payment|recurring payment|autopay|auto payment|bill payment)\b[\s:]*/i,
  /^(pending|hold)\b[\s:]*/i
];

// Trailing/embedded noise: dates, authorization boilerplate, and numeric IDs
// (store numbers, terminal IDs, check numbers) that vary per-transaction for
// the same merchant.
const NOISE_PATTERNS: RegExp[] = [
  /\bauthorized on\s+\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/gi,
  /\bon\s+\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/gi,
  /\bcard\s*#?\s*\d{4,}\b/gi,
  /#\s*\d+/g,
  /\b\d{4,}\b/g,
  /\b(inc|llc|corp|co|ltd)\.?\b/gi
];

export function normalizePayeeKey(rawPayee: string): string {
  let value = rawPayee.trim();

  for (const pattern of PREFIX_PATTERNS) {
    value = value.replace(pattern, " ");
  }
  for (const pattern of NOISE_PATTERNS) {
    value = value.replace(pattern, " ");
  }

  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
