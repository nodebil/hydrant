import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  absoluteUrl,
  attr,
  extractBuild,
  extractSize,
  parseHtml,
  stripSiteSuffix,
  text,
} from "./html.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

describe("html helpers", () => {
  it("reads audited SteamRip search cards", () => {
    const pageUrl = "https://steamrip.com/?s=elden+ring";
    const document = parseHtml(fixture("steamrip-search.html"), pageUrl);

    assert.equal(
      attr(document, "a.all-over-thumb-link", "href"),
      "/elden-ring-de-free-download-1gg/"
    );
    assert.equal(
      absoluteUrl(attr(document, "a.all-over-thumb-link", "href"), pageUrl),
      "https://steamrip.com/elden-ring-de-free-download-1gg/"
    );
    assert.equal(
      attr(document, "a.all-over-thumb-link", "title"),
      "Elden Ring Deluxe Edition Free Download"
    );

    const meta = text(document, "h2.the-post-title .game-meta-line");
    assert.equal(meta, "Elden Ring Deluxe Edition Build 25827938 69.1 GB");
    assert.equal(extractBuild(meta), "25827938");
    assert.equal(extractSize(meta), "69.1 GB");
  });

  it("reads the audited SteamRip GAME INFO block and links", () => {
    const document = parseHtml(
      fixture("steamrip-game.html"),
      "https://steamrip.com/elden-ring-de-free-download-1gg/"
    );

    const build = text(document, ".game-info li:nth-child(1)");
    const size = text(document, ".game-info li:nth-child(2)");
    assert.equal(build, "Build: 25827938");
    assert.equal(size, "Size: 69.1 GB");
    assert.equal(extractBuild(build), "25827938");
    assert.equal(extractSize(size), "69.1 GB");

    assert.equal(
      absoluteUrl(
        attr(document, ".download-links a", "href"),
        "https://steamrip.com/elden-ring-de-free-download-1gg/"
      ),
      "https://gofile.io/d/qpvferIa"
    );
  });

  it("reads audited SteamGG search results and strips the site suffix", () => {
    const pageUrl = "https://steamgg.net/?s=elden+ring";
    const document = parseHtml(fixture("steamgg-search.html"), pageUrl);

    const title = text(document, "title");
    assert.equal(title, "ELDEN RING - SteamGG");
    assert.equal(stripSiteSuffix(title!, "SteamGG"), "ELDEN RING");

    const card = text(document, "ul.newsbh > li.newsbh-item h4");
    assert.equal(card, "ELDEN RING Deluxe Edition Build-23850278");
    assert.equal(extractBuild(card), "23850278");
    assert.equal(
      absoluteUrl(attr(document, "li.newsbh-item h4 a", "href"), pageUrl),
      "https://steamgg.net/elden-ring-deluxe-edition-download/"
    );
  });

  it("returns undefined when audited markup is missing", () => {
    const document = parseHtml(
      fixture("missing-values.html"),
      "https://steamrip.com/dead-space-2023-free-download/"
    );

    assert.equal(text(document, "span.tagmetafield"), undefined);
    assert.equal(
      attr(document, "a.all-over-thumb-link", "data-build"),
      undefined
    );
    assert.equal(extractBuild(text(document, "h2.the-post-title")), undefined);
    assert.equal(extractSize(text(document, "h2.the-post-title")), undefined);
    assert.equal(
      absoluteUrl(attr(document, "a.missing", "href"), "https://steamrip.com/"),
      undefined
    );
  });

  it("extracts builds and sizes", () => {
    assert.equal(extractBuild("Build 25827938"), "25827938");
    assert.equal(extractBuild("Build-23850278"), "23850278");
    assert.equal(extractBuild("Version: 1.0.3"), "1.0.3");
    assert.equal(extractBuild("v1.17.2"), "1.17.2");
    assert.equal(extractBuild("Elden Ring"), undefined);
    assert.equal(extractBuild(""), undefined);
    assert.equal(extractBuild(null), undefined);

    assert.equal(extractSize("69.1 GB"), "69.1 GB");
    assert.equal(extractSize("67.5GB"), "67.5 GB");
    assert.equal(extractSize("no size published"), undefined);
    assert.equal(extractSize(""), undefined);
    assert.equal(extractSize(undefined), undefined);
  });

  it("removes only a matching trailing site name", () => {
    assert.equal(
      stripSiteSuffix("ELDEN RING - SteamGG", "SteamGG"),
      "ELDEN RING"
    );
    assert.equal(
      stripSiteSuffix("Elden Ring | steamrip", "SteamRip"),
      "Elden Ring"
    );
    assert.equal(
      stripSiteSuffix("Elden Ring » SteamGG", "SteamGG"),
      "Elden Ring"
    );
    assert.equal(
      stripSiteSuffix("Elden Ring – SteamRip", "SteamRip"),
      "Elden Ring"
    );
    assert.equal(
      stripSiteSuffix("Elden Ring - Deluxe Edition", "SteamGG"),
      "Elden Ring - Deluxe Edition"
    );
    assert.equal(stripSiteSuffix("SteamGG", "SteamGG"), "SteamGG");
    assert.equal(stripSiteSuffix("  Elden   Ring  ", "SteamGG"), "Elden Ring");
  });

  it("keeps only http and https URLs", () => {
    const baseUrl = "https://steamrip.com/?s=elden+ring";

    assert.equal(
      absoluteUrl("/elden-ring-de-free-download-1gg/", baseUrl),
      "https://steamrip.com/elden-ring-de-free-download-1gg/"
    );
    assert.equal(
      absoluteUrl("//gofile.io/d/qpvferIa", baseUrl),
      "https://gofile.io/d/qpvferIa"
    );
    assert.equal(
      absoluteUrl("https://gofile.io/d/qpvferIa", baseUrl),
      "https://gofile.io/d/qpvferIa"
    );
    assert.equal(absoluteUrl("javascript:alert(1)", baseUrl), undefined);
    assert.equal(absoluteUrl("data:text/html,hi", baseUrl), undefined);
    assert.equal(absoluteUrl("", baseUrl), undefined);
    assert.equal(absoluteUrl(null, baseUrl), undefined);
  });

  it("collapses text and attribute values and misses cleanly", () => {
    const document = parseHtml(
      "<div class='card'>  hello\n world </div>" +
        "<a class='card' href=' /next '></a>" +
        "<span class='empty'>   </span>"
    );

    assert.equal(text(document, "div.card"), "hello world");
    assert.equal(attr(document, "a.card", "href"), "/next");
    assert.equal(text(document, ".missing"), undefined);
    assert.equal(text(document, "span.empty"), undefined);
    assert.equal(attr(document, "a.card", "title"), undefined);
  });
});
