import type { HydrantPreferences } from "@types";
import { HYDRANT_GET_PREFERENCES_CHANNEL } from "@shared";
import { readHydrantPreferences } from "@main/helpers/hydrant-preferences";
import { registerEvent } from "../register-event";

const getHydrantPreferences = (): Promise<HydrantPreferences> =>
  readHydrantPreferences();

registerEvent(HYDRANT_GET_PREFERENCES_CHANNEL, getHydrantPreferences, {
  jsonSafeResult: true,
});
