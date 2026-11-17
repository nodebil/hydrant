import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SourceContext, SourceLogger } from "@types";
import { fetchFeedEntries, parseFeed } from "./access-ladder.js";
import { isSourceFetchError } from "./errors.js";

const feedUrl = "https://steamgg.net/feed/rss/?s=elden+ring";

const noopLogger: SourceLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const context = (response: Response): SourceContext => ({
  signal: new AbortController().signal,
  fetch: (async () => response) as typeof fetch,
  logger: noopLogger,
});

const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>SteamGG</title>
    <item>
      <title>Elden Ring &#8211; Build-23850278</title>
      <link>https://steamgg.net/elden-ring-deluxe-edition-download/</link>
    </item>
    <item>
      <title>Elden Ring</title>
      <link>https://steamgg.net/elden-ring-deluxe-edition-download/</link>
    </item>
    <item>
      <title>Missing link</title>
    </item>
    <item>
      <title>Not a web link</title>
      <link>javascript:alert(1)</link>
    </item>
  </channel>
</rss>`;

const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>SteamGG</title>
  <entry>
    <title>Prison Architect</title>
    <link href="/prison-architect-free-download/"/>
  </entry>
</feed>`;

describe("source access ladder", () => {
  it("reads RSS items, resolves links, and decodes entities", () => {
    assert.deepEqual(parseFeed(rss, feedUrl), [
      {
        title: "Elden Ring – Build-23850278",
        url: "https://steamgg.net/elden-ring-deluxe-edition-download/",
      },
    ]);
  });

  it("reads Atom entries with href links", () => {
    assert.deepEqual(parseFeed(atom, feedUrl), [
      {
        title: "Prison Architect",
        url: "https://steamgg.net/prison-architect-free-download/",
      },
    ]);
  });

  it("returns PARSE for HTML and malformed feeds", () => {
    assert.throws(
      () => parseFeed("<html><body>Just a moment...</body></html>", feedUrl),
      (error: unknown) => isSourceFetchError(error) && error.code === "PARSE"
    );
    assert.throws(
      () => parseFeed("<rss><channel>", feedUrl),
      (error: unknown) => isSourceFetchError(error) && error.code === "PARSE"
    );
  });

  it("returns a typed error for a missing feed", async () => {
    await assert.rejects(
      fetchFeedEntries(
        feedUrl,
        context(
          new Response("Not found", {
            status: 404,
            headers: { "content-type": "text/html" },
          })
        )
      ),
      (error: unknown) =>
        isSourceFetchError(error) &&
        error.code === "NOT_FOUND" &&
        error.status === 404
    );
  });

  it("returns a typed error for a blocked feed", async () => {
    await assert.rejects(
      fetchFeedEntries(feedUrl, context(new Response("", { status: 403 }))),
      (error: unknown) =>
        isSourceFetchError(error) &&
        error.code === "BLOCKED" &&
        error.status === 403
    );
  });

  it("returns feed entries from one successful request", async () => {
    const entries = await fetchFeedEntries(
      feedUrl,
      context(
        new Response(rss, {
          status: 200,
          headers: { "content-type": "application/rss+xml" },
        })
      )
    );

    assert.equal(entries.length, 1);
  });
});
