import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ProviderDefinition,
  ProviderLink,
  ProviderSearchHit,
  RankedSourceCandidate,
  SourceProviderStatusEvent,
  SourceSearchRequest,
  SourceSearchResult,
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

  it("keeps a repack whose only links are multipart", async () => {
    const parts = [
      "https://fuckingfast.co/a#Game.part1.rar",
      "https://fuckingfast.co/b#Game.part2.rar",
    ];
    const provider = makeProvider("orchestrator-multipart", {
      async scrape() {
        return [
          {
            kind: "hoster",
            url: parts[0],
            label: "FuckingFast",
            hosterId: "fuckingfast",
            parts,
          },
        ];
      },
    });
    registerProvider(provider);

    const [result] = await search(makeRequest([provider.id]));

    assert.equal(result.repacks.length, 1);
    assert.deepEqual(result.repacks[0].uris, []);
    assert.deepEqual(result.repacks[0].uriGroups, [parts]);
  });

  it("emits a structured source log with request, host, and technique", async () => {
    const provider = makeProvider("orchestrator-log", {
      requiresBrowser: true,
    });
    registerProvider(provider);

    const events: unknown[][] = [];
    const capture = (...params: unknown[]) => {
      events.push(params);
    };
    const captureLogger = {
      debug: capture,
      info: capture,
      warn: capture,
      error: capture,
    };

    await searchProviders(makeRequest([provider.id]), {
      signal: new AbortController().signal,
      logger: captureLogger,
    });

    const finish = events
      .map((params) => params[1] as Record<string, unknown>)
      .find((event) => event.event === "provider.search.finish");

    assert.ok(finish);
    assert.equal(finish.requestId, "request-1");
    assert.equal(finish.providerId, provider.id);
    assert.equal(finish.host, "provider.test");
    assert.equal(finish.technique, "browser");
    assert.equal(finish.outcome, "ok");
    assert.deepEqual(finish.details, { title: "Test Game" });
    assert.ok(Number(finish.durationMs) >= 0);
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

  it("skips providers whose per-provider flag is off", async () => {
    let calls = 0;
    const provider = makeProvider("orchestrator-flag", {
      async search() {
        calls += 1;
        return [hit];
      },
    });
    registerProvider(provider);

    const disabled = await searchProviders(makeRequest([provider.id]), {
      signal: new AbortController().signal,
      logger,
      isProviderEnabled: async (providerId) => providerId !== provider.id,
    });

    assert.deepEqual(disabled, []);
    assert.equal(calls, 0);

    const enabled = await searchProviders(makeRequest([provider.id]), {
      signal: new AbortController().signal,
      logger,
      isProviderEnabled: async () => true,
    });

    assert.equal(enabled[0].providerId, provider.id);
    assert.equal(enabled[0].status, "ok");
    assert.equal(calls, 1);
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

  it("keeps selection manual by default", async () => {
    const provider = makeProvider("orchestrator-manual");
    registerProvider(provider);

    let selections = 0;
    await searchProviders(makeRequest([provider.id]), {
      signal: new AbortController().signal,
      logger,
      onCandidateSelected: () => {
        selections += 1;
      },
    });

    assert.equal(selections, 0);
  });

  it("orders repacks by rank and reports an injected policy selection", async () => {
    const provider = makeProvider("orchestrator-rank", {
      async search(request) {
        return [
          {
            ...hit,
            providerId: "orchestrator-rank",
            title: request.title,
            url: "https://provider.test/game/low",
            confidence: 0.5,
          },
          {
            ...hit,
            providerId: "orchestrator-rank",
            title: request.title,
            url: "https://provider.test/game/high",
            confidence: 0.99,
          },
        ];
      },
      async scrape(gameHit) {
        return [
          {
            ...link,
            url: `https://gofile.io/d/${gameHit.url.split("/").pop()}`,
          },
        ];
      },
    });
    registerProvider(provider);

    const selected: RankedSourceCandidate[] = [];
    const [result] = await searchProviders(makeRequest([provider.id]), {
      signal: new AbortController().signal,
      logger,
      policy: { id: "auto", select: (candidates) => candidates[0] ?? null },
      onCandidateSelected: (candidate) => selected.push(candidate),
    });

    assert.equal(result.repacks.length, 2);
    assert.match(result.repacks[0].uris[0], /high$/);
    assert.match(result.repacks[1].uris[0], /low$/);
    assert.equal(selected.length, 1);
    assert.match(selected[0].repack.uris[0], /high$/);
  });

  it("times out a slow provider without blocking the others", async () => {
    let aborted = false;
    const slow = makeProvider("orchestrator-slow", {
      async search(_request, ctx) {
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        return [hit];
      },
    });
    const fast = makeProvider("orchestrator-fast");
    registerProvider(slow);
    registerProvider(fast);

    const statuses: SourceProviderStatusEvent[] = [];
    const streamed: SourceSearchResult[] = [];
    const results = await searchProviders(makeRequest([slow.id, fast.id]), {
      signal: new AbortController().signal,
      logger,
      providerTimeoutMs: 25,
      onStatus: (event) => statuses.push(event),
      onProviderResult: (result) => streamed.push(result),
    });

    assert.deepEqual(
      results.map((result) => result.providerId),
      [slow.id, fast.id]
    );
    assert.equal(results[0].status, "timeout");
    assert.equal(results[0].errorCode, "TIMEOUT");
    assert.equal(results[1].status, "ok");
    assert.equal(results[1].repacks.length, 1);
    assert.equal(aborted, true);

    const streamedFast = streamed.find(
      (result) => result.providerId === fast.id
    );
    const streamedSlow = streamed.find(
      (result) => result.providerId === slow.id
    );

    assert.equal(streamedFast?.status, "ok");
    assert.equal(streamedFast?.repacks.length, 1);
    assert.equal(streamedSlow?.status, "timeout");
    assert.deepEqual(streamedSlow?.repacks, []);

    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.deepEqual(
      statuses
        .filter((status) => status.providerId === slow.id)
        .map((status) => status.phase),
      ["searching", "error"]
    );
    assert.equal(results[0].repacks.length, 0);
  });

  it("streams each provider result before the search settles", async () => {
    let releaseSlow: () => void = () => {};
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const slow = makeProvider("orchestrator-stream-slow", {
      async search() {
        await slowGate;
        return [{ ...hit, providerId: "orchestrator-stream-slow" }];
      },
    });
    const fast = makeProvider("orchestrator-stream-fast");
    registerProvider(slow);
    registerProvider(fast);

    const streamed: SourceSearchResult[] = [];
    const pending = searchProviders(makeRequest([slow.id, fast.id]), {
      signal: new AbortController().signal,
      logger,
      onProviderResult: (result) => streamed.push(result),
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(
      streamed.map((result) => result.providerId),
      [fast.id]
    );
    assert.equal(streamed[0].repacks.length, 1);

    releaseSlow();
    const results = await pending;

    assert.deepEqual(
      streamed.map((result) => result.providerId),
      [fast.id, slow.id]
    );
    assert.deepEqual(
      results.map((result) => result.providerId),
      [slow.id, fast.id]
    );
  });

  it("caps how many providers search at once", async () => {
    let active = 0;
    let peak = 0;
    const started: string[] = [];
    const waiters: (() => void)[] = [];
    const makeBlockingProvider = (id: string) =>
      makeProvider(id, {
        async search() {
          started.push(id);
          active += 1;
          peak = Math.max(peak, active);
          await new Promise<void>((resolve) => waiters.push(resolve));
          active -= 1;
          return [{ ...hit, providerId: id }];
        },
      });
    const providers = [
      makeBlockingProvider("orchestrator-cap-a"),
      makeBlockingProvider("orchestrator-cap-b"),
      makeBlockingProvider("orchestrator-cap-c"),
    ];
    for (const provider of providers) registerProvider(provider);

    const pending = searchProviders(
      makeRequest(providers.map((provider) => provider.id)),
      {
        signal: new AbortController().signal,
        logger,
        concurrency: 2,
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(started, ["orchestrator-cap-a", "orchestrator-cap-b"]);

    waiters.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(started, [
      "orchestrator-cap-a",
      "orchestrator-cap-b",
      "orchestrator-cap-c",
    ]);

    for (const release of waiters.splice(0)) release();

    const results = await pending;
    assert.equal(peak, 2);
    assert.deepEqual(
      results.map((result) => result.providerId),
      providers.map((provider) => provider.id)
    );
    assert.ok(results.every((result) => result.status === "ok"));
  });

  it("drops candidates from a provider that fails partway", async () => {
    let scrapes = 0;
    const provider = makeProvider("orchestrator-partial", {
      async search() {
        return [
          {
            ...hit,
            providerId: "orchestrator-partial",
            url: "https://provider.test/game/1",
          },
          {
            ...hit,
            providerId: "orchestrator-partial",
            url: "https://provider.test/game/2",
          },
        ];
      },
      async scrape() {
        scrapes += 1;
        if (scrapes > 1) throw new SourceFetchError("TIMEOUT", "Too slow");
        return [link];
      },
    });
    registerProvider(provider);

    let rankedCandidates = -1;
    const [result] = await searchProviders(makeRequest([provider.id]), {
      signal: new AbortController().signal,
      logger,
      policy: {
        id: "auto",
        select: (candidates) => {
          rankedCandidates = candidates.length;
          return candidates[0] ?? null;
        },
      },
    });

    assert.equal(result.status, "timeout");
    assert.deepEqual(result.repacks, []);
    assert.equal(rankedCandidates, 0);
  });

  it("dedupes repeated cards from one provider", async () => {
    const provider = makeProvider("orchestrator-dedupe", {
      async search() {
        return [
          {
            ...hit,
            providerId: "orchestrator-dedupe",
            url: "https://provider.test/game/a",
          },
          {
            ...hit,
            providerId: "orchestrator-dedupe",
            url: "https://provider.test/game/b",
          },
          {
            ...hit,
            providerId: "orchestrator-dedupe",
            url: "https://provider.test/game/a",
          },
        ];
      },
    });
    registerProvider(provider);

    const [result] = await search(makeRequest([provider.id]));

    assert.equal(result.hits.length, 3);
    assert.equal(result.repacks.length, 1);
  });
});
