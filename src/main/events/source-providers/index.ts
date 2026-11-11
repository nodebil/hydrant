import { registerProvider } from "@main/services/providers/registry";
import { stubProvider } from "@main/services/providers/stub";

import "./cancel-source-provider-search";
import "./search-source-providers";

if (import.meta.env.DEV) {
  registerProvider(stubProvider);
}
