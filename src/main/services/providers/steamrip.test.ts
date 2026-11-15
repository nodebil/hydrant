import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import ts from "typescript";
import type { ProviderContext, SourceSearchRequest } from "@types";
import { Downloader } from "../../../shared/constants.js";
import { getDownloadersForUris } from "../../../shared/downloader-mapping.js";
import * as matchingModule from "../../../shared/source-matching.js";
import { toSyntheticRepack } from "../../../shared/source-repack.js";
import * as errorsModule from "../source-fetch/errors.js";
import { isSourceFetchError } from "../source-fetch/errors.js";
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
    "node:crypto": { createHash },
    "../../../shared/source-matching.js": matchingModule,
    "../source-fetch/browser-session.js": {
      HiddenBrowserSession: { open },
    },
    "../source-fetch/errors.js": errorsModule,
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

const createStaleSessionFactory = (freshHtml: string) => {
  const usedPartitions = new Set<string>();
  const partitions: string[] = [];

  const open = async (options: {
    partition: string;
  }): Promise<FakeBrowserSession> => {
    const stale = usedPartitions.has(options.partition);
    usedPartitions.add(options.partition);
    partitions.push(options.partition);

    return {
      navigate: async () => undefined,
      detectCloudflare: async () => false,
      readHtml: async () => (stale ? "" : freshHtml),
      close: () => undefined,
    };
  };

  return { open, partitions };
};

const searchRequest = (requestId: string): SourceSearchRequest => ({
  requestId,
  shop: "steam",
  objectId: "1245620",
  title: "ELDEN RING",
  steamAppId: 1245620,
});

const providerContext = (requestId: string): ProviderContext => ({
  signal: new AbortController().signal,
  fetch: globalThis.fetch,
  logger: noopLogger,
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

  it("keeps repeated searches in one process on fresh browser sessions", async () => {
    const fake = createStaleSessionFactory(fixture("steamrip-search.html"));
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
    assert.notEqual(fake.partitions[0], fake.partitions[1]);
  });
});
