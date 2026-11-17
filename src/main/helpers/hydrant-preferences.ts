import type { HydrantPreferences } from "@types";
import { normalizeHydrantPreferences } from "@shared";
import { hydrantPreferencesSublevel, levelKeys } from "@main/level";

export const readHydrantPreferences = async (): Promise<HydrantPreferences> => {
  const stored = await hydrantPreferencesSublevel
    .get(levelKeys.hydrantPreferences)
    .catch(() => null);

  return normalizeHydrantPreferences(stored);
};

export const writeHydrantPreferences = async (
  preferences: HydrantPreferences
): Promise<HydrantPreferences> => {
  await hydrantPreferencesSublevel.put(
    levelKeys.hydrantPreferences,
    preferences
  );

  return preferences;
};
