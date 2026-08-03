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

describe("createFakeAnthropicClient (heuristic payee cleanup)", () => {
  test("strips processor noise and title-cases the result", async () => {
    const client = createFakeAnthropicClient();
    const result = await client.normalizePayees({
      apiKey: "unused",
      model: "unused",
      payees: ["SQ *COFFEE SHOP #4432", "UBER TRIP 8213409"]
    });

    expect(result.results).toEqual([
      { payee: "SQ *COFFEE SHOP #4432", canonicalPayee: "Coffee Shop" },
      { payee: "UBER TRIP 8213409", canonicalPayee: "Uber Trip" }
    ]);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });

  test("returns the original string unchanged when nothing is left to clean", async () => {
    const client = createFakeAnthropicClient();
    const result = await client.normalizePayees({
      apiKey: "unused",
      model: "unused",
      payees: ["12345678"]
    });

    expect(result.results).toEqual([{ payee: "12345678", canonicalPayee: "12345678" }]);
  });

  test("scales usage with the number of payees in the batch", async () => {
    const client = createFakeAnthropicClient();
    const one = await client.normalizePayees({ apiKey: "unused", model: "unused", payees: ["A"] });
    const three = await client.normalizePayees({ apiKey: "unused", model: "unused", payees: ["A", "B", "C"] });
    expect(three.usage.inputTokens).toBeGreaterThan(one.usage.inputTokens);
  });
});

describe("createFakeAnthropicClient (heuristic categorization)", () => {
  const accounts = [
    { index: 0, name: "Cash", category: "BANK" },
    { index: 1, name: "Coffee", category: "EXPENSE" },
    { index: 2, name: "Consulting Income", category: "INCOME" }
  ];

  test("matches a transaction to an account by payee keyword", async () => {
    const client = createFakeAnthropicClient();
    const result = await client.categorizeTransactions({
      apiKey: "unused",
      model: "unused",
      accounts,
      transactions: [{ index: 0, payee: "Coffee Shop", amount: -4.5 }]
    });

    expect(result.results).toEqual([{ index: 0, accountIndex: 1, confidence: 0.8 }]);
  });

  test("falls back to the amount-sign hint when no keyword matches", async () => {
    const client = createFakeAnthropicClient();
    const result = await client.categorizeTransactions({
      apiKey: "unused",
      model: "unused",
      accounts,
      transactions: [
        { index: 0, payee: "Totally Unknown Vendor", amount: -20 },
        { index: 1, payee: "Totally Unknown Client", amount: 500 }
      ]
    });

    expect(result.results[0]).toEqual({ index: 0, accountIndex: 1, confidence: 0.8 }); // expense fallback
    expect(result.results[1]).toEqual({ index: 1, accountIndex: 2, confidence: 0.8 }); // income fallback
  });

  test("returns null with no confidence when nothing matches at all", async () => {
    const client = createFakeAnthropicClient();
    const result = await client.categorizeTransactions({
      apiKey: "unused",
      model: "unused",
      accounts: [{ index: 0, name: "Cash", category: "BANK" }],
      transactions: [{ index: 0, payee: "Mystery Payee", amount: -5 }]
    });

    expect(result.results).toEqual([{ index: 0, accountIndex: null, confidence: null }]);
  });
});
