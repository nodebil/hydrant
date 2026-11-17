import type { HydrantPreferences } from "@types";

import { db } from "../level";
import { levelKeys } from "./keys";

export const hydrantPreferencesSublevel = db.sublevel<
  string,
  HydrantPreferences
>(levelKeys.hydrant, {
  valueEncoding: "json",
});
