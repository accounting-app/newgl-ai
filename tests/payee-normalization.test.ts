import { describe, expect, test } from "bun:test";

import { normalizePayeeKey } from "../src/shared/payee-normalization";

describe("normalizePayeeKey", () => {
  test("collapses two statements from the same merchant with different store numbers to the same key", () => {
    const a = normalizePayeeKey("SQ *COFFEE SHOP #4432");
    const b = normalizePayeeKey("SQ *Coffee Shop #7781");
    expect(a).toBe(b);
    expect(a).toBe("coffee shop");
  });

  test("strips common processor prefixes", () => {
    expect(normalizePayeeKey("POS DEBIT ACME MARKET")).toBe("acme market");
    expect(normalizePayeeKey("PAYPAL *ACME LLC")).toBe("acme");
    expect(normalizePayeeKey("TST* Corner Diner")).toBe("corner diner");
  });

  test("strips authorization-date boilerplate", () => {
    expect(normalizePayeeKey("PURCHASE AUTHORIZED ON 04/02 UBER TRIP")).toBe("uber trip");
  });

  test("is case-insensitive and whitespace-insensitive", () => {
    expect(normalizePayeeKey("  Whole Foods   Market  ")).toBe(normalizePayeeKey("WHOLE FOODS MARKET"));
  });

  test("is stable -- calling it twice on its own output is a no-op", () => {
    const once = normalizePayeeKey("SQ *COFFEE SHOP #4432");
    const twice = normalizePayeeKey(once);
    expect(twice).toBe(once);
  });

  test("a purely numeric or symbolic payee normalizes to an empty key (nothing to match on)", () => {
    expect(normalizePayeeKey("1234567")).toBe("");
    expect(normalizePayeeKey("***")).toBe("");
  });
});
