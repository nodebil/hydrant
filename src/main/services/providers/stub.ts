import type { ProviderDefinition } from "@types";

const STUB_PROVIDER_PRIORITY = 1000;

export const stubProvider: ProviderDefinition = {
  id: "stub",
  name: "Stub",
  baseUrl: "https://example.com",
  priority: STUB_PROVIDER_PRIORITY,
  enabledByDefault: true,
  capabilities: { search: true, scrape: true },
  async search(request) {
    const gamePath = encodeURIComponent(request.objectId);

    return [
      {
        providerId: "stub",
        title: request.title,
        url: `https://example.com/games/${gamePath}`,
        confidence: 1,
        size: "1 GB",
      },
    ];
  },
  async scrape(hit) {
    const gamePath = hit.url.split("/").pop() ?? "game";

    return [
      {
        kind: "hoster",
        url: `https://gofile.io/d/stub-${gamePath}`,
        label: "Gofile",
        hosterId: "gofile",
        size: "1 GB",
      },
    ];
  },
};
