import type {
  AnthropicClient,
  AnthropicKeyValidator,
  CredentialsRepository,
  PayeeRulesRepository,
  UsageRepository
} from "@/application/contracts";
import type { ServiceContainer } from "@/application/service-container";
import { CategorizationServiceImpl } from "@/application/services/categorization-service";
import { ColumnMappingServiceImpl } from "@/application/services/column-mapping-service";
import { CredentialsServiceImpl } from "@/application/services/credentials-service";
import { PayeeRulesServiceImpl } from "@/application/services/payee-rules-service";
import { UsageServiceImpl } from "@/application/services/usage-service";
import { COLUMN_MAPPING_TARGET_FIELDS } from "@/domain/models";

export function createServiceContainer(deps: {
  credentialsRepository: CredentialsRepository;
  usageRepository: UsageRepository;
  payeeRulesRepository: PayeeRulesRepository;
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
    ),
    payeeRulesService: new PayeeRulesServiceImpl(credentialsService, usageService, deps.anthropicClient, deps.payeeRulesRepository),
    categorizationService: new CategorizationServiceImpl(
      credentialsService,
      usageService,
      deps.anthropicClient,
      deps.payeeRulesRepository
    )
  };
}
