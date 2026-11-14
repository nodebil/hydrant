import { registerProvider } from "@main/services/providers/registry";
import { steamripProvider } from "@main/services/providers/steamrip";
import { stubProvider } from "@main/services/providers/stub";

import "./cancel-source-provider-search";
import "./search-source-providers";

registerProvider(steamripProvider);

if (import.meta.env.DEV) {
  registerProvider(stubProvider);
}
