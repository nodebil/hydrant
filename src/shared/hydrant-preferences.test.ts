import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_HYDRANT_PREFERENCES,
  mergeHydrantPreferences,
  normalizeHydrantPreferences,
} from "./hydrant-preferences.js";

describe("hydrant preferences", () => {
  it("defaults every fork tweak on", () => {
    assert.deepEqual(DEFAULT_HYDRANT_PREFERENCES, {
      steamMetadata: true,
      hideLeaderboards: true,
      hideRankingCard: true,
      hideFeedbackWidget: true,
    });
  });

  it("fills missing keys from defaults", () => {
    assert.deepEqual(normalizeHydrantPreferences({ hideLeaderboards: false }), {
      ...DEFAULT_HYDRANT_PREFERENCES,
      hideLeaderboards: false,
    });
  });

  it("ignores invalid values and unknown keys", () => {
    assert.deepEqual(
      normalizeHydrantPreferences({
        steamMetadata: "off",
        hideLeaderboards: null,
        hideRankingCard: 0,
        hideFeedbackWidget: false,
        unknown: true,
      }),
      { ...DEFAULT_HYDRANT_PREFERENCES, hideFeedbackWidget: false }
    );
  });

  it("falls back to defaults for a missing or malformed record", () => {
    assert.deepEqual(
      normalizeHydrantPreferences(null),
      DEFAULT_HYDRANT_PREFERENCES
    );
    assert.deepEqual(
      normalizeHydrantPreferences(["steamMetadata"]),
      DEFAULT_HYDRANT_PREFERENCES
    );
  });

  it("merges only valid updates over the current values", () => {
    const current = {
      steamMetadata: true,
      hideLeaderboards: false,
      hideRankingCard: false,
      hideFeedbackWidget: true,
    };

    assert.deepEqual(
      mergeHydrantPreferences(current, {
        hideLeaderboards: true,
        hideRankingCard: "yes",
      }),
      { ...current, hideLeaderboards: true }
    );
    assert.deepEqual(mergeHydrantPreferences(current, null), current);
  });
});
