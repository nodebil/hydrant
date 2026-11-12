import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_SOURCE_PREFERENCES,
  getSourceProviderFeatureFlag,
  SOURCE_PROVIDER_SEARCH_FEATURE,
} from "./source-providers.js";

describe("source provider flags", () => {
  it("names per-provider flags after the master flag", () => {
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

  it("keeps priority preferences empty and autopick off by default", () => {
    assert.deepEqual(DEFAULT_SOURCE_PREFERENCES, {
      providerPriority: [],
      hosterPriority: [],
      autoPick: false,
    });
  });
});
