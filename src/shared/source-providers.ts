/**
 * Master gate for external source-provider search. Free; no subscription.
 * The main process checks it fail-closed before any provider request.
 */
export const SOURCE_PROVIDER_SEARCH_FEATURE = "PROVIDER_SEARCH";

/** IPC channels shared by the main handlers and the preload bridge. */
export const SOURCE_PROVIDER_SEARCH_CHANNEL = "searchSourceProviders";
export const SOURCE_PROVIDER_CANCEL_CHANNEL = "cancelSourceProviderSearch";
export const SOURCE_PROVIDER_STATUS_CHANNEL = "on-source-provider-status";

/**
 * Future per-provider gate, for example `PROVIDER_SEARCH_STEAMRIP`. v1 checks
 * only the master flag; providers use this name when per-provider flags ship.
 */
export const getSourceProviderFeatureFlag = (providerId: string) =>
  `${SOURCE_PROVIDER_SEARCH_FEATURE}_${providerId
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")}`;
