export const SOURCE_PROVIDER_SEARCH_FEATURE = "PROVIDER_SEARCH";

export const SOURCE_PROVIDER_SEARCH_CHANNEL = "searchSourceProviders";
export const SOURCE_PROVIDER_CANCEL_CHANNEL = "cancelSourceProviderSearch";
export const SOURCE_PROVIDER_STATUS_CHANNEL = "on-source-provider-status";

export const getSourceProviderFeatureFlag = (providerId: string) =>
  `${SOURCE_PROVIDER_SEARCH_FEATURE}_${providerId
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")}`;
