import type { AnthropicKeyValidator, CredentialsRepository, CredentialsService } from "@/application/contracts";
import type { AiStatus, MaskedCredential, ResolvedAiKey } from "@/domain/models";
import { decryptSecret, encryptSecret, lastFour, maskApiKey } from "@/shared/crypto";
import { ValidationError } from "@/shared/errors";

export class CredentialsServiceImpl implements CredentialsService {
  constructor(
    private readonly repository: CredentialsRepository,
    private readonly validator: AnthropicKeyValidator,
    private readonly encryptionKey: string,
    private readonly platformApiKey: string | undefined,
    private readonly platformModel: string
  ) {}

  async setCredential(tenantId: string, apiKey: string, modelOverride?: string): Promise<MaskedCredential> {
    const result = await this.validator.validate(apiKey);
    if (!result.valid) {
      throw new ValidationError(`Anthropic API key failed validation: ${result.reason}`);
    }

    const encrypted = encryptSecret(apiKey, this.encryptionKey);
    const validatedAt = new Date().toISOString();
    await this.repository.upsert(tenantId, {
      ...encrypted,
      lastFour: lastFour(apiKey),
      modelOverride: modelOverride ?? null,
      validatedAt
    });

    return {
      maskedKey: maskApiKey(apiKey),
      model: modelOverride ?? result.model,
      validatedAt
    };
  }

  async removeCredential(tenantId: string): Promise<void> {
    await this.repository.remove(tenantId);
  }

  async getStatus(tenantId: string): Promise<AiStatus> {
    const row = await this.repository.find(tenantId);
    if (!row) {
      return { keySource: "platform", maskedKey: null, model: this.platformModel, validatedAt: null };
    }
    return {
      keySource: "byok",
      maskedKey: `sk-ant-...${row.lastFour}`,
      model: row.modelOverride ?? this.platformModel,
      validatedAt: row.validatedAt
    };
  }

  async resolveKey(tenantId: string): Promise<ResolvedAiKey> {
    const row = await this.repository.find(tenantId);
    if (row) {
      return {
        apiKey: decryptSecret(row, this.encryptionKey),
        source: "byok",
        model: row.modelOverride ?? this.platformModel,
        enforceQuota: false
      };
    }

    if (!this.platformApiKey) {
      throw new ValidationError(
        "No BYOK key configured for this tenant and no platform Anthropic key is configured on this server."
      );
    }
    return {
      apiKey: this.platformApiKey,
      source: "platform",
      model: this.platformModel,
      enforceQuota: true
    };
  }
}
