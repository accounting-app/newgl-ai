import type { CredentialsService, UsageService } from "@/application/contracts";

export type ServiceContainer = {
  credentialsService: CredentialsService;
  usageService: UsageService;
};
