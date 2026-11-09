import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getSourceProviderFeatureFlag,
  SOURCE_PROVIDER_SEARCH_FEATURE,
} from "./source-providers.js";

test("per-provider flags follow the documented naming scheme", () => {
  assert.equal(SOURCE_PROVIDER_SEARCH_FEATURE, "PROVIDER_SEARCH");
  assert.equal(
    getSourceProviderFeatureFlag("steamrip"),
    "PROVIDER_SEARCH_STEAMRIP"
  );
  assert.equal(
    getSourceProviderFeatureFlag("steam-rip"),
    "PROVIDER_SEARCH_STEAM_RIP"
  );
});
