import type {
  ProviderContext,
  ProviderDefinition,
  ProviderHosterLink,
  ProviderLink,
  ProviderSearchHit,
  SourceSearchRequest,
} from "@types";
import {
  extractSteamAppId,
  isConfidentMatch,
  scoreTitleMatch,
} from "../../../shared/source-matching.js";
import { HiddenBrowserSession } from "../source-fetch/browser-session.js";
import {
  SourceFetchError,
  isSourceFetchError,
} from "../source-fetch/errors.js";
import {
  getSourceErrorName,
  logSourceEvent,
} from "../source-fetch/source-log.js";
import { isHostAllowed, parseHttpUrl } from "../source-fetch/url-policy.js";
import {
  absoluteUrl,
  attr,
  extractBuild,
  extractSize,
  parseHtml,
  text,
  textOf,
} from "./html.js";

export const STEAMRIP_BASE_URL = "https://steamrip.com";

const STEAMRIP_HOST = new URL(STEAMRIP_BASE_URL).hostname;
// Persistent on purpose: a cold profile per search looks like a new client to the WAF.
const STEAMRIP_PARTITION = "persist:hydra-steamrip";
// The default hydralauncher/... UA gets a plain 403 from SteamRip's WAF.
const CHROME_MAJOR = process.versions.chrome?.split(".")[0] ?? "146";
const STEAMRIP_USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
const PAGE_ATTEMPTS = 2;
const SESSION_TIMEOUT_MS = 45_000;

const BLOCKED_PAGE_TEXT =
  /just a moment|checking your browser|verify you are human|attention required|you have been blocked|403 forbidden|error code: 10\d\d|too many requests/i;

const assertPageReadable = (document: Document): void => {
  const bodyText = (document.body?.textContent ?? "").trim();

  if (!bodyText || BLOCKED_PAGE_TEXT.test(`${document.title}\n${bodyText}`)) {
    throw new SourceFetchError(
      "BLOCKED",
      "SteamRip returned an empty or blocked page."
    );
  }
};

const TITLE_TAG = /<title[^>]*>([\s\S]*?)<\/title>/i;

const describePage = (html: string) => {
  const title = TITLE_TAG.exec(html)?.[1]?.replace(/\s+/g, " ").trim();

  return { title: title?.slice(0, 200) ?? "", length: html.length };
};

const isRetryablePageFailure = (error: unknown, html: string): boolean => {
  if (!isSourceFetchError(error)) return false;
  if (error.code === "PARSE") return true;

  // Empty pages recover in a new window; challenge and WAF pages do not.
  return error.code === "BLOCKED" && !BLOCKED_PAGE_TEXT.test(html);
};

const HOSTERS = [
  { hosterId: "gofile", label: "Gofile", hosts: ["gofile.io"] },
  {
    hosterId: "buzzheavier",
    label: "Buzzheavier",
    hosts: ["buzzheavier.com", "bzzhr.to", "bzzhr.co"],
  },
  {
    hosterId: "fileditch",
    label: "Fileditch",
    hosts: [
      "fileditchfiles.st",
      "itsfileditchfiles.st",
      "fileditchfiles.me",
      "fileditch.com",
    ],
  },
  {
    hosterId: "megadb",
    label: "MegaDB",
    hosts: ["megadb.net"],
  },
] as const;

const FREE_DOWNLOAD_SUFFIX = /\s*free download\b.*$/i;
const STEAMRIP_SUFFIX = /\s*[-–—|:]\s*steamrip\s*$/i;
const PART_FILE_NAME = /^(.*?)\.part(\d+)\.(rar|zip|7z)$/i;

export interface SteamRipGameInfo {
  size?: string;
  build?: string;
  links: ProviderHosterLink[];
}

const cleanTitle = (value: string): string =>
  value.replace(STEAMRIP_SUFFIX, "").replace(FREE_DOWNLOAD_SUFFIX, "").trim();

const findHoster = (hostname: string) =>
  HOSTERS.find((hoster) => isHostAllowed(hostname, hoster.hosts));

