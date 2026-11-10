import { JSDOM } from "jsdom";

type HtmlRoot = Document | Element;

const normalizeWhitespace = (value: string) =>
  value.replace(/\s+/g, " ").trim();

/** Parses untrusted provider markup without executing scripts or loading resources. */
export const parseHtml = (html: string, url?: string): Document =>
  new JSDOM(html, url ? { url } : undefined).window.document;

/** Collapsed text of the first match, or `undefined` when the selector misses. */
export const text = (root: HtmlRoot, selector: string): string | undefined => {
  const element = root.querySelector(selector);
  if (!element) return undefined;

  const value = normalizeWhitespace(element.textContent ?? "");
  return value || undefined;
};

/** Trimmed attribute of the first match, or `undefined` when it is missing. */
export const attr = (
  root: HtmlRoot,
  selector: string,
  name: string
): string | undefined => {
  const value = root.querySelector(selector)?.getAttribute(name)?.trim();
  return value || undefined;
};

/** Resolves a link against the page URL and keeps only http(s) URLs. */
export const absoluteUrl = (
  value: string | null | undefined,
  baseUrl: string
): string | undefined => {
  if (!value) return undefined;

  try {
    const url = new URL(value, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
};

/** Removes a trailing `- Site`, `| Site`, or `» Site` suffix from a title. */
export const stripSiteSuffix = (title: string, siteName: string): string => {
  const normalized = normalizeWhitespace(title);
  const escapedSiteName = siteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const suffix = new RegExp(`\\s*[-–—|»·:]\\s*${escapedSiteName}\\s*$`, "i");

  return normalized.replace(suffix, "").trim() || normalized;
};

const BUILD_PATTERNS = [
  /\b(?:build|version)\s*[-_:]?\s*(\d[\d.]*)\b/i,
  /\bv(\d+(?:\.\d+)+)\b/i,
];

/** Extracts the identifier from `Build 25827938`, `Build-23850278`, or `v1.17.2`. */
export const extractBuild = (
  value: string | null | undefined
): string | undefined => {
  if (!value) return undefined;

  for (const pattern of BUILD_PATTERNS) {
    const match = pattern.exec(value);
    if (match) return match[1];
  }

  return undefined;
};

const SIZE_PATTERN = /\b(\d+(?:[.,]\d+)?)\s*(KB|MB|GB|TB|PB|B)\b/i;

/** Normalizes `69.1GB` to `69.1 GB`; `parseBytes` accepts the result. */
export const extractSize = (
  value: string | null | undefined
): string | undefined => {
  if (!value) return undefined;

  const match = SIZE_PATTERN.exec(value);
  if (!match) return undefined;

  return `${match[1]} ${match[2].toUpperCase()}`;
};
