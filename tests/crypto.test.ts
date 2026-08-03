import { describe, expect, test } from "bun:test";

import { decryptSecret, encryptSecret, lastFour, maskApiKey } from "../src/shared/crypto";

const MASTER_KEY = "Eo0pUoxiqHb5h1QlSUcD07lVfiqi3kOcovq2CaSmLew="; // 32 bytes, base64 -- test-only
const OTHER_MASTER_KEY = "Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4"; // different 32-byte key

describe("crypto: encryptSecret / decryptSecret", () => {
  test("round-trips a plaintext secret", () => {
    const plaintext = "sk-ant-test-1234567890abcdef";
    const encrypted = encryptSecret(plaintext, MASTER_KEY);
    expect(decryptSecret(encrypted, MASTER_KEY)).toBe(plaintext);
  });

  test("produces a different IV (and ciphertext) on every call", () => {
    const plaintext = "sk-ant-test-1234567890abcdef";
    const first = encryptSecret(plaintext, MASTER_KEY);
    const second = encryptSecret(plaintext, MASTER_KEY);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  test("never stores the plaintext anywhere in the payload", () => {
    const plaintext = "sk-ant-test-super-secret-value";
    const encrypted = encryptSecret(plaintext, MASTER_KEY);
    expect(encrypted.ciphertext).not.toContain(plaintext);
    expect(JSON.stringify(encrypted)).not.toContain(plaintext);
  });

  test("rejects a master key that isn't exactly 32 bytes", () => {
    expect(() => encryptSecret("secret", "dG9vLXNob3J0")).toThrow(/32 bytes/);
  });

  test("decrypting with the wrong master key throws (auth tag mismatch)", () => {
    const encrypted = encryptSecret("sk-ant-test-value", MASTER_KEY);
    expect(() => decryptSecret(encrypted, OTHER_MASTER_KEY)).toThrow();
  });

  test("decrypting tampered ciphertext throws instead of returning garbage", () => {
    const encrypted = encryptSecret("sk-ant-test-value", MASTER_KEY);
    const tampered = { ...encrypted, ciphertext: Buffer.from("tampered-bytes").toString("base64") };
    expect(() => decryptSecret(tampered, MASTER_KEY)).toThrow();
  });
});

describe("crypto: maskApiKey / lastFour", () => {
  test("masks everything except the last 4 characters", () => {
    expect(maskApiKey("sk-ant-api03-abcdefgh1234")).toBe("sk-ant-...1234");
  });

  test("never includes the full key in the masked output", () => {
    const apiKey = "sk-ant-api03-verysecretvalue9999";
    expect(maskApiKey(apiKey)).not.toContain(apiKey);
  });

  test("lastFour returns exactly the last 4 characters", () => {
    expect(lastFour("sk-ant-api03-abcd1234wxyz")).toBe("wxyz");
  });
});
