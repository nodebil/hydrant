import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type {
  ProviderContext,
  SourceLogger,
  SourceSearchRequest,
} from "@types";
import { Downloader } from "../../../shared/constants.js";
import { getDownloadersForUris } from "../../../shared/downloader-mapping.js";
import { toSyntheticRepack } from "../../../shared/source-repack.js";
import {
  SourceFetchError,
  isSourceFetchError,
} from "../source-fetch/errors.js";
import {
  buildSteamGgFeedUrl,
  buildSteamGgSearchUrl,
  parseSteamGgGame,
  parseSteamGgSearch,
  steamggProvider,
} from "./steamgg.js";

const fixture = (name: string) =>
  readFileSync(
    new URL(`./__fixtures__/steamgg/${name}`, import.meta.url),
    "utf8"
  );

const gamePageUrl = "https://steamgg.net/elden-ring-deluxe-edition-download/";

const steamGgFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>ELDEN RING &#8211; SteamGG</title>
    <item>
      <title>Elden Ring Deluxe Edition Free Download [Tarnished Pack/All DLCs/Build-23850278]</title>
      <link>${gamePageUrl}</link>
    </item>
    <item>
      <title>ELDEN RING NIGHTREIGN Free Download [v1.03.03+All DLCs+Online]</title>
      <link>https://steamgg.net/elden-ring-online/</link>
    </item>
  </channel>
