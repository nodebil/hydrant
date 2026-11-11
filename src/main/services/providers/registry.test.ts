import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderDefinition, SourceProviderId } from "@types";
import { UnsupportedSourceError } from "../source-fetch/errors.js";
import { getProvider, listProviders, registerProvider } from "./registry.js";

const makeProvider = (
  id: SourceProviderId,
  priority: number
): ProviderDefinition => ({
  id,
  name: id,
  baseUrl: `https://${id}.example`,
  priority,
  enabledByDefault: true,
  capabilities: { search: true, scrape: true },
  search: async () => [],
  scrape: async () => [],
});

describe("provider registry", () => {
  it("registers providers and rejects duplicate ids", () => {
    const provider = makeProvider("registry-dup-test", 1);

    registerProvider(provider);

    assert.equal(getProvider("registry-dup-test"), provider);
    assert.throws(
      () => registerProvider(makeProvider("registry-dup-test", 2)),
      /already registered/
    );
  });

  it("throws UnsupportedSourceError for unknown provider ids", () => {
    assert.throws(
      () => getProvider("registry-missing-provider"),
      (error: unknown) =>
        error instanceof UnsupportedSourceError &&
        error.code === "UNSUPPORTED_PROVIDER"
    );
  });

  it("lists providers by priority then id", () => {
    registerProvider(makeProvider("registry-order-b", 20));
    registerProvider(makeProvider("registry-order-a", 20));
    registerProvider(makeProvider("registry-order-c", 10));

    const ids = listProviders()
      .map((provider) => provider.id)
      .filter((id) => id.startsWith("registry-order-"));

    assert.deepEqual(ids, [
      "registry-order-c",
      "registry-order-a",
      "registry-order-b",
    ]);
  });
});