const groupParts = (links: ProviderHosterLink[]): ProviderHosterLink[] => {
  const single: ProviderHosterLink[] = [];
  const groups = new Map<
    string,
    { part: number; link: ProviderHosterLink }[]
  >();

  for (const link of links) {
    const fileName = new URL(link.url).pathname.split("/").pop() ?? "";
    const match = PART_FILE_NAME.exec(fileName);

    if (!match) {
      single.push(link);
      continue;
    }

    const key = `${link.hosterId}:${match[1].toLowerCase()}.${match[3].toLowerCase()}`;
    const group = groups.get(key) ?? [];
    group.push({ part: Number(match[2]), link });
    groups.set(key, group);
  }

  const grouped = [...groups.values()].map((group) => {
    const ordered = [...group].sort((a, b) => a.part - b.part);
    const [first] = ordered;

    return {
      ...first.link,
      parts: ordered.map(({ link }) => link.url),
    };
  });

  return [...single, ...grouped];
};

const readDownloadAnchors = (infoList: Element): Element[] => {
  const anchors: Element[] = [];

  for (
    let node = infoList.nextElementSibling;
    node;
    node = node.nextElementSibling
  ) {
    if (/^h[1-6]$/i.test(node.tagName)) break;
    anchors.push(...node.querySelectorAll("a.shortc-button"));
  }

  return anchors;
};

const readInfoList = (
  infoList: Element
): Pick<SteamRipGameInfo, "size" | "build"> => {
  let size: string | undefined;
  let build: string | undefined;

  for (const item of infoList.querySelectorAll("li")) {
    const itemText = textOf(item);
    if (!itemText) continue;

    if (/^game size\b/i.test(itemText)) {
      size = extractSize(itemText);
    } else if (/^version\b/i.test(itemText)) {
      build = extractBuild(itemText);
    }
  }

  return { size, build };
};

const findGameInfoList = (root: Document): Element | undefined => {
  for (const heading of root.querySelectorAll("h4")) {
    if (textOf(heading)?.toUpperCase() === "GAME INFO") {
      return heading.nextElementSibling ?? undefined;
    }
  }

  return undefined;
};

export const parseSteamRipSearch = (
  html: string,
  requestedTitle: string,
  pageUrl: string
): ProviderSearchHit[] => {
  const document = parseHtml(html, pageUrl);
  assertPageReadable(document);
  const cards = document.querySelectorAll("div.slide");

  if (cards.length === 0) {
    if (/nothing found/i.test(text(document, "h1.page-title") ?? "")) return [];
    throw new SourceFetchError(
      "PARSE",
      "SteamRip search results markup changed."
    );
  }

  const hits: ProviderSearchHit[] = [];
  const seen = new Set<string>();
  let parsed = 0;

  for (const card of cards) {
    const href = attr(card, "a.all-over-thumb-link", "href");
    const cardTitle =
      text(card, "h2.thumb-title a") ?? text(card, "a.all-over-thumb-link");
    const url = absoluteUrl(href, pageUrl);

    if (!cardTitle || !url || seen.has(url)) continue;

    seen.add(url);
    parsed += 1;

    const title = cardTitle;
    const matchTitle = cleanTitle(cardTitle);
    if (!isConfidentMatch(requestedTitle, matchTitle)) continue;

    const build = extractBuild(text(card, "span.tagmetafield"));
    const size = extractSize(text(card, "span.game-meta-line"));

    hits.push({
      providerId: "steamrip",
      title,
      url,
      confidence: scoreTitleMatch(requestedTitle, matchTitle),
      ...(build ? { build } : {}),
      ...(size ? { size } : {}),
    });
  }

  if (parsed === 0) {
    throw new SourceFetchError(
      "PARSE",
      "SteamRip search result cards could not be read."
    );
  }

  return hits;
};

