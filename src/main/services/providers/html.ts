import { JSDOM } from "jsdom";

type HtmlRoot = Document | Element;

const normalizeWhitespace = (value: string) =>
  value.replace(/\s+/g, " ").trim();

export const parseHtml = (html: string, url?: string): Document =>
  new JSDOM(html, url ? { url } : undefined).window.document;

export const text = (root: HtmlRoot, selector: string): string | undefined => {
  const element = root.querySelector(selector);
  if (!element) return undefined;

  const value = normalizeWhitespace(element.textContent ?? "");
  return value || undefined;
};

export const attr = (
  root: HtmlRoot,
  selector: string,
  name: string
): string | undefined => {
  const value = root.querySelector(selector)?.getAttribute(name)?.trim();
  return value || undefined;
};

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

export const extractSize = (
  value: string | null | undefined
): string | undefined => {
  if (!value) return undefined;

  const match = SIZE_PATTERN.exec(value);
  if (!match) return undefined;

  return `${match[1]} ${match[2].toUpperCase()}`;
};
