import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type {
  ProviderContext,
  ProviderSearchHit,
  SourceLogger,
  SourceSearchRequest,
} from "@types";
import { Downloader } from "../../../shared/constants.js";
import {
  getDownloadersForUri,
  getDownloadersForUris,
} from "../../../shared/downloader-mapping.js";
import { normalizeUriGroups } from "../../../shared/repack-uri-groups.js";
import { toSyntheticRepack } from "../../../shared/source-repack.js";
import { isSourceFetchError } from "../source-fetch/errors.js";
import {
  buildGameBountySearchUrl,
  gamebountyProvider,
  parseGameBountyPost,
  parseGameBountySearch,
} from "./gamebounty.js";

const fixture = (name: string) =>
  readFileSync(
    new URL(`./__fixtures__/gamebounty/${name}`, import.meta.url),
    "utf8"
  );

const pageUrl = "https://gamebounty.world/elden-ring";

const vikingParts = [
  "https://vikingfile.com/f/AEFf8Qld6Z",
  "https://vikingfile.com/f/Mb0nGnpe7M",
  "https://vikingfile.com/f/hjnJFoaCtt",
];

const fileditchParts = [
  "https://itsfileditchfiles.st/balpha36/b9cf5e9d2b26178d85b8/ELDEN%20RING.part1.rar",
  "https://itsfileditchfiles.st/balpha36/f7e61afef35d766d40fa/ELDEN%20RING.part2.rar",
  "https://itsfileditchfiles.st/balpha36/0f824f501e7fe7994854/ELDEN%20RING.part3.rar",
];

const isParseError = (error: unknown) =>
  isSourceFetchError(error) && error.code === "PARSE";

