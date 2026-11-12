import type { SourcePreferences } from "@types";

export const SOURCE_PROVIDER_SEARCH_FEATURE = "PROVIDER_SEARCH";

export const DEFAULT_SOURCE_PREFERENCES: SourcePreferences = {
  providerPriority: [],
  hosterPriority: [],
  autoPick: false,
};

export const SOURCE_PROVIDER_SEARCH_CHANNEL = "searchSourceProviders";
export const SOURCE_PROVIDER_CANCEL_CHANNEL = "cancelSourceProviderSearch";
export const SOURCE_PROVIDER_STATUS_CHANNEL = "on-source-provider-status";

export const getSourceProviderFeatureFlag = (providerId: string) =>
  `${SOURCE_PROVIDER_SEARCH_FEATURE}_${providerId
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")}`;