export const parseSteamRipGame = (
  html: string,
  pageUrl: string,
  expectedSteamAppId?: number
): SteamRipGameInfo => {
  const document = parseHtml(html, pageUrl);
  assertPageReadable(document);
  const title = text(document, "h1.entry-title");

  if (!title) return { links: [] };

  const article = document.querySelector("article#the-post") ?? document;
  const pageSteamAppId = extractSteamAppId(
    attr(article, 'a[href*="steamdb.info/app/"]', "href")
  );

  if (
    expectedSteamAppId &&
    pageSteamAppId &&
    pageSteamAppId !== expectedSteamAppId
  ) {
    return { links: [] };
  }

  const infoList = findGameInfoList(document);
  if (!infoList) {
    throw new SourceFetchError("PARSE", "SteamRip GAME INFO block is missing.");
  }

  const { size, build } = readInfoList(infoList);
  if (!size) {
    throw new SourceFetchError("PARSE", "SteamRip game size is missing.");
  }

  const links: ProviderHosterLink[] = [];

  for (const anchor of readDownloadAnchors(infoList)) {
    const url = absoluteUrl(anchor.getAttribute("href"), pageUrl);
    const parsed = url ? parseHttpUrl(url) : null;
    const hoster = parsed ? findHoster(parsed.hostname) : undefined;

    if (!url || !hoster) continue;

    links.push({
      kind: "hoster",
      url,
      label: hoster.label,
      hosterId: hoster.hosterId,
      size,
      ...(build ? { build } : {}),
    });
  }

  if (links.length === 0) {
    throw new SourceFetchError("PARSE", "SteamRip download links are missing.");
  }

  return { size, ...(build ? { build } : {}), links: groupParts(links) };
};

const readPage = async (url: string): Promise<string> => {
  const session = await HiddenBrowserSession.open({
    partition: STEAMRIP_PARTITION,
    userAgent: STEAMRIP_USER_AGENT,
    timeoutMs: SESSION_TIMEOUT_MS,
    allowedHosts: [STEAMRIP_HOST],
  });

  try {
    await session.navigate(url);

    if (await session.detectCloudflare()) {
      throw new SourceFetchError(
        "BLOCKED",
        "SteamRip is behind a Cloudflare challenge."
      );
    }

    return await session.readHtml();
  } finally {
    session.close();
  }
};

const readParsedPage = async <T>(
  url: string,
  ctx: ProviderContext,
  phase: "search" | "scrape",
  parse: (html: string) => T
): Promise<T> => {
  for (let attempt = 0; ; attempt += 1) {
    const html = await readPage(url);

    try {
      return parse(html);
    } catch (error) {
      const retry =
        attempt + 1 < PAGE_ATTEMPTS && isRetryablePageFailure(error, html);

      logSourceEvent(
        ctx.logger,
        {
          event: "provider.page.failed",
          providerId: "steamrip",
          technique: "browser",
          host: STEAMRIP_HOST,
          ...(isSourceFetchError(error) ? { errorCode: error.code } : {}),
          errorName: getSourceErrorName(error),
          details: {
            phase,
            attempt: attempt + 1,
            retry,
            ...describePage(html),
          },
        },
        "warn"
      );

      if (!retry) throw error;
    }
  }
};

export const steamripProvider: ProviderDefinition = {
  id: "steamrip",
  name: "SteamRip",
  baseUrl: STEAMRIP_BASE_URL,
  priority: 1,
  enabledByDefault: true,
  requiresBrowser: true,
  timeoutMs: 30_000,
  capabilities: { search: true, scrape: true },
  async search(
    request: SourceSearchRequest,
    ctx: ProviderContext
  ): Promise<ProviderSearchHit[]> {
    ctx.signal.throwIfAborted();

    const pageUrl = new URL(
      `/?s=${encodeURIComponent(request.title)}`,
      STEAMRIP_BASE_URL
    ).toString();
    const hits = await readParsedPage(pageUrl, ctx, "search", (html) =>
      parseSteamRipSearch(html, request.title, pageUrl)
    );

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

    const page = await readParsedPage(hit.url, ctx, "scrape", (html) =>
      parseSteamRipGame(html, hit.url, hit.steamAppId)
    );

    return page.links.map((link) => ({ ...link, referer: hit.url }));
  },
};