</rss>`;

const isParseError = (error: unknown) =>
  isSourceFetchError(error) && error.code === "PARSE";

const noopLogger: SourceLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
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

const requestUrl = (input: Parameters<typeof fetch>[0]): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

const createFetch = (pages: Record<string, string>) => {
  const urls: string[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = requestUrl(input);
    urls.push(url);
    const body = pages[url];

    if (body === undefined) {
      throw new Error(`Unexpected request: ${url}`);
    }

    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return { fetch: fetchImpl, urls };
};

describe("steamgg provider", () => {
  it("matches the requested game and rejects sequels", () => {
    const hits = parseSteamGgSearch(fixture("search.json"), "ELDEN RING");

    assert.equal(hits.length, 1);
    assert.equal(
      hits[0].title,
      "Elden Ring Deluxe Edition Free Download [Tarnished Pack/All DLCs/Build-23850278]"
    );
    assert.equal(
      hits[0].url,
      "https://steamgg.net/elden-ring-deluxe-edition-download/"
    );
    assert.equal(hits[0].build, "23850278");
    assert.equal(hits[0].size, undefined);
    assert.equal(hits[0].confidence, 1);
    assert.ok(!hits.some((hit) => hit.title.includes("NIGHTREIGN")));
  });

  it("matches both Dead Space posts and keeps the remake build", () => {
    const hits = parseSteamGgSearch(
      fixture("search.json"),
      "Dead Space (2023)"
    );

    assert.deepEqual(
      hits.map((hit) => hit.url),
      [
        "https://steamgg.net/dead-space-remake-free-download/",
        "https://steamgg.net/dead-space-free-download-v1/",
      ]
    );
    assert.equal(hits[0].build, "v1.1.14.17871");
  });

  it("decodes HTML entities and matches apostrophes and remaster suffixes", () => {
    const hits = parseSteamGgSearch(
      fixture("search.json"),
      "Marvel's Spider-Man Remastered"
    );

    assert.equal(hits.length, 1);
    assert.equal(
      hits[0].title,
      "Marvel’s Spider Man Remastered Free Download [Build-23986256]"
    );
    assert.equal(hits[0].build, "23986256");
  });

  it("returns no hits for an empty result list", () => {
    assert.deepEqual(parseSteamGgSearch("[]", "ELDEN RING"), []);
  });

  it("returns PARSE for invalid, non-list, or unreadable results", () => {
    assert.throws(
      () => parseSteamGgSearch("<html>", "ELDEN RING"),
      isParseError
    );
    assert.throws(
      () => parseSteamGgSearch('{"code":"rest_no_route"}', "ELDEN RING"),
      isParseError
    );
    assert.throws(
      () =>
        parseSteamGgSearch(
          JSON.stringify([{ link: "https://steamgg.net/game/" }]),
          "ELDEN RING"
        ),
      isParseError
    );
  });

  it("skips off-host search results", () => {
    const hits = parseSteamGgSearch(
      JSON.stringify([
        {
          link: "https://steamgg.net.evil.test/elden-ring-deluxe-edition-download/",
          title: { rendered: "Elden Ring Deluxe Edition Free Download" },
        },
        {
          link: "https://steamgg.net/elden-ring-deluxe-edition-download/",
          title: { rendered: "Elden Ring Deluxe Edition Free Download" },
        },
      ]),
      "ELDEN RING"
    );

    assert.deepEqual(
      hits.map((hit) => hit.url),
      ["https://steamgg.net/elden-ring-deluxe-edition-download/"]
    );
  });

  it("reads only supported post download buttons", () => {
    const page = parseSteamGgGame(fixture("game.html"), gamePageUrl, 1245620);

    assert.deepEqual(
      page.links.map((link) => link.hosterId),
      ["gofile", "datanodes", "akirabox", "filekeeper"]
    );
    assert.deepEqual(
      page.links.map((link) => link.url),
      [
        "https://gofile.io/d/2Vv1FdiG",
        "https://datanodes.to/8klfc4vk981c",
        "https://akirabox.com/7d5GLZPej3xR/file",
        "https://filekeeper.net/ootrrmoqg8hn/ELDEN_RING_Tarnished_-_SteamGG.NET.zip",
      ]
    );
    assert.ok(page.links.every((link) => link.kind === "hoster"));
    assert.ok(page.links.every((link) => link.size === undefined));
  });

  it("drops update rows from the download set", () => {
    const page = parseSteamGgGame(
      fixture("game-update.html"),
      "https://steamgg.net/cyberpunk-2077-pc-game-latest/",
      1091500
    );

    assert.deepEqual(
      page.links.map((link) => link.hosterId),
      ["gofile", "datanodes", "filekeeper"]
    );
    assert.ok(
      !page.links.some(
        (link) => link.url === "https://datanodes.to/n6wur3vcf474"
      )
    );
  });

  it("drops a candidate page that belongs to another steam app", () => {
    const page = parseSteamGgGame(fixture("game.html"), gamePageUrl, 17470);

    assert.deepEqual(page.links, []);
  });

  it("returns PARSE when the post body or download buttons disappear", () => {
    assert.throws(
      () => parseSteamGgGame(fixture("game-drift.html"), gamePageUrl),
      isParseError
    );
    assert.throws(
      () => parseSteamGgGame(fixture("game-buttons-missing.html"), gamePageUrl),
      isParseError
    );
  });

  it("hands supported SteamGG links to the downloader mapping", () => {
    const page = parseSteamGgGame(fixture("game.html"), gamePageUrl, 1245620);
    const repack = toSyntheticRepack(
      steamggProvider,
      {
        providerId: "steamgg",
        title:
          "Elden Ring Deluxe Edition Free Download [Tarnished Pack/All DLCs/Build-23850278]",
        url: gamePageUrl,
        confidence: 1,
        build: "23850278",
      },
      page.links
    );

    assert.deepEqual(getDownloadersForUris(repack.uris), [
      Downloader.Gofile,
      Downloader.Datanodes,
      Downloader.Akirabox,
      Downloader.FileKeeper,
    ]);
    assert.equal(repack.fileSize, null);
    assert.equal(repack.build, "23850278");
  });

  it("searches the WordPress endpoint and tags hits with the steam appid", async () => {
    const searchUrl = buildSteamGgSearchUrl("ELDEN RING");
    const fake = createFetch({
      [searchUrl]: fixture("search.json"),
    });
    const request = searchRequest("steamgg-search");
    const hits = await steamggProvider.search(request, {
      ...providerContext("steamgg-search"),
      fetch: fake.fetch,
    });

    assert.deepEqual(fake.urls, [searchUrl]);
    assert.match(fake.urls[0], /\/wp-json\/wp\/v2\/posts\?/);
    assert.match(fake.urls[0], /orderby=relevance/);
    assert.match(fake.urls[0], /search=ELDEN\+RING/);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].steamAppId, 1245620);
  });

  it("falls back to the RSS search when the WordPress API fails", async () => {
    const request = searchRequest("steamgg-feed");
    const feedUrl = buildSteamGgFeedUrl(request.title);
    const fake = createFetch({ [feedUrl]: steamGgFeed });
    const hits = await steamggProvider.search(request, {
      ...providerContext("steamgg-feed"),
      fetch: fake.fetch,
    });

    assert.deepEqual(fake.urls, [
      buildSteamGgSearchUrl(request.title),
      feedUrl,
    ]);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].url, gamePageUrl);
    assert.equal(hits[0].build, "23850278");
    assert.equal(hits[0].steamAppId, 1245620);
  });

  it("skips off-host RSS search results", async () => {
    const request = searchRequest("steamgg-feed-off-host");
    const feedUrl = buildSteamGgFeedUrl(request.title);
    const fake = createFetch({
      [feedUrl]: steamGgFeed.replace(
        gamePageUrl,
        "https://steamgg.net.evil.test/game/"
      ),
    });
    const hits = await steamggProvider.search(request, {
      ...providerContext("steamgg-feed-off-host"),
      fetch: fake.fetch,
    });

    assert.deepEqual(hits, []);
  });

  it("keeps the REST error when the RSS fallback also fails", async () => {
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = requestUrl(input);

      if (url.includes("/wp-json/")) {
        throw new SourceFetchError("BLOCKED", "SteamGG blocked the request.");
      }

      return new Response("Not found", {
        status: 404,
        headers: { "content-type": "text/html" },
      });
    }) as typeof fetch;

    await assert.rejects(
      steamggProvider.search(searchRequest("steamgg-feed-missing"), {
        ...providerContext("steamgg-feed-missing"),
        fetch: fetchImpl,
      }),
      (error: unknown) => isSourceFetchError(error) && error.code === "BLOCKED"
    );
  });

  it("stops on cancellation during the RSS fallback", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;

      if (attempts === 1) {
        throw new SourceFetchError("BLOCKED", "SteamGG blocked the request.");
      }

      controller.abort();
      throw new SourceFetchError("CANCELLED", "The request was cancelled.");
    }) as typeof fetch;

    await assert.rejects(
      steamggProvider.search(searchRequest("steamgg-feed-cancel"), {
        ...providerContext("steamgg-feed-cancel"),
        signal: controller.signal,
        fetch: fetchImpl,
      }),
      (error: unknown) =>
        isSourceFetchError(error) && error.code === "CANCELLED"
    );
  });

  it("scrapes the hit page and keeps the provider page as referer", async () => {
    const fake = createFetch({
      [gamePageUrl]: fixture("game.html"),
    });
    const request = {
      providerId: "steamgg" as const,
      title: "Elden Ring Deluxe Edition",
      url: gamePageUrl,
      confidence: 1,
      steamAppId: 1245620,
    };

    const links = await steamggProvider.scrape(request, {
      ...providerContext("steamgg-scrape"),
      fetch: fake.fetch,
    });

    assert.deepEqual(fake.urls, [gamePageUrl]);
    assert.equal(links.length, 4);
    assert.ok(links.every((link) => link.referer === gamePageUrl));
  });
});
