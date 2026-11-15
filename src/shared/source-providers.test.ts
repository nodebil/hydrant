import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SOURCE_PREFERENCES } from "./source-providers.js";

describe("source provider defaults", () => {
  it("keeps priority preferences empty and autopick off by default", () => {
    assert.deepEqual(DEFAULT_SOURCE_PREFERENCES, {
      providerPriority: [],
      hosterPriority: [],
      autoPick: false,
    });
  });
});
