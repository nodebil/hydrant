import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SourceFetchError } from "../source-fetch/errors.js";
import {
  beginSourceProviderSearch,
  cancelSourceProviderSearch,
  finishSourceProviderSearch,
} from "./search-sessions.js";

describe("source provider search sessions", () => {
  it("aborts an active search", () => {
    const controller = beginSourceProviderSearch("session-cancel");

    assert.equal(cancelSourceProviderSearch("session-cancel"), true);
    assert.equal(controller.signal.aborted, true);
    assert.equal(cancelSourceProviderSearch("session-cancel"), true);

    finishSourceProviderSearch("session-cancel", controller);
    assert.equal(cancelSourceProviderSearch("session-cancel"), false);
  });

  it("rejects duplicate request ids", () => {
    const controller = beginSourceProviderSearch("session-duplicate");

    assert.throws(
      () => beginSourceProviderSearch("session-duplicate"),
      (error: unknown) =>
        error instanceof SourceFetchError && error.code === "INVALID_INPUT"
    );

    finishSourceProviderSearch("session-duplicate", controller);
  });

  it("only finishes the session it owns", () => {
    const controller = beginSourceProviderSearch("session-owned");
    const other = new AbortController();

    finishSourceProviderSearch("session-owned", other);
    assert.equal(cancelSourceProviderSearch("session-owned"), true);

    finishSourceProviderSearch("session-owned", controller);
    assert.equal(cancelSourceProviderSearch("session-owned"), false);
  });
});
