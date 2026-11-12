import type {
  ProviderDefinition,
  ProviderLink,
  ProviderSearchHit,
  SourceDownloadSourceId,
  SourceGameRepack,
  SourceRepackId,
} from "@types";

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

const hashSourceUrl = (url: string): string => {
  let hash = FNV_OFFSET_BASIS;

  for (let index = 0; index < url.length; index += 1) {
    hash ^= url.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
};

const uniqueUrls = (values: string[]): string[] => {
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const value of values) {
    const url = value.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }

  return urls;
};

const getMultipartParts = (link: ProviderLink): string[] | undefined => {
  if (link.kind !== "hoster" || !link.parts) return undefined;

  const parts = uniqueUrls(link.parts);
  const url = link.url.trim();
  if (url && !parts.includes(url)) parts.unshift(url);

  return parts.length > 1 ? parts : undefined;
};

const getMultipartKey = (parts: string[]) => parts.join("\n");

const uniqueLinks = (links: ProviderLink[]): ProviderLink[] => {
  const byUrl = new Map<string, ProviderLink>();

  for (const link of links) {
    const url = link.url.trim();
    if (!url || byUrl.has(url)) continue;

    byUrl.set(url, link);
  }

  return [...byUrl.values()];
};

const getLinkSize = (links: ProviderLink[]): string | null => {
  if (links.length === 0) return null;

  const sizes = new Map<string, string>();

  for (const link of links) {
    const size = link.size?.trim();
    if (!size) return null;

    const key = size.replace(/\s+/g, "").toUpperCase();
    if (!sizes.has(key)) sizes.set(key, size);
  }

  return sizes.size === 1 ? [...sizes.values()][0] : null;
};

export const toSyntheticRepack = (
  provider: Pick<ProviderDefinition, "id" | "name">,
  hit: ProviderSearchHit,
  links: ProviderLink[]
): SourceGameRepack => {
  const candidates = uniqueLinks(links);

  const groups = new Map<string, string[]>();
  const groupedUrls = new Set<string>();

  for (const link of candidates) {
    const parts = getMultipartParts(link);
    if (!parts) continue;

    const key = getMultipartKey(parts);
    if (!groups.has(key)) groups.set(key, parts);
    for (const part of parts) groupedUrls.add(part);
  }

  const uriGroups = [...groups.values()];
  const uris: string[] = [];
  const seenUris = new Set<string>();
  const addUri = (url: string) => {
    const trimmed = url.trim();
    if (!trimmed || seenUris.has(trimmed)) return;
    seenUris.add(trimmed);
    uris.push(trimmed);
  };

  // Multipart parts stay in uriGroups; normalizeUriGroups adds each group's first part.
  for (const link of candidates) {
    if (!getMultipartParts(link) && !groupedUrls.has(link.url.trim())) {
      addUri(link.url);
    }
  }

  const title =
    hit.build && !hit.title.includes(hit.build)
      ? `${hit.title} ${hit.build}`
      : hit.title;

  const id: SourceRepackId = `provider:${provider.id}:${hashSourceUrl(
    hit.url.trim()
  )}`;
  const downloadSourceId: SourceDownloadSourceId = `provider:${provider.id}`;

  return {
    id,
    title,
    fileSize: hit.size ?? getLinkSize(candidates),
    uris,
    ...(uriGroups.length > 0 ? { uriGroups } : {}),
    unavailableUris: [],
    uploadDate: hit.uploadDate ?? null,
    downloadSourceId,
    downloadSourceName: provider.name,
    createdAt: new Date().toISOString(),
  };
};
