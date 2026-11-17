import type { HydrantPreferences } from "@types";

export const HYDRANT_GET_PREFERENCES_CHANNEL = "getHydrantPreferences";
export const HYDRANT_UPDATE_PREFERENCES_CHANNEL = "updateHydrantPreferences";

export const HYDRANT_PREFERENCE_KEYS = [
  "steamMetadata",
  "hideLeaderboards",
  "hideRankingCard",
  "hideFeedbackWidget",
] as const;

export const DEFAULT_HYDRANT_PREFERENCES: HydrantPreferences = {
  steamMetadata: true,
  hideLeaderboards: true,
  hideRankingCard: true,
  hideFeedbackWidget: true,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assignBooleans = (base: HydrantPreferences, source: unknown) => {
  const preferences = { ...base };
  if (!isRecord(source)) return preferences;

  for (const key of HYDRANT_PREFERENCE_KEYS) {
    const value = source[key];
    if (typeof value === "boolean") preferences[key] = value;
  }

  return preferences;
};

export const normalizeHydrantPreferences = (value: unknown) =>
  assignBooleans(DEFAULT_HYDRANT_PREFERENCES, value);

export const mergeHydrantPreferences = (
  current: HydrantPreferences,
  update: unknown
) => assignBooleans(current, update);
