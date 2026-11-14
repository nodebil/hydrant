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
import { SourceFetchError } from "../source-fetch/errors.js";
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

const PARTITION = "source-steamrip";
const SESSION_TIMEOUT_MS = 45_000;

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
    hosts: ["fileditchfiles.st", "itsfileditchfiles.st", "fileditch.com"],
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

    const title = cleanTitle(cardTitle);
    if (!isConfidentMatch(requestedTitle, title)) continue;

    const build = extractBuild(text(card, "span.tagmetafield"));
    const size = extractSize(text(card, "span.game-meta-line"));

    hits.push({
      providerId: "steamrip",
      title,
      url,
      confidence: scoreTitleMatch(requestedTitle, title),
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
    partition: PARTITION,
    timeoutMs: SESSION_TIMEOUT_MS,
    allowedHosts: [new URL(STEAMRIP_BASE_URL).hostname],
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
    const hits = parseSteamRipSearch(
      await readPage(pageUrl),
      request.title,
      pageUrl
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

    const page = parseSteamRipGame(
      await readPage(hit.url),
      hit.url,
      hit.steamAppId
    );

    return page.links.map((link) => ({ ...link, referer: hit.url }));
  },
};
