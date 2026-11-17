import { gamebountyProvider } from "@main/services/providers/gamebounty";
import { registerProvider } from "@main/services/providers/registry";
import { steamggProvider } from "@main/services/providers/steamgg";
import { steamripProvider } from "@main/services/providers/steamrip";
import { stubProvider } from "@main/services/providers/stub";

import "./cancel-source-provider-search";
import "./get-source-provider-availability";
import "./search-source-providers";

registerProvider(steamripProvider);
registerProvider(steamggProvider);
registerProvider(gamebountyProvider);

if (import.meta.env.DEV) {
  registerProvider(stubProvider);
}
