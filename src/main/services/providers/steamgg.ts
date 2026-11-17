import type {
  ProviderContext,
  ProviderDefinition,
  ProviderHosterLink,
  ProviderLink,
  ProviderSearchHit,
  SourceSearchRequest,
} from "@types";
import { getDownloadersForUri } from "../../../shared/downloader-mapping.js";
import {
  extractSteamAppId,
  isConfidentMatch,
  scoreTitleMatch,
} from "../../../shared/source-matching.js";
import { fetchFeedEntries } from "../source-fetch/access-ladder.js";
import { SourceFetchError } from "../source-fetch/errors.js";
import { isHostAllowed, parseHttpUrl } from "../source-fetch/url-policy.js";
import {
  absoluteUrl,
  decodeHtmlText,
  extractBuild,
  parseHtml,
  textOf,
} from "./html.js";

export const STEAMGG_BASE_URL = "https://steamgg.net";

const STEAMGG_HOST = new URL(STEAMGG_BASE_URL).hostname;
const SEARCH_PAGE_SIZE = 100;

const HOSTERS = [
  { hosterId: "gofile", label: "Gofile", hosts: ["gofile.io"] },
  { hosterId: "datanodes", label: "Datanodes", hosts: ["datanodes.to"] },
  {
    hosterId: "akirabox",
    label: "Akirabox",
    hosts: ["akirabox.to", "akirabox.com"],
  },
  { hosterId: "pixeldrain", label: "PixelDrain", hosts: ["pixeldrain.com"] },
  {
    hosterId: "vikingfile",
    label: "VikingFile",
    hosts: ["vikingfile.com", "vik1ngfile.site"],
  },
  { hosterId: "rootz", label: "Rootz", hosts: ["rootz.so"] },
  { hosterId: "filekeeper", label: "FileKeeper", hosts: ["filekeeper.net"] },
  {
    hosterId: "buzzheavier",
    label: "Buzzheavier",
    hosts: ["buzzheavier.com", "bzzhr.to", "bzzhr.co"],
  },
] as const;

const FREE_DOWNLOAD_SUFFIX = /\s*free download\b.*$/i;
const NON_GAME_BUTTON = /^(?:update|language|patch)\b/i;

export interface SteamGgGameInfo {
  links: ProviderHosterLink[];
}

const cleanTitle = (value: string): string =>
  value.replace(FREE_DOWNLOAD_SUFFIX, "").trim();

const findHoster = (hostname: string) =>
  HOSTERS.find((hoster) => isHostAllowed(hostname, hoster.hosts));

export const buildSteamGgSearchUrl = (title: string): string => {
  const url = new URL("/wp-json/wp/v2/posts", STEAMGG_BASE_URL);
  url.search = new URLSearchParams({
    per_page: String(SEARCH_PAGE_SIZE),
    page: "1",
    orderby: "relevance",
    search: title,
    _fields: "id,link,title",
  }).toString();

  return url.toString();
};

export const buildSteamGgFeedUrl = (title: string): string => {
  const url = new URL("/feed/rss/", STEAMGG_BASE_URL);
  url.search = new URLSearchParams({ s: title }).toString();

  return url.toString();
};

const toSteamGgHit = (
  title: string,
  url: string,
  requestedTitle: string
): ProviderSearchHit | undefined => {
  const matchTitle = cleanTitle(title);
  if (!isConfidentMatch(requestedTitle, matchTitle)) return undefined;

  const build = extractBuild(title);

  return {
    providerId: "steamgg",
    title,
    url,
    confidence: scoreTitleMatch(requestedTitle, matchTitle),
    ...(build ? { build } : {}),
  };
};

const readPost = (
  post: unknown
): { title: string; url: string } | undefined => {
  if (!post || typeof post !== "object") return undefined;

  const { link, title } = post as { link?: unknown; title?: unknown };
  const rendered =
    title && typeof title === "object"
      ? (title as { rendered?: unknown }).rendered
      : undefined;

  if (typeof link !== "string" || typeof rendered !== "string") {
    return undefined;
  }

  const parsed = parseHttpUrl(absoluteUrl(link, STEAMGG_BASE_URL) ?? "");
  if (!parsed || !isHostAllowed(parsed.hostname, [STEAMGG_HOST])) {
    return undefined;
  }

  const postTitle = /[&<]/.test(rendered)
    ? decodeHtmlText(rendered)
    : rendered.trim();

  return postTitle ? { title: postTitle, url: parsed.toString() } : undefined;
};

