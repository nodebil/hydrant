import type { HydrantPreferences } from "@types";
import {
  HYDRANT_UPDATE_PREFERENCES_CHANNEL,
  mergeHydrantPreferences,
} from "@shared";
import {
  readHydrantPreferences,
  writeHydrantPreferences,
} from "@main/helpers/hydrant-preferences";
import { registerEvent } from "../register-event";

const updateHydrantPreferences = async (
  _event: Electron.IpcMainInvokeEvent,
  update: unknown
): Promise<HydrantPreferences> => {
  const merged = mergeHydrantPreferences(
    await readHydrantPreferences(),
    update
  );

  return writeHydrantPreferences(merged);
};

registerEvent(HYDRANT_UPDATE_PREFERENCES_CHANNEL, updateHydrantPreferences, {
  jsonSafeResult: true,
});
