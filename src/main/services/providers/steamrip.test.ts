import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Downloader } from "../../../shared/constants.js";
import { getDownloadersForUris } from "../../../shared/downloader-mapping.js";
import { toSyntheticRepack } from "../../../shared/source-repack.js";
import { isSourceFetchError } from "../source-fetch/errors.js";
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

describe("steamrip provider", () => {
  it("matches the requested game and rejects sequels", () => {
    const html = fixture("steamrip-search.html");

    const hits = parseSteamRipSearch(html, "ELDEN RING", searchPageUrl);

    assert.equal(hits.length, 1);
    assert.equal(hits[0].title, "Elden Ring Deluxe Edition");
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

  it("hands the Gofile link to the existing downloader mapping", () => {
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

    assert.deepEqual(getDownloadersForUris(repack.uris), [Downloader.Gofile]);
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
});
