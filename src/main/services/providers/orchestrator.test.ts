import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ProviderDefinition,
  ProviderLink,
  ProviderSearchHit,
  SourceProviderStatusEvent,
  SourceSearchRequest,
} from "@types";
import {
  SourceFetchError,
  UnsupportedSourceError,
} from "../source-fetch/errors.js";
import { searchProviders } from "./orchestrator.js";
import { registerProvider } from "./registry.js";
import { stubProvider } from "./stub.js";

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const hit: ProviderSearchHit = {
  providerId: "unused",
  title: "Test Game",
  url: "https://provider.test/game/1",
  confidence: 1,
  size: "2 GB",
};

const link: ProviderLink = {
  kind: "hoster",
  url: "https://gofile.io/d/abc",
  label: "Gofile",
  hosterId: "gofile",
  size: "2 GB",
};

const makeRequest = (providerIds?: string[]): SourceSearchRequest => ({
  requestId: "request-1",
  shop: "steam",
  objectId: "123456",
  title: "Test Game",
  ...(providerIds ? { providerIds } : {}),
});

const makeProvider = (
  id: string,
  overrides: Partial<ProviderDefinition> = {}
): ProviderDefinition => ({
  id,
  name: id,
  baseUrl: "https://provider.test",
  priority: 1,
  enabledByDefault: true,
  capabilities: { search: true, scrape: true },
  async search(request) {
    return [
      {
        ...hit,
        providerId: id,
        title: request.title,
        url: `https://provider.test/game/${request.objectId}`,
      },
    ];
  },
  async scrape() {
    return [link];
  },
  ...overrides,
});

const search = async (
  request: SourceSearchRequest,
  signal = new AbortController().signal,
  onStatus?: (event: SourceProviderStatusEvent) => void
) => searchProviders(request, { signal, logger, onStatus });

describe("source provider orchestrator", () => {
  it("returns a synthetic repack and reports progress", async () => {
    const provider = makeProvider("orchestrator-ok");
    registerProvider(provider);

    const statuses: SourceProviderStatusEvent[] = [];
    const results = await search(
      makeRequest([provider.id]),
      undefined,
      (event) => statuses.push(event)
    );

    assert.equal(results.length, 1);
    const [result] = results;

    assert.equal(result.providerId, provider.id);
    assert.equal(result.status, "ok");
    assert.equal(result.errorCode, undefined);
    assert.equal(result.repacks.length, 1);
    assert.equal(result.hits.length, 1);
    assert.ok(result.durationMs >= 0);

    const [repack] = result.repacks;
    assert.match(repack.id, /^provider:orchestrator-ok:[0-9a-f]{8}$/);
    assert.equal(repack.downloadSourceId, "provider:orchestrator-ok");
    assert.equal(repack.downloadSourceName, provider.name);
    assert.deepEqual(repack.uris, [link.url]);
    assert.equal(repack.fileSize, "2 GB");

    assert.deepEqual(
      statuses.map((status) => status.phase),
      ["searching", "scraping", "done"]
    );
    assert.ok(statuses.every((status) => status.requestId === "request-1"));
    assert.equal(statuses[2].count, 1);
  });

  it("turns the dev stub into a synthetic repack", async () => {
    registerProvider(stubProvider);

    const [result] = await search(makeRequest([stubProvider.id]));

    assert.equal(result.status, "ok");
    assert.equal(result.repacks.length, 1);
    assert.equal(result.repacks[0].downloadSourceId, "provider:stub");
    assert.deepEqual(result.repacks[0].uris, [
      "https://gofile.io/d/stub-123456",
    ]);
  });

  it("reports not-found for empty search results", async () => {
    const provider = makeProvider("orchestrator-empty", {
      async search() {
        return [];
      },
    });
    registerProvider(provider);

    const statuses: SourceProviderStatusEvent[] = [];
    const results = await search(
      makeRequest([provider.id]),
      undefined,
      (event) => statuses.push(event)
    );

    assert.equal(results[0].status, "not-found");
    assert.deepEqual(results[0].repacks, []);
    assert.deepEqual(
      statuses.map((status) => status.phase),
      ["searching", "done"]
    );
  });

  it("maps provider failures to typed results", async () => {
    const timeoutProvider = makeProvider("orchestrator-timeout", {
      async search() {
        throw new SourceFetchError("TIMEOUT", "Too slow");
      },
    });
    const parseProvider = makeProvider("orchestrator-parse", {
      async search() {
        throw new Error("selector missing: .game");
      },
    });
    registerProvider(timeoutProvider);
    registerProvider(parseProvider);

    const results = await search(
      makeRequest([timeoutProvider.id, parseProvider.id])
    );

    assert.equal(results[0].status, "timeout");
    assert.equal(results[0].errorCode, "TIMEOUT");
    assert.equal(results[1].status, "error");
    assert.equal(results[1].errorCode, "PARSE");
  });

  it("returns CANCELLED when the search is aborted", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const provider = makeProvider("orchestrator-cancel", {
      async search() {
        await gate;
        return [hit];
      },
    });
    registerProvider(provider);

    const controller = new AbortController();
    const statuses: SourceProviderStatusEvent[] = [];
    const pending = search(
      makeRequest([provider.id]),
      controller.signal,
      (event) => statuses.push(event)
    );

    controller.abort();
    release();

    const [result] = await pending;

    assert.equal(result.status, "error");
    assert.equal(result.errorCode, "CANCELLED");
    assert.deepEqual(
      statuses.map((status) => status.phase),
      ["searching", "error"]
    );
  });

  it("searches only enabled providers unless ids are explicit", async () => {
    let calls = 0;
    const provider = makeProvider("orchestrator-disabled", {
      enabledByDefault: false,
      async search() {
        calls += 1;
        return [hit];
      },
    });
    registerProvider(provider);

    const implicit = await search(makeRequest());
    assert.equal(
      implicit.some((result) => result.providerId === provider.id),
      false
    );
    assert.equal(calls, 0);

    const explicit = await search(makeRequest([provider.id]));
    assert.equal(explicit[0].providerId, provider.id);
    assert.equal(calls, 1);
  });

  it("rejects unknown provider ids", async () => {
    await assert.rejects(
      () => search(makeRequest(["orchestrator-missing"])),
      (error: unknown) =>
        error instanceof UnsupportedSourceError &&
        error.code === "UNSUPPORTED_PROVIDER"
    );
  });
});
