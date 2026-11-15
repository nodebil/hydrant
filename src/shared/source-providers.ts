import type { SourcePreferences } from "@types";

export const DEFAULT_SOURCE_PREFERENCES: SourcePreferences = {
  providerPriority: [],
  hosterPriority: [],
  autoPick: false,
};

export const SOURCE_PROVIDER_SEARCH_CHANNEL = "searchSourceProviders";
export const SOURCE_PROVIDER_CANCEL_CHANNEL = "cancelSourceProviderSearch";
export const SOURCE_PROVIDER_STATUS_CHANNEL = "on-source-provider-status";
export const SOURCE_PROVIDER_AVAILABILITY_CHANNEL =
  "getSourceProviderAvailability";
