import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import ts from "typescript";
import type {
  ProviderContext,
  SourceLogger,
  SourceSearchRequest,
} from "@types";
import { Downloader } from "../../../shared/constants.js";
import { getDownloadersForUris } from "../../../shared/downloader-mapping.js";
import * as matchingModule from "../../../shared/source-matching.js";
import { toSyntheticRepack } from "../../../shared/source-repack.js";
import * as errorsModule from "../source-fetch/errors.js";
import {
  SourceFetchError,
  isSourceFetchError,
} from "../source-fetch/errors.js";
import * as httpClientModule from "../source-fetch/http-client.js";
import * as sourceLogModule from "../source-fetch/source-log.js";
import type { SourceLogEvent } from "../source-fetch/source-log.js";
import * as urlPolicyModule from "../source-fetch/url-policy.js";
import * as htmlModule from "./html.js";
import {
  buildSteamRipApiFullTextUrl,
  buildSteamRipApiSearchUrl,
  parseSteamRipContent,
  parseSteamRipGame,
  parseSteamRipSearch,
  steamripProvider,
} from "./steamrip.js";

const fixture = (name: string) =>
  readFileSync(
    new URL(`./__fixtures__/steamrip/${name}`, import.meta.url),
    "utf8"
  );

const searchPageUrl = "https://steamrip.com/?s=dead+space";
const gamePageUrl = "https://steamrip.com/elden-ring-de-free-download-1gg/";

const isParseError = (error: unknown) =>
  isSourceFetchError(error) && error.code === "PARSE";

const isBlockedError = (error: unknown) =>
  isSourceFetchError(error) && error.code === "BLOCKED";

interface FakeBrowserSession {
  navigate(url: string): Promise<void>;
  detectCloudflare(): Promise<boolean>;
  readHtml(): Promise<string>;
  close(): void;
}

