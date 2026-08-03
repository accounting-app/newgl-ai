import type { ColumnMappingService, CredentialsService, PayeeRulesService, UsageService } from "@/application/contracts";

export type ServiceContainer = {
  credentialsService: CredentialsService;
  usageService: UsageService;
  columnMappingService: ColumnMappingService;
  payeeRulesService: PayeeRulesService;
};
