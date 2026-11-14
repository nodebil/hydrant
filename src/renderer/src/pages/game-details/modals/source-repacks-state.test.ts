import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SourceGameRepack, SourceSearchResult } from "@types";

import * as stateModule from "./source-repacks-state.js";

const { getSourceSearchOutcome } = stateModule;

const repack = {
  id: "provider:steamrip:595afaff",
  title: "Game",
  fileSize: "1 GB",
  uris: ["https://gofile.io/d/abc"],
  unavailableUris: [],
  uploadDate: null,
  downloadSourceId: "provider:steamrip",
  downloadSourceName: "SteamRip",
  createdAt: "2026-11-14T00:00:00.000Z",
} as SourceGameRepack;

const result = (
  providerId: string,
  overrides: Partial<SourceSearchResult> = {}
): SourceSearchResult => ({
  providerId,
  status: "ok",
  hits: [],
  repacks: [],
  durationMs: 1,
  ...overrides,
});

describe("source repacks state", () => {
  it("classifies the search outcome, including found-but-unsupported hosters", () => {
    assert.equal(getSourceSearchOutcome([]), "unavailable");
    assert.equal(
      getSourceSearchOutcome([
        result("empty", { status: "not-found" }),
        result("steamrip", { repacks: [repack] }),
      ]),
      "done"
    );
    assert.equal(
      getSourceSearchOutcome([
        result("steamrip", {
          status: "unsupported",
          errorCode: "UNSUPPORTED_HOSTER",
        }),
      ]),
      "unsupported"
    );
    assert.equal(
      getSourceSearchOutcome([
        result("steamrip", {
          status: "unsupported",
          errorCode: "UNSUPPORTED_HOSTER",
        }),
        result("broken", { status: "error", errorCode: "PARSE" }),
      ]),
      "failed"
    );
    assert.equal(
      getSourceSearchOutcome([
        result("timeout", { status: "timeout", errorCode: "TIMEOUT" }),
      ]),
      "failed"
    );
  });
});