const noopLogger: SourceLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const searchRequest = (
  requestId: string,
  overrides: Partial<SourceSearchRequest> = {}
): SourceSearchRequest => ({
  requestId,
  shop: "steam",
  objectId: "1245620",
  title: "ELDEN RING",
  steamAppId: 1245620,
  ...overrides,
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

const wrapper = (hosterUrl: string, slug = "elden-ring") =>
  `https://gamebounty.world/api/dl/${slug}/${Buffer.from(hosterUrl).toString(
    "base64"
  )}`;

const postJson = (mirrors: unknown[]) =>
  JSON.stringify({
    success: true,
    data: {
      appid: "1245620",
      version: "Build 1",
      container: {
        success: true,
        data: { sizeHuman: "1 GB", mirrors },
      },
    },
  });

describe("gamebounty provider", () => {
  it("matches the requested game and rejects sequels", () => {
    const hits = parseGameBountySearch(
      fixture("search.json"),
      searchRequest("gamebounty-search")
    );

    assert.equal(hits.length, 1);
    assert.equal(hits[0].title, "ELDEN RING");
    assert.equal(hits[0].url, pageUrl);
    assert.equal(hits[0].build, "25827938");
    assert.equal(hits[0].size, "67.5 GB");
    assert.equal(hits[0].confidence, 1);
    assert.equal(hits[0].steamAppId, 1245620);
  });

  it("rejects the older game with the same name", () => {
    const hits = parseGameBountySearch(
      fixture("search.json"),
      searchRequest("gamebounty-dead-space", {
        objectId: "1693980",
        title: "Dead Space (2023)",
        steamAppId: 1693980,
      })
    );

    assert.deepEqual(
      hits.map((hit) => hit.url),
      ["https://gamebounty.world/dead-space"]
    );
    assert.equal(hits[0].build, "10602756");
    assert.equal(hits[0].size, "34.4 GB");
  });

  it("matches apostrophes and remaster suffixes", () => {
    const hits = parseGameBountySearch(
      fixture("search.json"),
      searchRequest("gamebounty-spider-man", {
        objectId: "1817070",
        title: "Marvel's Spider-Man Remastered",
        steamAppId: 1817070,
      })
    );

    assert.equal(hits.length, 1);
    assert.equal(hits[0].title, "Marvel’s Spider-Man Remastered");
    assert.equal(
      hits[0].url,
      "https://gamebounty.world/marvel-s-spider-man-remastered"
    );
    assert.equal(hits[0].build, "23986256");
    assert.equal(hits[0].size, "69.4 GB");
  });

  it("accepts an exact appid even when the title differs", () => {
    const hits = parseGameBountySearch(
      fixture("search.json"),
      searchRequest("gamebounty-edition", {
        title: "Elden Ring Shadow of the Erdtree Edition",
      })
    );

    assert.deepEqual(
      hits.map((hit) => hit.url),
      [pageUrl]
    );
    assert.equal(hits[0].confidence, 1);
  });

  it("rejects a title match whose appid differs from the request", () => {
    const hits = parseGameBountySearch(
      fixture("search.json"),
      searchRequest("gamebounty-remake-control", {
        objectId: "1693980",
        title: "Dead Space",
        steamAppId: 1693980,
      })
    );

    assert.deepEqual(
      hits.map((hit) => hit.url),
      ["https://gamebounty.world/dead-space"]
    );
    assert.ok(!hits.some((hit) => hit.title.includes("2008")));
  });

  it("skips results without a usable slug", () => {
    const hits = parseGameBountySearch(
      JSON.stringify({
        success: true,
        data: {
          results: [
            { title: "ELDEN RING", slug: "../elden-ring", appid: "1245620" },
            { title: "ELDEN RING", slug: "elden-ring", appid: "1245620" },
          ],
        },
      }),
      searchRequest("gamebounty-slug")
    );

    assert.deepEqual(
      hits.map((hit) => hit.url),
      [pageUrl]
    );
  });

  it("returns no hits for an empty result list", () => {
    assert.deepEqual(
      parseGameBountySearch(
        fixture("search-empty.json"),
        searchRequest("gamebounty-empty")
      ),
      []
    );
  });

  it("returns PARSE for invalid, shapeless, or unreadable results", () => {
    assert.throws(
      () =>
        parseGameBountySearch("<html>", searchRequest("gamebounty-invalid")),
      isParseError
    );
    assert.throws(
      () =>
        parseGameBountySearch(
          JSON.stringify({ success: false, error: { code: "NOT_FOUND" } }),
          searchRequest("gamebounty-shapeless")
        ),
      isParseError
    );
    assert.throws(
      () =>
        parseGameBountySearch(
          JSON.stringify({ success: true, data: { results: {} } }),
          searchRequest("gamebounty-non-list")
        ),
      isParseError
    );
    assert.throws(
      () =>
        parseGameBountySearch(
          JSON.stringify({ success: true, data: { results: [{}] } }),
          searchRequest("gamebounty-unreadable")
        ),
      isParseError
    );
  });

  it("removes the provider wrapper and keeps only supported hosters", () => {
    const page = parseGameBountyPost(
      fixture("post-elden-ring.json"),
      pageUrl,
      1245620
    );

    assert.deepEqual(
      page.links.map((link) => link.hosterId),
      ["vikingfile", "fileditch"]
    );
    assert.equal(page.size, "67.5 GB");
    assert.equal(page.build, "25827938");
    assert.ok(page.links.every((link) => link.kind === "hoster"));
    assert.ok(page.links.every((link) => link.size === "67.5 GB"));
  });

  it("orders filename parts and groups each mirror as one option", () => {
    const page = parseGameBountyPost(
      fixture("post-elden-ring.json"),
      pageUrl,
      1245620
    );
    const [viking, fileditch] = page.links;

    assert.deepEqual(viking.parts, vikingParts);
    assert.equal(viking.url, vikingParts[0]);
    assert.deepEqual(fileditch.parts, fileditchParts);
    assert.equal(fileditch.url, fileditchParts[0]);
  });

  it("drops a post that belongs to another steam app", () => {
    const page = parseGameBountyPost(
      fixture("post-mismatch.json"),
      "https://gamebounty.world/dead-space-2008",
      1693980
    );

    assert.deepEqual(page.links, []);
  });

  it("returns no links for a post without mirrors", () => {
    const page = parseGameBountyPost(
      fixture("post-no-mirrors.json"),
      "https://gamebounty.world/boxroom",
      4335460
    );

    assert.deepEqual(page.links, []);
    assert.equal(page.size, "2.4 GB");
    assert.equal(page.build, "26564418");
  });

  it("returns PARSE when the post shape drifts", () => {
    assert.throws(() => parseGameBountyPost("<html>", pageUrl), isParseError);
    assert.throws(
      () => parseGameBountyPost(JSON.stringify({ data: {} }), pageUrl),
      isParseError
    );
    assert.throws(
      () =>
        parseGameBountyPost(
          JSON.stringify({
            data: {
              container: { data: { mirrors: "all" } },
            },
          }),
          pageUrl
        ),
      isParseError
    );
    assert.throws(
      () => parseGameBountyPost(postJson([{}]), pageUrl),
      isParseError
    );
  });

  it("drops a mirror with an incomplete part set or a foreign link", () => {
    const page = parseGameBountyPost(
      postJson([
        {
          name: "vikingfile.com",
          links: [
            { url: wrapper(vikingParts[0]) },
            {
              url: `https://gamebounty.world.evil.test/api/dl/elden-ring/${Buffer.from(
                vikingParts[1]
              ).toString("base64")}`,
            },
          ],
        },
        {
          name: "gofile.io",
          links: [{ url: wrapper(vikingParts[0]) }],
        },
        {
          name: "fileditchfiles.st",
          links: [
            {
              url: wrapper(
                "https://fileditchfiles.st/beta42/d12/Dead_Space.part2.rar"
              ),
            },
            {
              url: wrapper(
                "https://fileditchfiles.st/beta42/23a/Dead_Space.part1.rar"
              ),
            },
          ],
        },
        {
          name: "rosseta.xyz",
          links: [{ url: wrapper("https://rosseta.xyz/f/abc") }],
        },
      ]),
      pageUrl
    );

    assert.deepEqual(
      page.links.map((link) => link.hosterId),
      ["fileditch"]
    );
    assert.deepEqual(page.links[0].parts, [
      "https://fileditchfiles.st/beta42/23a/Dead_Space.part1.rar",
      "https://fileditchfiles.st/beta42/d12/Dead_Space.part2.rar",
    ]);
  });

  it("keeps a single supported link without a part group", () => {
    const page = parseGameBountyPost(
      postJson([
        {
          name: "vikingfile.com",
          links: [{ url: wrapper(vikingParts[0]) }],
        },
      ]),
      pageUrl
    );

    assert.equal(page.links.length, 1);
    assert.equal(page.links[0].url, vikingParts[0]);
    assert.equal(page.links[0].parts, undefined);
  });

  it("hands supported GameBounty links to the downloader mapping", () => {
    const page = parseGameBountyPost(
      fixture("post-elden-ring.json"),
      pageUrl,
      1245620
    );
    const hit: ProviderSearchHit = {
      providerId: "gamebounty",
      title: "ELDEN RING",
      url: pageUrl,
      confidence: 1,
      build: "25827938",
      size: "67.5 GB",
    };
    const repack = toSyntheticRepack(gamebountyProvider, hit, page.links);
    const normalized = normalizeUriGroups(repack, getDownloadersForUri);

    assert.deepEqual(repack.uriGroups, [vikingParts, fileditchParts]);
    assert.deepEqual(normalized.uris, [vikingParts[0], fileditchParts[0]]);
    assert.deepEqual(getDownloadersForUris(normalized.uris), [
      Downloader.VikingFile,
      Downloader.Fileditch,
    ]);
    assert.equal(repack.fileSize, "67.5 GB");
    assert.equal(repack.build, "25827938");
  });

  it("searches the API and tags hits with the steam appid", async () => {
    const searchUrl = buildGameBountySearchUrl("ELDEN RING");
    const fake = createFetch({ [searchUrl]: fixture("search.json") });
    const request = searchRequest("gamebounty-live-search");
    const hits = await gamebountyProvider.search(request, {
      ...providerContext("gamebounty-live-search"),
      fetch: fake.fetch,
    });

    assert.deepEqual(fake.urls, [searchUrl]);
    assert.match(fake.urls[0], /\/api\/v1\/search\?/);
    assert.match(fake.urls[0], /sort=relevance/);
    assert.match(fake.urls[0], /q=ELDEN\+RING/);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].steamAppId, 1245620);
  });

  it("scrapes the matched post with one request and keeps the page as referer", async () => {
    const postUrl = "https://gamebounty.world/api/v1/posts/elden-ring";
    const fake = createFetch({
      [buildGameBountySearchUrl("ELDEN RING")]: fixture("search.json"),
      [postUrl]: fixture("post-elden-ring.json"),
    });
    const request = searchRequest("gamebounty-scrape");
    const context = {
      ...providerContext("gamebounty-scrape"),
      fetch: fake.fetch,
    };
    const [hit] = await gamebountyProvider.search(request, context);
    const links = await gamebountyProvider.scrape(hit, context);

    assert.deepEqual(fake.urls, [
      buildGameBountySearchUrl("ELDEN RING"),
      postUrl,
    ]);
    assert.equal(links.length, 2);
    assert.ok(links.every((link) => link.referer === pageUrl));
  });

  it("rejects an off-host hit URL without a request", async () => {
    const fake = createFetch({});

    await assert.rejects(
      gamebountyProvider.scrape(
        {
          providerId: "gamebounty",
          title: "ELDEN RING",
          url: "https://gamebounty.world.evil.test/elden-ring",
          confidence: 1,
        },
        { ...providerContext("gamebounty-off-host"), fetch: fake.fetch }
      ),
      (error: unknown) =>
        isSourceFetchError(error) && error.code === "INVALID_INPUT"
    );
    assert.deepEqual(fake.urls, []);
  });

  it("stops on cancellation before requesting", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = createFetch({});

    await assert.rejects(
      gamebountyProvider.search(searchRequest("gamebounty-cancel"), {
        ...providerContext("gamebounty-cancel"),
        signal: controller.signal,
        fetch: fake.fetch,
      }),
      (error: unknown) => error instanceof Error && error.name === "AbortError"
    );
    assert.deepEqual(fake.urls, []);
  });
});
