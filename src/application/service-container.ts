import type { ColumnMappingService, CredentialsService, UsageService } from "@/application/contracts";

export type ServiceContainer = {
  credentialsService: CredentialsService;
  usageService: UsageService;
  columnMappingService: ColumnMappingService;
};
