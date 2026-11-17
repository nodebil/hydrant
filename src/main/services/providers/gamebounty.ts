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
  isConfidentMatch,
  scoreTitleMatch,
} from "../../../shared/source-matching.js";
import { SourceFetchError } from "../source-fetch/errors.js";
import { statusError } from "../source-fetch/http-client.js";
import { isHostAllowed, parseHttpUrl } from "../source-fetch/url-policy.js";
import { absoluteUrl, extractBuild, extractSize } from "./html.js";

export const GAMEBOUNTY_BASE_URL = "https://gamebounty.world";

const GAMEBOUNTY_HOST = new URL(GAMEBOUNTY_BASE_URL).hostname;
const SEARCH_PAGE_SIZE = 100;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;
const PART_FILE_NAME = /\.part(\d+)\.(?:rar|zip|7z)$/i;

const HOSTERS = [
  { hosterId: "gofile", label: "Gofile", hosts: ["gofile.io"] },
  {
    hosterId: "vikingfile",
    label: "VikingFile",
    hosts: ["vikingfile.com", "vik1ngfile.site"],
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
  { hosterId: "pixeldrain", label: "PixelDrain", hosts: ["pixeldrain.com"] },
  { hosterId: "datanodes", label: "Datanodes", hosts: ["datanodes.to"] },
] as const;

type Hoster = (typeof HOSTERS)[number];

export interface GameBountyGameInfo {
  size?: string;
  build?: string;
  links: ProviderHosterLink[];
}

interface GameBountySearchResult {
  title: string;
  slug: string;
  appId?: number;
  version?: string;
  size?: string;
}

const readString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const readRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;

const readAppId = (value: unknown): number | undefined => {
  const text =
    typeof value === "number"
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : "";

  if (!/^\d+$/.test(text)) return undefined;

  const appId = Number(text);
  return Number.isSafeInteger(appId) && appId > 0 ? appId : undefined;
};

const findHoster = (hostname: string): Hoster | undefined =>
  HOSTERS.find((hoster) => isHostAllowed(hostname, hoster.hosts));

export const buildGameBountySearchUrl = (title: string): string => {
  const url = new URL("/api/v1/search", GAMEBOUNTY_BASE_URL);
  url.search = new URLSearchParams({
    q: title,
    page: "1",
    size: String(SEARCH_PAGE_SIZE),
    sort: "relevance",
  }).toString();

  return url.toString();
};

export const buildGameBountyPostUrl = (slug: string): string =>
  new URL(`/api/v1/posts/${slug}`, GAMEBOUNTY_BASE_URL).toString();

const buildGameBountyPageUrl = (slug: string): string =>
  new URL(`/${slug}`, GAMEBOUNTY_BASE_URL).toString();

const readSearchResult = (
  value: unknown
): GameBountySearchResult | undefined => {
  const result = readRecord(value);
  const title = readString(result?.title);
  const slug = readString(result?.slug);

  if (!title || !slug || !SLUG_PATTERN.test(slug)) return undefined;

  const appId = readAppId(result?.appid);
  const version = readString(result?.version);
  const size = extractSize(readString(result?.size_human));

  return {
    title,
    slug,
    ...(appId ? { appId } : {}),
    ...(version ? { version } : {}),
    ...(size ? { size } : {}),
  };
};

const toSearchHit = (
  result: GameBountySearchResult,
  request: SourceSearchRequest
): ProviderSearchHit | undefined => {
  const appIdMatches =
    request.steamAppId !== undefined && result.appId === request.steamAppId;

  if (
    request.steamAppId !== undefined &&
    result.appId !== undefined &&
    !appIdMatches
  ) {
    return undefined;
  }

  if (!appIdMatches && !isConfidentMatch(request.title, result.title)) {
    return undefined;
  }

  const build = result.version ? extractBuild(result.version) : undefined;

  return {
    providerId: "gamebounty",
    title: result.title,
    url: buildGameBountyPageUrl(result.slug),
    confidence: appIdMatches ? 1 : scoreTitleMatch(request.title, result.title),
    ...(build ? { build } : {}),
    ...(result.size ? { size: result.size } : {}),
    ...(request.steamAppId ? { steamAppId: request.steamAppId } : {}),
  };
};

export const parseGameBountySearch = (
  json: string,
  request: SourceSearchRequest
): ProviderSearchHit[] => {
  let payload: unknown;

  try {
    payload = JSON.parse(json);
  } catch {
    throw new SourceFetchError(
      "PARSE",
      "GameBounty search returned invalid JSON."
    );
  }

  const results = readRecord(readRecord(payload)?.data)?.results;

  if (!Array.isArray(results)) {
    throw new SourceFetchError(
      "PARSE",
      "GameBounty search results are missing."
    );
  }

  const hits: ProviderSearchHit[] = [];
  const seen = new Set<string>();
  let parsed = 0;

  for (const value of results) {
    const result = readSearchResult(value);
    if (!result || seen.has(result.slug)) continue;

    seen.add(result.slug);
    parsed += 1;

    const hit = toSearchHit(result, request);
    if (hit) hits.push(hit);
  }

  if (parsed === 0 && results.length > 0) {
    throw new SourceFetchError(
      "PARSE",
      "GameBounty search results could not be read."
    );
  }

  return hits;
};

const decodeHosterUrl = (
  value: unknown,
  pageUrl: string
): string | undefined => {
  const raw = readString(value);
  const wrapper = raw ? parseHttpUrl(absoluteUrl(raw, pageUrl) ?? "") : null;

  if (!wrapper || !isHostAllowed(wrapper.hostname, [GAMEBOUNTY_HOST])) {
    return undefined;
  }

  const segments = wrapper.pathname.split("/").filter(Boolean);

  if (segments.length !== 4 || segments[0] !== "api" || segments[1] !== "dl") {
    return undefined;
  }

  return Buffer.from(segments[3], "base64").toString("utf8") || undefined;
};

const readMirrorLink = (
  value: unknown,
  pageUrl: string,
  hoster: Hoster
): string | undefined => {
  const decoded = decodeHosterUrl(readRecord(value)?.url, pageUrl);
  const url = decoded ? parseHttpUrl(decoded) : null;

  if (
    !url ||
    !isHostAllowed(url.hostname, hoster.hosts) ||
    getDownloadersForUri(url.toString()).length === 0
  ) {
    return undefined;
  }

  return url.toString();
};

const orderMirrorUrls = (urls: string[]): string[] => {
  const parts = urls.map(
    (url) => PART_FILE_NAME.exec(new URL(url).pathname)?.[1]
  );

  if (parts.some((part) => part === undefined)) return urls;

  return urls
    .map((url, index) => ({ url, part: Number(parts[index]) }))
    .sort((a, b) => a.part - b.part)
    .map(({ url }) => url);
};

export const parseGameBountyPost = (
  json: string,
  pageUrl: string,
  expectedSteamAppId?: number
): GameBountyGameInfo => {
  let payload: unknown;

  try {
    payload = JSON.parse(json);
  } catch {
    throw new SourceFetchError(
      "PARSE",
      "GameBounty post returned invalid JSON."
    );
  }

  const post = readRecord(readRecord(payload)?.data);

  if (!post) {
    throw new SourceFetchError("PARSE", "GameBounty post data is missing.");
  }

  const appId = readAppId(post.appid);

  if (expectedSteamAppId && appId && appId !== expectedSteamAppId) {
    return { links: [] };
  }

  const container = readRecord(readRecord(post.container)?.data);

  if (!container) {
    throw new SourceFetchError(
      "PARSE",
      "GameBounty post container is missing."
    );
  }

  const mirrors = container.mirrors;

  if (!Array.isArray(mirrors)) {
    throw new SourceFetchError("PARSE", "GameBounty post mirrors are missing.");
  }

  const size = extractSize(readString(container.sizeHuman));
  const build = extractBuild(readString(post.version));
  const links: ProviderHosterLink[] = [];
  let readable = 0;

  for (const value of mirrors) {
    const mirror = readRecord(value);
    const name = readString(mirror?.name);

    if (!mirror || !name || !Array.isArray(mirror.links)) {
      continue;
    }

    readable += 1;

    const hoster = findHoster(name);
    if (!hoster) continue;

    const urls: string[] = [];
    let complete = true;

    for (const link of mirror.links) {
      const url = readMirrorLink(link, pageUrl, hoster);

      // A partial multipart set cannot be extracted, so one bad link drops the mirror.
      if (!url) {
        complete = false;
        break;
      }

      urls.push(url);
    }

    if (!complete || urls.length === 0) continue;

    const ordered = orderMirrorUrls([...new Set(urls)]);
    const [first] = ordered;

    links.push({
      kind: "hoster",
      url: first,
      label: hoster.label,
      hosterId: hoster.hosterId,
      ...(size ? { size } : {}),
      ...(build ? { build } : {}),
      ...(ordered.length > 1 ? { parts: ordered } : {}),
    });
  }

  if (readable === 0 && mirrors.length > 0) {
    throw new SourceFetchError(
      "PARSE",
      "GameBounty post mirrors could not be read."
    );
  }

  return { ...(size ? { size } : {}), ...(build ? { build } : {}), links };
};

const readHitSlug = (hitUrl: string): string => {
  const url = parseHttpUrl(hitUrl);
  const slug = url?.pathname.split("/").filter(Boolean)[0];

  if (
    !url ||
    !isHostAllowed(url.hostname, [GAMEBOUNTY_HOST]) ||
    !slug ||
    !SLUG_PATTERN.test(slug)
  ) {
    throw new SourceFetchError(
      "INVALID_INPUT",
      "The GameBounty hit is not a provider game page."
    );
  }

  return slug;
};

const readBody = async (url: string, ctx: ProviderContext): Promise<string> => {
  const response = await ctx.fetch(url, { signal: ctx.signal });

  if (!response.ok) throw statusError(response.status, null);

  return response.text();
};

export const gamebountyProvider: ProviderDefinition = {
  id: "gamebounty",
  name: "GameBounty",
  baseUrl: GAMEBOUNTY_BASE_URL,
  priority: 3,
  enabledByDefault: true,
  timeoutMs: 30_000,
  capabilities: { search: true, scrape: true },
  async search(
    request: SourceSearchRequest,
    ctx: ProviderContext
  ): Promise<ProviderSearchHit[]> {
    ctx.signal.throwIfAborted();

    return parseGameBountySearch(
      await readBody(buildGameBountySearchUrl(request.title), ctx),
      request
    );
  },
  async scrape(
    hit: ProviderSearchHit,
    ctx: ProviderContext
  ): Promise<ProviderLink[]> {
    ctx.signal.throwIfAborted();

    const page = parseGameBountyPost(
      await readBody(buildGameBountyPostUrl(readHitSlug(hit.url)), ctx),
      hit.url,
      hit.steamAppId
    );

    return page.links.map((link) => ({ ...link, referer: hit.url }));
  },
};
