import type { SourceContext } from "@types";
import { JSDOM } from "jsdom";
import { SourceFetchError } from "./errors.js";
import { statusError } from "./http-client.js";

export interface FeedEntry {
  title: string;
  url: string;
}

const FEED_ITEM_SELECTOR = "item, entry";
const FEED_ROOTS = new Set(["rss", "feed", "rdf:rdf"]);

const parseFeedXml = (xml: string): Document => {
  try {
    const document = new JSDOM(xml, {
      contentType: "text/xml",
    }).window.document;
    const root = document.documentElement?.tagName.toLowerCase() ?? "";

    if (!FEED_ROOTS.has(root) || document.querySelector("parsererror")) {
      throw new Error("Not an RSS or Atom feed.");
    }

    return document;
  } catch (error) {
    throw new SourceFetchError("PARSE", "The provider feed is not readable.", {
      cause: error,
    });
  }
};

export const parseFeed = (xml: string, feedUrl: string): FeedEntry[] => {
  const document = parseFeedXml(xml);
  const entries: FeedEntry[] = [];
  const seen = new Set<string>();

  for (const item of document.querySelectorAll(FEED_ITEM_SELECTOR)) {
    const title = item.querySelector("title")?.textContent?.trim();
    const link = item.querySelector("link");
    const href = (link?.getAttribute("href") ?? link?.textContent)?.trim();

    if (!title || !href) continue;

    let url: URL;
    try {
      url = new URL(href, feedUrl);
    } catch {
      continue;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (seen.has(url.toString())) continue;

    seen.add(url.toString());
    entries.push({ title, url: url.toString() });
  }

  return entries;
};

export const fetchFeedEntries = async (
  feedUrl: string,
  ctx: SourceContext
): Promise<FeedEntry[]> => {
  const response = await ctx.fetch(feedUrl, { signal: ctx.signal });

  if (!response.ok) {
    throw statusError(response.status, null);
  }

  return parseFeed(await response.text(), feedUrl);
};
