import type { AnthropicKeyValidator, CredentialsRepository, UsageRepository } from "@/application/contracts";
import type { ServiceContainer } from "@/application/service-container";
import { CredentialsServiceImpl } from "@/application/services/credentials-service";
import { UsageServiceImpl } from "@/application/services/usage-service";

export function createServiceContainer(deps: {
  credentialsRepository: CredentialsRepository;
  usageRepository: UsageRepository;
  keyValidator: AnthropicKeyValidator;
  encryptionKey: string;
  platformApiKey: string | undefined;
  platformModel: string;
}): ServiceContainer {
  return {
    credentialsService: new CredentialsServiceImpl(
      deps.credentialsRepository,
      deps.keyValidator,
      deps.encryptionKey,
      deps.platformApiKey,
      deps.platformModel
    ),
    usageService: new UsageServiceImpl(deps.usageRepository)
  };
}
