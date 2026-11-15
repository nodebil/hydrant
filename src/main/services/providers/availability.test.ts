import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderDefinition, SourceProviderId } from "@types";
import {
  isProviderAvailable,
  listAvailableProviderIds,
} from "./availability.js";
import { registerProvider } from "./registry.js";

const makeProvider = (id: SourceProviderId): ProviderDefinition => ({
  id,
  name: id,
  baseUrl: `https://${id}.example`,
  priority: 1,
  enabledByDefault: true,
  capabilities: { search: true, scrape: true },
  search: async () => [],
  scrape: async () => [],
});

describe("provider availability", () => {
  it("lists every registered provider", () => {
    registerProvider(makeProvider("availability-registered"));

    assert.deepEqual(
      listAvailableProviderIds().filter((id) => id.startsWith("availability-")),
      ["availability-registered"]
    );
  });

  it("reports unregistered providers as unavailable", async () => {
    assert.equal(await isProviderAvailable("availability-registered"), true);
    assert.equal(await isProviderAvailable("availability-missing"), false);
  });
});
