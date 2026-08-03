import type { AnthropicClient, AnthropicKeyValidator, CredentialsRepository, UsageRepository } from "@/application/contracts";
import type { ServiceContainer } from "@/application/service-container";
import { ColumnMappingServiceImpl } from "@/application/services/column-mapping-service";
import { CredentialsServiceImpl } from "@/application/services/credentials-service";
import { UsageServiceImpl } from "@/application/services/usage-service";
import { COLUMN_MAPPING_TARGET_FIELDS } from "@/domain/models";

export function createServiceContainer(deps: {
  credentialsRepository: CredentialsRepository;
  usageRepository: UsageRepository;
  keyValidator: AnthropicKeyValidator;
  anthropicClient: AnthropicClient;
  encryptionKey: string;
  platformApiKey: string | undefined;
  platformModel: string;
}): ServiceContainer {
  const credentialsService = new CredentialsServiceImpl(
    deps.credentialsRepository,
    deps.keyValidator,
    deps.encryptionKey,
    deps.platformApiKey,
    deps.platformModel
  );
  const usageService = new UsageServiceImpl(deps.usageRepository);

  return {
    credentialsService,
    usageService,
    columnMappingService: new ColumnMappingServiceImpl(
      credentialsService,
      usageService,
      deps.anthropicClient,
      COLUMN_MAPPING_TARGET_FIELDS
    )
  };
}
