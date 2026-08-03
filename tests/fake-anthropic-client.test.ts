import { describe, expect, test } from "bun:test";

import { createFakeAnthropicClient } from "../src/testing/fake-anthropic-client";

describe("createFakeAnthropicClient (heuristic mapping)", () => {
  test("matches columns to target fields by keyword, case-insensitively", async () => {
    const client = createFakeAnthropicClient();
    const result = await client.suggestColumnMapping({
      apiKey: "unused",
      model: "unused",
      targetFields: ["transactionDate", "payee", "memo", "amount", "referenceNumber"],
      csvHeader: ["Date", "Description", "Notes", "Amount", "Check #"],
      sampleRows: [["2024-01-01", "Coffee Shop", "morning coffee", "-4.50", "1001"]]
    });

    expect(result.mapping).toEqual({
      transactionDate: 0,
      payee: 1,
      memo: 2,
      amount: 3,
      referenceNumber: 4
    });
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });

  test("returns null for a target field with no matching column", async () => {
    const client = createFakeAnthropicClient();
    const result = await client.suggestColumnMapping({
      apiKey: "unused",
      model: "unused",
      targetFields: ["transactionDate", "payee", "referenceNumber"],
      csvHeader: ["Date", "Merchant"],
      sampleRows: [["2024-01-01", "Coffee Shop"]]
    });

    expect(result.mapping.transactionDate).toBe(0);
    expect(result.mapping.payee).toBe(1); // "Merchant" matches the payee keyword list
    expect(result.mapping.referenceNumber).toBeNull();
  });
});
