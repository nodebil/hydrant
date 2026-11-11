import { SOURCE_PROVIDER_SEARCH_FEATURE } from "@shared";
import { HydraApi } from "@main/services/hydra-api";
import { logger } from "@main/services/logger";

const FEATURE_CACHE_TTL_MS = 5 * 60_000;
const FEATURE_REQUEST_TIMEOUT_MS = 5_000;

let cachedFeatures: { values: string[]; fetchedAt: number } | null = null;

const fetchFeatures = async (): Promise<string[]> => {
  const features = await HydraApi.get<unknown>("/features", undefined, {
    needsAuth: false,
    timeout: FEATURE_REQUEST_TIMEOUT_MS,
  });

  return Array.isArray(features)
    ? features.filter(
        (feature): feature is string => typeof feature === "string"
      )
    : [];
};

export const isSourceProviderSearchEnabled = async (): Promise<boolean> => {
  if (import.meta.env.DEV) return true;

  if (
    cachedFeatures &&
    performance.now() - cachedFeatures.fetchedAt < FEATURE_CACHE_TTL_MS
  ) {
    return cachedFeatures.values.includes(SOURCE_PROVIDER_SEARCH_FEATURE);
  }

  try {
    const values = await fetchFeatures();
    cachedFeatures = { values, fetchedAt: performance.now() };
    return values.includes(SOURCE_PROVIDER_SEARCH_FEATURE);
  } catch (error) {
    logger.warn("[SourceProviders] Could not load feature flags", error);
    return false;
  }
};