const loadProviderWithSession = (
  open: (options: { partition: string }) => Promise<FakeBrowserSession>
) => {
  const { outputText } = ts.transpileModule(
    readFileSync(new URL("./steamrip.ts", import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: "steamrip.ts",
    }
  );
  const stubs: Record<string, unknown> = {
    "../../../shared/source-matching.js": matchingModule,
    "../source-fetch/browser-session.js": {
      HiddenBrowserSession: { open },
    },
    "../source-fetch/errors.js": errorsModule,
    "../source-fetch/http-client.js": httpClientModule,
    "../source-fetch/source-log.js": sourceLogModule,
    "../source-fetch/url-policy.js": urlPolicyModule,
    "./html.js": htmlModule,
  };
  const exports: Record<string, unknown> = {};
  new Function("exports", "require", outputText)(exports, (name: string) => {
    const stub = stubs[name];
    if (!stub) throw new Error(`Unexpected import: ${name}`);
    return stub;
  });

  return exports.steamripProvider as typeof steamripProvider;
};

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const createRecordingLogger = () => {
  const entries: { level: string; event: SourceLogEvent }[] = [];
  const record =
    (level: string) => (_prefix: unknown, event: SourceLogEvent) => {
      entries.push({ level, event });
    };

  const logger: SourceLogger = {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };

  return { entries, logger };
};

const createSequencedSessionFactory = (pages: string[]) => {
  const partitions: string[] = [];
  const userAgents: string[] = [];

  const open = async (options: {
    partition: string;
    userAgent?: string;
  }): Promise<FakeBrowserSession> => {
    const page = pages[Math.min(partitions.length, pages.length - 1)];
    partitions.push(options.partition);
    userAgents.push(options.userAgent ?? "");

    return {
      navigate: async () => undefined,
      detectCloudflare: async () => false,
      readHtml: async () => page,
      close: () => undefined,
    };
  };

  return { open, partitions, userAgents };
};

const searchRequest = (requestId: string): SourceSearchRequest => ({
  requestId,
  shop: "steam",
  objectId: "1245620",
  title: "ELDEN RING",
  steamAppId: 1245620,
});

const apiBlocked = (async () => {
  throw new SourceFetchError("BLOCKED", "SteamRip API blocked the request.");
}) as typeof fetch;

const providerContext = (
  requestId: string,
  logger: SourceLogger = noopLogger,
  fetchImpl: typeof fetch = apiBlocked
): ProviderContext => ({
  signal: new AbortController().signal,
  fetch: fetchImpl,
  logger,
  requestId,
});

const requestUrl = (input: Parameters<typeof fetch>[0]): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

const createFetch = (resolve: (url: string) => string) => {
  const urls: string[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = requestUrl(input);
    urls.push(url);

    return new Response(resolve(url), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return { fetch: fetchImpl, urls };
};

describe("steamrip provider", () => {
  it("matches the requested game and rejects sequels", () => {
    const html = fixture("search.html");

    const hits = parseSteamRipSearch(html, "ELDEN RING", searchPageUrl);

    assert.equal(hits.length, 1);
    assert.equal(
      hits[0].title,
      "Elden Ring Deluxe Edition Free Download (v1.17.2)"
    );
    assert.equal(
      hits[0].url,
      "https://steamrip.com/elden-ring-de-free-download-1gg/"
    );
    assert.equal(hits[0].build, "25827938");
    assert.equal(hits[0].size, "69.1 GB");
    assert.equal(hits[0].confidence, 1);
    assert.ok(!hits.some((hit) => hit.title.includes("NIGHTREIGN")));
  });

  it("uses release years to tell same-name remakes apart", () => {
    const html = fixture("search.html");

    const hits = parseSteamRipSearch(html, "Dead Space (2023)", searchPageUrl);

    assert.deepEqual(
      hits.map((hit) => hit.url),
      ["https://steamrip.com/dead-space-2023-free-download/"]
    );
  });

  it("matches titles with apostrophes and remaster suffixes", () => {
    const html = fixture("search.html");

    const hits = parseSteamRipSearch(
      html,
      "Marvel's Spider-Man Remastered",
      searchPageUrl
    );

    assert.deepEqual(
      hits.map((hit) => hit.url),
      ["https://steamrip.com/marvels-spider-man-remastered-free-download/"]
    );
    assert.equal(hits[0].build, "23986256");
  });

  it("reads game size, build, and only the primary hoster links", () => {
    const page = parseSteamRipGame(fixture("game.html"), gamePageUrl, 1245620);

    assert.equal(page.size, "69.1 GB");
    assert.equal(page.build, "25827938");
    assert.deepEqual(
      page.links.map((link) => link.hosterId),
      ["gofile", "buzzheavier", "fileditch"]
    );
    assert.deepEqual(
      page.links.map((link) => link.url),
      [
        "https://gofile.io/d/qpvferIa",
        "https://bzzhr.to/kgze9ln1colu",
        "https://itsfileditchfiles.st/balpha38/b4e093a71b76bc208a75/ELDEN.RING-SteamRIP.com.rar",
      ]
    );
    assert.ok(
      page.links.every(
        (link) =>
          link.kind === "hoster" &&
          link.size === "69.1 GB" &&
          link.build === "25827938"
      )
    );
    assert.ok(!page.links.some((link) => link.url.includes("language-pack")));
  });

  it("keeps the MegaDB mirror as a supported hoster link", () => {
    const page = parseSteamRipGame(
      fixture("game-megadb.html"),
      "https://steamrip.com/ftl-faster-than-light-free-download/"
    );

    assert.deepEqual(
      page.links.map((link) => ({
        hosterId: link.hosterId,
        label: link.label,
        url: link.url,
      })),
      [
        {
          hosterId: "megadb",
          label: "MegaDB",
          url: "https://megadb.net/89bf12c47dbe5b69",
        },
      ]
    );
  });

  it("drops a candidate page that belongs to another steam app", () => {
    const page = parseSteamRipGame(fixture("game.html"), gamePageUrl, 17470);

    assert.deepEqual(page.links, []);
  });

  it("hands supported SteamRip links to the downloader mapping", () => {
    const page = parseSteamRipGame(fixture("game.html"), gamePageUrl, 1245620);
    const repack = toSyntheticRepack(
      steamripProvider,
      {
        providerId: "steamrip",
        title: "Elden Ring Deluxe Edition",
        url: gamePageUrl,
        confidence: 1,
        build: "25827938",
        size: "69.1 GB",
      },
      page.links
    );

    assert.deepEqual(getDownloadersForUris(repack.uris), [
      Downloader.Gofile,
      Downloader.Buzzheavier,
      Downloader.Fileditch,
    ]);
    assert.equal(repack.uris.includes("https://gofile.io/d/qpvferIa"), true);
  });

  it("groups multipart files in part order", () => {
    const page = parseSteamRipGame(fixture("game-multipart.html"), gamePageUrl);

    assert.equal(page.links.length, 1);
    assert.equal(
      page.links[0].url,
      "https://itsfileditchfiles.st/balpha38/hash/ELDEN.RING.part1.rar"
    );
    assert.deepEqual(page.links[0].parts, [
      "https://itsfileditchfiles.st/balpha38/hash/ELDEN.RING.part1.rar",
      "https://itsfileditchfiles.st/balpha38/hash/ELDEN.RING.part2.rar",
    ]);
  });

  it("returns no hits for a nothing-found search page", () => {
    assert.deepEqual(
      parseSteamRipSearch(
        fixture("search-empty.html"),
        "zzqqxxnoveltygame",
        searchPageUrl
      ),
      []
    );
  });

  it("returns PARSE when search cards or the game info block disappear", () => {
    assert.throws(
      () =>
        parseSteamRipSearch(
          fixture("search-drift.html"),
          "ELDEN RING",
          searchPageUrl
        ),
      isParseError
    );
    assert.throws(
      () => parseSteamRipGame(fixture("game-drift.html"), gamePageUrl),
      isParseError
    );
  });

  it("classifies empty and challenge pages as BLOCKED", () => {
    assert.throws(
      () =>
        parseSteamRipSearch(
          fixture("blocked.html"),
          "ELDEN RING",
          searchPageUrl
        ),
      isBlockedError
    );
    assert.throws(
      () => parseSteamRipGame("<html><body></body></html>", gamePageUrl),
      isBlockedError
    );
  });

  it("reuses one persistent SteamRip partition across searches", async () => {
    const fake = createSequencedSessionFactory([fixture("search.html")]);
    const provider = loadProviderWithSession(fake.open);

    const first = await provider.search(
      searchRequest("first-request"),
      providerContext("first-request")
    );
    const second = await provider.search(
      searchRequest("second-request"),
      providerContext("second-request")
    );

    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.deepEqual(fake.partitions, [
      "persist:hydra-steamrip",
      "persist:hydra-steamrip",
    ]);
  });

  it("presents a plain Chrome user agent instead of the app identity", async () => {
    const fake = createSequencedSessionFactory([fixture("search.html")]);
    const provider = loadProviderWithSession(fake.open);

    await provider.search(
      searchRequest("user-agent"),
      providerContext("user-agent")
    );

    assert.match(
      fake.userAgents[0],
      /^Mozilla\/5\.0 .* Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/
    );
    assert.doesNotMatch(fake.userAgents[0], /Electron|hydralauncher/);
  });

  it("retries an empty page once in a new window and logs it", async () => {
    const fake = createSequencedSessionFactory(["", fixture("search.html")]);
    const { entries, logger } = createRecordingLogger();
    const provider = loadProviderWithSession(fake.open);

    const hits = await provider.search(
      searchRequest("retry-empty"),
      providerContext("retry-empty", logger)
    );

    assert.equal(hits.length, 1);
    assert.deepEqual(fake.partitions, [
      "persist:hydra-steamrip",
      "persist:hydra-steamrip",
    ]);
    const pageFailures = entries.filter(
      (entry) => entry.event.event === "provider.page.failed"
    );
    assert.equal(pageFailures.length, 1);
    assert.equal(pageFailures[0].level, "warn");
    assert.equal(pageFailures[0].event.errorCode, "BLOCKED");
    assert.deepEqual(pageFailures[0].event.details, {
      phase: "search",
      attempt: 1,
      retry: true,
      title: "",
      length: 0,
    });
  });

  it("returns PARSE after one retry when selectors drift and logs the page", async () => {
    const drift = fixture("search-drift.html");
    const fake = createSequencedSessionFactory([drift, drift]);
    const { entries, logger } = createRecordingLogger();
    const provider = loadProviderWithSession(fake.open);

    await assert.rejects(
      () =>
        provider.search(
          searchRequest("retry-drift"),
          providerContext("retry-drift", logger)
        ),
      isParseError
    );

    const pageFailures = entries.filter(
      (entry) => entry.event.event === "provider.page.failed"
    );
    assert.deepEqual(fake.partitions, [
      "persist:hydra-steamrip",
      "persist:hydra-steamrip",
    ]);
    assert.deepEqual(
      pageFailures.map((entry) => entry.event.details?.retry),
      [true, false]
    );
    assert.equal(pageFailures[1].event.errorCode, "PARSE");
    assert.match(
      String(pageFailures[1].event.details?.title),
      /^You searched for/
    );
    assert.equal(pageFailures[1].event.details?.length, drift.length);
  });

  it("does not retry a Cloudflare challenge page", async () => {
    const fake = createSequencedSessionFactory([
      fixture("blocked.html"),
      fixture("search.html"),
    ]);
    const { entries, logger } = createRecordingLogger();
    const provider = loadProviderWithSession(fake.open);

    await assert.rejects(
      () =>
        provider.search(
          searchRequest("retry-challenge"),
          providerContext("retry-challenge", logger)
        ),
      isBlockedError
    );

    const pageFailures = entries.filter(
      (entry) => entry.event.event === "provider.page.failed"
    );
    assert.equal(fake.partitions.length, 1);
    assert.deepEqual(
      pageFailures.map((entry) => entry.event.details?.retry),
      [false]
    );
  });

  it("classifies a 403 page as BLOCKED without retrying", async () => {
    const fake = createSequencedSessionFactory([
      fixture("403.html"),
      fixture("search.html"),
    ]);
    const { entries, logger } = createRecordingLogger();
    const provider = loadProviderWithSession(fake.open);

    await assert.rejects(
      () =>
        provider.search(
          searchRequest("blocked-403"),
          providerContext("blocked-403", logger)
        ),
      isBlockedError
    );

    const pageFailures = entries.filter(
      (entry) => entry.event.event === "provider.page.failed"
    );
    assert.equal(fake.partitions.length, 1);
    assert.equal(pageFailures[0].event.errorCode, "BLOCKED");
    assert.equal(pageFailures[0].event.details?.title, "403 Forbidden");
    assert.equal(pageFailures[0].event.details?.retry, false);
  });

  it("parses API content the same as the game page", () => {
    const [post] = JSON.parse(fixture("api-search.json"));

    assert.deepEqual(
      parseSteamRipContent(
        post.content.rendered,
        gamePageUrl,
        1245620,
        1245620
      ),
      parseSteamRipGame(fixture("game.html"), gamePageUrl, 1245620)
    );
  });

  it("resolves a game from one API request and reuses it for scrape", async () => {
    const fake = createFetch(() => fixture("api-search.json"));
    const hits = await steamripProvider.search(searchRequest("api-success"), {
      ...providerContext("api-success"),
      fetch: fake.fetch,
    });

    assert.deepEqual(fake.urls, [buildSteamRipApiSearchUrl("ELDEN RING")]);
    assert.match(fake.urls[0], /search_columns%5B%5D=post_title/);
    assert.match(fake.urls[0], /search=elden\+ring/);
    assert.equal(hits.length, 1);
    assert.equal(
      hits[0].title,
      "Elden Ring Deluxe Edition Free Download (v1.17.2)"
    );
    assert.equal(hits[0].url, gamePageUrl);
    assert.equal(hits[0].size, "69.1 GB");
    assert.equal(hits[0].build, "25827938");
    assert.equal(hits[0].steamAppId, 1245620);

    const links = await steamripProvider.scrape(hits[0], {
      ...providerContext("api-success-scrape"),
      fetch: fake.fetch,
    });

    assert.equal(fake.urls.length, 1);
    assert.deepEqual(
      links.map((link) => link.hosterId),
      ["gofile", "buzzheavier", "fileditch"]
    );
    assert.deepEqual(
      links.map((link) => link.url),
      [
        "https://gofile.io/d/qpvferIa",
        "https://bzzhr.to/kgze9ln1colu",
        "https://itsfileditchfiles.st/balpha38/b4e093a71b76bc208a75/ELDEN.RING-SteamRIP.com.rar",
      ]
    );
    assert.ok(links.every((link) => link.referer === gamePageUrl));
  });

  it("normalizes the title so the apostrophe post resolves", async () => {
    const fake = createFetch(() => fixture("api-spider-man.json"));
    const request = {
      ...searchRequest("api-apostrophe"),
      objectId: "1817070",
      title: "Marvel's Spider-Man Remastered",
      steamAppId: 1817070,
    };
    const hits = await steamripProvider.search(request, {
      ...providerContext("api-apostrophe"),
      fetch: fake.fetch,
    });

    assert.deepEqual(fake.urls, [buildSteamRipApiSearchUrl(request.title)]);
    assert.match(fake.urls[0], /search=marvels\+spider\+man\b/);
    assert.equal(hits.length, 1);
    assert.equal(
      hits[0].url,
      "https://steamrip.com/marvels-spider-man-remastered-free-download/"
    );
    assert.equal(
      hits[0].title,
      "Marvel’s Spider-Man Remastered Free Download (v4.630.0.0)"
    );
    assert.equal(hits[0].size, "53.7 GB");
    assert.equal(hits[0].build, "23986256");

    const links = await steamripProvider.scrape(hits[0], {
      ...providerContext("api-apostrophe-scrape"),
      fetch: fake.fetch,
    });

    assert.deepEqual(
      links.map((link) => link.hosterId),
      ["gofile", "buzzheavier"]
    );
  });

  it("drops an appid mismatch and skips off-host API posts", async () => {
    const mismatch = createFetch(() => fixture("api-mismatch.json"));
    const mismatchHits = await steamripProvider.search(
      searchRequest("api-mismatch"),
      { ...providerContext("api-mismatch"), fetch: mismatch.fetch }
    );

    assert.equal(mismatchHits.length, 1);
    assert.deepEqual(
      await steamripProvider.scrape(mismatchHits[0], {
        ...providerContext("api-mismatch-scrape"),
        fetch: mismatch.fetch,
      }),
      []
    );
    assert.equal(mismatch.urls.length, 1);

    const [post] = JSON.parse(fixture("api-search.json"));
    const offHost = {
      ...post,
      link: "https://steamrip.com.evil.test/elden-ring-de-free-download-1gg/",
    };
    const mixed = createFetch(() => JSON.stringify([offHost, post]));
    const hits = await steamripProvider.search(searchRequest("api-off-host"), {
      ...providerContext("api-off-host"),
      fetch: mixed.fetch,
    });

    assert.deepEqual(
      hits.map((hit) => hit.url),
      [gamePageUrl]
    );
  });

  it("returns no hits for an empty API search without opening the browser", async () => {
    const fake = createFetch(() => fixture("api-empty.json"));
    const provider = loadProviderWithSession(async () => {
      throw new Error("The browser must not open for an empty API result.");
    });
    const hits = await provider.search(searchRequest("api-empty"), {
      ...providerContext("api-empty"),
      fetch: fake.fetch,
    });

    assert.deepEqual(hits, []);
    assert.deepEqual(fake.urls, [
      buildSteamRipApiSearchUrl("ELDEN RING"),
      buildSteamRipApiFullTextUrl("ELDEN RING"),
    ]);
  });

  it("uses one full-text request and fetches content only for matched ids", async () => {
    const fake = createFetch((url) => {
      if (url.includes("search_columns")) {
        return fixture("api-title-miss.json");
      }
      if (url.includes("include=")) {
        return fixture("api-content.json");
      }
      return fixture("api-full-text.json");
    });
    const hits = await steamripProvider.search(searchRequest("api-full-text"), {
      ...providerContext("api-full-text"),
      fetch: fake.fetch,
    });

    assert.equal(fake.urls.length, 3);
    assert.deepEqual(fake.urls[1], buildSteamRipApiFullTextUrl("ELDEN RING"));
    assert.match(fake.urls[2], /include=12806/);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].url, gamePageUrl);

    const links = await steamripProvider.scrape(hits[0], {
      ...providerContext("api-full-text-scrape"),
      fetch: fake.fetch,
    });

    assert.equal(fake.urls.length, 3);
    assert.equal(links.length, 3);
  });

  it("falls back to the browser when the API is blocked", async () => {
    const fake = createSequencedSessionFactory([
      fixture("search.html"),
      fixture("game.html"),
    ]);
    const provider = loadProviderWithSession(fake.open);
    const { entries, logger } = createRecordingLogger();
    const apiCalls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      apiCalls.push(requestUrl(input));
      throw new SourceFetchError(
        "BLOCKED",
        "SteamRip API blocked the request."
      );
    }) as typeof fetch;
    const context = providerContext("api-blocked", logger, fetchImpl);

    const hits = await provider.search(searchRequest("api-blocked"), context);
    const links = await provider.scrape(hits[0], context);

    assert.equal(apiCalls.length, 1);
    assert.equal(hits.length, 1);
    assert.equal(links.length, 3);
    assert.deepEqual(fake.partitions, [
      "persist:hydra-steamrip",
      "persist:hydra-steamrip",
    ]);
    const apiFailure = entries.find(
      (entry) => entry.event.event === "provider.api.failed"
    );
    assert.equal(apiFailure?.level, "warn");
    assert.equal(apiFailure?.event.errorCode, "BLOCKED");
  });

  it("falls back to the browser on a challenge, non-JSON, or drifted API response", async () => {
    const challenge = (async () =>
      new Response(fixture("blocked.html"), {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as typeof fetch;
    const challengeSessions = createSequencedSessionFactory([
      fixture("search.html"),
    ]);
    const challengeProvider = loadProviderWithSession(challengeSessions.open);
    const challengeHits = await challengeProvider.search(
      searchRequest("api-challenge"),
      providerContext("api-challenge", noopLogger, challenge)
    );

    assert.equal(challengeHits.length, 1);
    assert.equal(challengeSessions.partitions.length, 1);

    const drift = createFetch(() => fixture("api-drift.json"));
    const driftSessions = createSequencedSessionFactory([
      fixture("search.html"),
    ]);
    const driftProvider = loadProviderWithSession(driftSessions.open);
    const driftHits = await driftProvider.search(
      searchRequest("api-drift"),
      providerContext("api-drift", noopLogger, drift.fetch)
    );

    assert.equal(drift.urls.length, 1);
    assert.equal(driftSessions.partitions.length, 1);
    assert.equal(driftHits.length, 1);

    const nonJson = createFetch(() => '{"code":"rest_no_route"}');
    const nonJsonSessions = createSequencedSessionFactory([
      fixture("search.html"),
    ]);
    const nonJsonProvider = loadProviderWithSession(nonJsonSessions.open);
    const nonJsonHits = await nonJsonProvider.search(
      searchRequest("api-non-json"),
      providerContext("api-non-json", noopLogger, nonJson.fetch)
    );

    assert.equal(nonJson.urls.length, 1);
    assert.equal(nonJsonSessions.partitions.length, 1);
    assert.equal(nonJsonHits.length, 1);
  });

  it("does not retry a 403 API response before the browser fallback", async () => {
    const fake = createSequencedSessionFactory([fixture("search.html")]);
    const provider = loadProviderWithSession(fake.open);
    let apiCalls = 0;
    const fetchImpl = (async () => {
      apiCalls += 1;

      return new Response("Forbidden", {
        status: 403,
        headers: { "content-type": "text/html" },
      });
    }) as typeof fetch;
    const hits = await provider.search(
      searchRequest("api-403"),
      providerContext("api-403", noopLogger, fetchImpl)
    );

    assert.equal(apiCalls, 1);
    assert.equal(hits.length, 1);
    assert.equal(fake.partitions.length, 1);
  });
});
