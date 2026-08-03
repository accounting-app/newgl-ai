import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;

export type EncryptedPayload = {
  ciphertext: string;
  iv: string;
  authTag: string;
};

function loadMasterKey(masterKeyBase64: string): Buffer {
  const key = Buffer.from(masterKeyBase64, "base64");
  if (key.length !== 32) {
    throw new Error(
      `AI_KEY_ENCRYPTION_KEY must decode to exactly 32 bytes for AES-256-GCM, got ${key.length}`
    );
  }
  return key;
}

/** Encrypts a secret (e.g. a customer's Anthropic API key) for storage. */
export function encryptSecret(plaintext: string, masterKeyBase64: string): EncryptedPayload {
  const key = loadMasterKey(masterKeyBase64);
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64")
  };
}

/** Reverses encryptSecret. Throws if the ciphertext, IV, tag, or key don't match. */
export function decryptSecret(payload: EncryptedPayload, masterKeyBase64: string): string {
  const key = loadMasterKey(masterKeyBase64);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final()
  ]);
  return plaintext.toString("utf8");
}

/**
 * Masks an Anthropic API key for display -- e.g. "sk-ant-...4f2a". Never
 * return the plaintext key from any endpoint; this is the only form that
 * should ever leave the process (AI_INTEGRATION_PLAN.md Part 4).
 */
export function maskApiKey(apiKey: string): string {
  return `sk-ant-...${lastFour(apiKey)}`;
}

export function lastFour(apiKey: string): string {
  return apiKey.slice(-4);
}
