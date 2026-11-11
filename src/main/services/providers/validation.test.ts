import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SourceSearchRequest } from "@types";
import { SourceFetchError } from "../source-fetch/errors.js";
import {
  validateRequestId,
  validateSourceSearchRequest,
} from "./validation.js";

const request: SourceSearchRequest = {
  requestId: "request-1",
  shop: "steam",
  objectId: "123456",
  title: "Test Game",
  steamAppId: 123456,
  providerIds: ["steamrip"],
};

const assertInvalid = (payload: unknown) =>
  assert.throws(
    () => validateSourceSearchRequest(payload),
    (error: unknown) =>
      error instanceof SourceFetchError && error.code === "INVALID_INPUT"
  );

describe("source search request validation", () => {
  it("accepts a minimal and a complete request", () => {
    assert.deepEqual(
      validateSourceSearchRequest({
        requestId: "request-2",
        shop: "custom",
        objectId: "game-1",
        title: "A Game",
      }),
      {
        requestId: "request-2",
        shop: "custom",
        objectId: "game-1",
        title: "A Game",
      }
    );

    assert.deepEqual(validateSourceSearchRequest(request), request);
  });

  it("rejects malformed payloads", () => {
    assertInvalid(null);
    assertInvalid("request");
    assertInvalid([]);
    assertInvalid({ ...request, requestId: "" });
    assertInvalid({ ...request, requestId: 42 });
    assertInvalid({ ...request, shop: "gog" });
    assertInvalid({ ...request, objectId: " ".repeat(3) });
    assertInvalid({ ...request, title: "x".repeat(501) });
  });

  it("rejects invalid optional fields", () => {
    assertInvalid({ ...request, steamAppId: 0 });
    assertInvalid({ ...request, steamAppId: 1.5 });
    assertInvalid({ ...request, steamAppId: "123" });
    assertInvalid({ ...request, providerIds: "steamrip" });
    assertInvalid({ ...request, providerIds: [""] });
    assertInvalid({ ...request, providerIds: ["steamrip", "steamrip"] });
    assertInvalid({
      ...request,
      providerIds: Array.from(
        { length: 21 },
        (_, index) => `provider-${index}`
      ),
    });
  });

  it("validates cancel request ids", () => {
    assert.equal(validateRequestId(" request-1 "), "request-1");
    assert.throws(
      () => validateRequestId(""),
      (error: unknown) =>
        error instanceof SourceFetchError && error.code === "INVALID_INPUT"
    );
  });
});