export const parseSteamGgSearch = (
  json: string,
  requestedTitle: string
): ProviderSearchHit[] => {
  let posts: unknown;

  try {
    posts = JSON.parse(json);
  } catch {
    throw new SourceFetchError(
      "PARSE",
      "SteamGG search returned invalid JSON."
    );
  }

  if (!Array.isArray(posts)) {
    throw new SourceFetchError(
      "PARSE",
      "SteamGG search response is not a list."
    );
  }

  const hits: ProviderSearchHit[] = [];
  const seen = new Set<string>();
  let parsed = 0;

  for (const post of posts) {
    const page = readPost(post);
    if (!page || seen.has(page.url)) continue;

    seen.add(page.url);
    parsed += 1;

    const hit = toSteamGgHit(page.title, page.url, requestedTitle);
    if (hit) hits.push(hit);
  }

  if (parsed === 0 && posts.length > 0) {
    throw new SourceFetchError(
      "PARSE",
      "SteamGG search results could not be read."
    );
  }

  return hits;
};

export const parseSteamGgGame = (
  html: string,
  pageUrl: string,
  expectedSteamAppId?: number
): SteamGgGameInfo => {
  const document = parseHtml(html, pageUrl);
  const root = document.querySelector("div.blog-post");

  if (!root) {
    throw new SourceFetchError("PARSE", "SteamGG post body is missing.");
  }

  const pageSteamAppIds = [
    ...root.querySelectorAll('a[href*="store.steampowered.com/app/"]'),
  ].map((anchor) => extractSteamAppId(anchor.getAttribute("href")));

  if (
    expectedSteamAppId &&
    pageSteamAppIds.length > 0 &&
    !pageSteamAppIds.includes(expectedSteamAppId)
  ) {
    return { links: [] };
  }

  const buttons = root.querySelectorAll("a.vc_btn3-color-success");
  if (buttons.length === 0) {
    throw new SourceFetchError(
      "PARSE",
      "SteamGG download buttons are missing."
    );
  }

  const links: ProviderHosterLink[] = [];

  for (const button of buttons) {
    if (NON_GAME_BUTTON.test(textOf(button) ?? "")) continue;

    const url = absoluteUrl(button.getAttribute("href"), pageUrl);
    const parsed = url ? parseHttpUrl(url) : null;
    const hoster = parsed ? findHoster(parsed.hostname) : undefined;

    if (!url || !hoster || getDownloadersForUri(url).length === 0) continue;

    links.push({
      kind: "hoster",
      url,
      label: hoster.label,
      hosterId: hoster.hosterId,
    });
  }

  return { links };
};

export const searchSteamGgFeed = async (
  requestedTitle: string,
  ctx: ProviderContext
): Promise<ProviderSearchHit[]> => {
  const entries = await fetchFeedEntries(
    buildSteamGgFeedUrl(requestedTitle),
    ctx
  );
  const hits: ProviderSearchHit[] = [];

  for (const entry of entries) {
    const parsed = parseHttpUrl(entry.url);
    if (!parsed || !isHostAllowed(parsed.hostname, [STEAMGG_HOST])) continue;

    const hit = toSteamGgHit(entry.title, parsed.toString(), requestedTitle);
    if (hit) hits.push(hit);
  }

  return hits;
};

export const steamggProvider: ProviderDefinition = {
  id: "steamgg",
  name: "SteamGG",
  baseUrl: STEAMGG_BASE_URL,
  priority: 2,
  enabledByDefault: true,
  timeoutMs: 30_000,
  capabilities: { search: true, scrape: true },
  async search(
    request: SourceSearchRequest,
    ctx: ProviderContext
  ): Promise<ProviderSearchHit[]> {
    ctx.signal.throwIfAborted();

    let hits: ProviderSearchHit[];

    try {
      const response = await ctx.fetch(buildSteamGgSearchUrl(request.title), {
        signal: ctx.signal,
      });
      hits = parseSteamGgSearch(await response.text(), request.title);
    } catch (error) {
      if (ctx.signal.aborted) throw error;

      try {
        hits = await searchSteamGgFeed(request.title, ctx);
      } catch (feedError) {
        if (ctx.signal.aborted) throw feedError;
        throw error;
      }
    }

    // Title matching is not enough for same-name remakes; scrape verifies this appid.
    return request.steamAppId
      ? hits.map((hit) => ({ ...hit, steamAppId: request.steamAppId }))
      : hits;
  },
  async scrape(
    hit: ProviderSearchHit,
    ctx: ProviderContext
  ): Promise<ProviderLink[]> {
    ctx.signal.throwIfAborted();

    const response = await ctx.fetch(hit.url, { signal: ctx.signal });
    const page = parseSteamGgGame(
      await response.text(),
      hit.url,
      hit.steamAppId
    );

    return page.links.map((link) => ({ ...link, referer: hit.url }));
  },
};
