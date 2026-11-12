import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RankedSourceCandidate } from "@types";
import { DEFAULT_SOURCE_PREFERENCES } from "../../../shared/source-providers.js";
import { manualSelectionPolicy } from "./selection-policy.js";

const candidate: RankedSourceCandidate = {
  providerId: "test",
  repack: {
    id: "provider:test:00000001",
    title: "Test",
    fileSize: null,
    uris: ["https://files.example/test"],
    unavailableUris: [],
    uploadDate: null,
    downloadSourceId: "provider:test",
    downloadSourceName: "Test",
    createdAt: "2026-11-12T00:00:00.000Z",
  },
  score: 1,
  confidence: 1,
  buildMatch: false,
  hosterRank: 0,
};

describe("selection policy", () => {
  it("leaves the choice to the user with the manual policy", () => {
    assert.equal(manualSelectionPolicy.id, "manual");
    assert.equal(
      manualSelectionPolicy.select([], DEFAULT_SOURCE_PREFERENCES),
      null
    );
    assert.equal(
      manualSelectionPolicy.select([candidate], DEFAULT_SOURCE_PREFERENCES),
      null
    );
  });
});
