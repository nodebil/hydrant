import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isHostAllowed,
  isSourceUrlAllowed,
  parseHttpUrl,
} from "./url-policy.js";

describe("source url policy", () => {
  it("accepts only HTTP and HTTPS URLs", () => {
    assert.equal(
      parseHttpUrl("https://example.com/file")?.hostname,
      "example.com"
    );
    assert.equal(
      parseHttpUrl("http://example.com/file")?.hostname,
      "example.com"
    );
    assert.equal(parseHttpUrl("ftp://example.com/file"), null);
    assert.equal(parseHttpUrl("javascript:alert(1)"), null);
    assert.equal(parseHttpUrl("not a url"), null);
  });

  it("matches exact hosts and subdomains but not lookalikes", () => {
    assert.equal(isHostAllowed("fuckingfast.co", ["fuckingfast.co"]), true);
    assert.equal(isHostAllowed("cdn.fuckingfast.co", ["fuckingfast.co"]), true);
    assert.equal(
      isHostAllowed("evilfuckingfast.co", ["fuckingfast.co"]),
      false
    );
    assert.equal(
      isHostAllowed("fuckingfast.co.evil.com", ["fuckingfast.co"]),
      false
    );
    assert.equal(isHostAllowed("unrelated.test", ["fuckingfast.co"]), false);
  });

  it("requires an allowlisted host for a source URL", () => {
    const allowedHosts = ["steamrip.com"];

    assert.equal(
      isSourceUrlAllowed("https://steamrip.com/game/1", allowedHosts),
      true
    );
    assert.equal(
      isSourceUrlAllowed("https://cdn.steamrip.com/file", allowedHosts),
      true
    );
    assert.equal(
      isSourceUrlAllowed("https://steamrip.com.evil.test/game", allowedHosts),
      false
    );
    assert.equal(
      isSourceUrlAllowed("ftp://steamrip.com/game", allowedHosts),
      false
    );
    assert.equal(isSourceUrlAllowed("https://steamrip.com/game", []), false);
  });
});
