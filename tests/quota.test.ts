import { describe, expect, test } from "bun:test";

import { AiQuotaExceededError, assertWithinQuota } from "../src/domain/quota";

const LIMITS = { monthlyAiActions: 200, monthlyTokenCap: 500_000 };

describe("assertWithinQuota", () => {
  test("does not throw when comfortably under both limits", () => {
    expect(() => assertWithinQuota({ actions: 10, tokens: 5_000 }, LIMITS)).not.toThrow();
  });

  test("does not throw exactly one unit under either limit", () => {
    expect(() => assertWithinQuota({ actions: 199, tokens: 499_999 }, LIMITS)).not.toThrow();
  });

  test("throws AiQuotaExceededError('actions') once actions reaches the limit", () => {
    expect(() => assertWithinQuota({ actions: 200, tokens: 0 }, LIMITS)).toThrow(AiQuotaExceededError);
    try {
      assertWithinQuota({ actions: 200, tokens: 0 }, LIMITS);
      throw new Error("expected assertWithinQuota to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AiQuotaExceededError);
      expect((error as AiQuotaExceededError).limitType).toBe("actions");
    }
  });

  test("throws AiQuotaExceededError('tokens') once tokens reaches the cap", () => {
    expect(() => assertWithinQuota({ actions: 0, tokens: 500_000 }, LIMITS)).toThrow(AiQuotaExceededError);
    try {
      assertWithinQuota({ actions: 0, tokens: 500_000 }, LIMITS);
      throw new Error("expected assertWithinQuota to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AiQuotaExceededError);
      expect((error as AiQuotaExceededError).limitType).toBe("tokens");
    }
  });

  test("checks actions before tokens when both are exceeded", () => {
    try {
      assertWithinQuota({ actions: 500, tokens: 999_999 }, LIMITS);
      throw new Error("expected assertWithinQuota to throw");
    } catch (error) {
      expect((error as AiQuotaExceededError).limitType).toBe("actions");
    }
  });
});
