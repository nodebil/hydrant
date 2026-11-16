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
import { isSourceFetchError } from "../source-fetch/errors.js";
import * as sourceLogModule from "../source-fetch/source-log.js";
import type { SourceLogEvent } from "../source-fetch/source-log.js";
import * as urlPolicyModule from "../source-fetch/url-policy.js";
import * as htmlModule from "./html.js";
import {
  parseSteamRipGame,
  parseSteamRipSearch,
  steamripProvider,
} from "./steamrip.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

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

const providerContext = (
  requestId: string,
  logger: SourceLogger = noopLogger
): ProviderContext => ({
  signal: new AbortController().signal,
  fetch: globalThis.fetch,
  logger,
  requestId,
});

describe("steamrip provider", () => {
  it("matches the requested game and rejects sequels", () => {
    const html = fixture("steamrip-search.html");

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
    const html = fixture("steamrip-search.html");

    const hits = parseSteamRipSearch(html, "Dead Space (2023)", searchPageUrl);

    assert.deepEqual(
      hits.map((hit) => hit.url),
      ["https://steamrip.com/dead-space-2023-free-download/"]
    );
  });

  it("matches titles with apostrophes and remaster suffixes", () => {
    const html = fixture("steamrip-search.html");

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
    const page = parseSteamRipGame(
      fixture("steamrip-game.html"),
      gamePageUrl,
      1245620
    );

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

  it("drops a candidate page that belongs to another steam app", () => {
    const page = parseSteamRipGame(
      fixture("steamrip-game.html"),
      gamePageUrl,
      17470
    );

    assert.deepEqual(page.links, []);
  });

  it("hands supported SteamRip links to the downloader mapping", () => {
    const page = parseSteamRipGame(
      fixture("steamrip-game.html"),
      gamePageUrl,
      1245620
    );
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
    const page = parseSteamRipGame(
      fixture("steamrip-game-multipart.html"),
      gamePageUrl
    );

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
        fixture("steamrip-search-empty.html"),
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
          fixture("steamrip-search-drift.html"),
          "ELDEN RING",
          searchPageUrl
        ),
      isParseError
    );
    assert.throws(
      () => parseSteamRipGame(fixture("steamrip-game-drift.html"), gamePageUrl),
      isParseError
    );
  });

  it("classifies empty and challenge pages as BLOCKED", () => {
    assert.throws(
      () =>
        parseSteamRipSearch(
          fixture("steamrip-blocked.html"),
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
    const fake = createSequencedSessionFactory([
      fixture("steamrip-search.html"),
    ]);
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
    const fake = createSequencedSessionFactory([
      fixture("steamrip-search.html"),
    ]);
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
    const fake = createSequencedSessionFactory([
      "",
      fixture("steamrip-search.html"),
    ]);
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
    assert.equal(entries.length, 1);
    assert.equal(entries[0].level, "warn");
    assert.equal(entries[0].event.errorCode, "BLOCKED");
    assert.deepEqual(entries[0].event.details, {
      phase: "search",
      attempt: 1,
      retry: true,
      title: "",
      length: 0,
    });
  });

  it("returns PARSE after one retry when selectors drift and logs the page", async () => {
    const drift = fixture("steamrip-search-drift.html");
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

    assert.deepEqual(fake.partitions, [
      "persist:hydra-steamrip",
      "persist:hydra-steamrip",
    ]);
    assert.deepEqual(
      entries.map((entry) => entry.event.details?.retry),
      [true, false]
    );
    assert.equal(entries[1].event.errorCode, "PARSE");
    assert.match(String(entries[1].event.details?.title), /^You searched for/);
    assert.equal(entries[1].event.details?.length, drift.length);
  });

  it("does not retry a Cloudflare challenge page", async () => {
    const fake = createSequencedSessionFactory([
      fixture("steamrip-blocked.html"),
      fixture("steamrip-search.html"),
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

    assert.equal(fake.partitions.length, 1);
    assert.deepEqual(
      entries.map((entry) => entry.event.details?.retry),
      [false]
    );
  });

  it("classifies a 403 page as BLOCKED without retrying", async () => {
    const fake = createSequencedSessionFactory([
      fixture("steamrip-403.html"),
      fixture("steamrip-search.html"),
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

    assert.equal(fake.partitions.length, 1);
    assert.equal(entries[0].event.errorCode, "BLOCKED");
    assert.equal(entries[0].event.details?.title, "403 Forbidden");
    assert.equal(entries[0].event.details?.retry, false);
  });
});
