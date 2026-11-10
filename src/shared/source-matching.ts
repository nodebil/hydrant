import { charMap } from "./char-map.js";

const CHAR_MAP_PATTERN = new RegExp(Object.keys(charMap).join("|"), "g");
const COMBINING_MARKS = /[\u0300-\u036f]/g;
const RELEASE_YEAR = /(?:\(|\[)\s*(\d{4})\s*(?:\)|\])/;
const RELEASE_YEAR_GLOBAL = /(?:\(|\[)\s*(\d{4})\s*(?:\)|\])/g;
const EDITION_PHRASE =
  /\b(?:game of the year|goty|day one|collector'?s?)\s+edition\b/gi;
const BUILD = /\b(?:build|version)\s*[-_:]?\s*[\d.]+\b/gi;
const VERSION = /\bv\d+(?:\.\d+)+\b/gi;
const LONG_NUMBER = /^\d{5,}$/;
const NUMBER = /^\d+$/;

const IGNORED_TOKENS = new Set([
  "a",
  "an",
  "the",
  "and",
  "of",
  "edition",
  "deluxe",
  "ultimate",
  "definitive",
  "standard",
  "premium",
  "collector",
  "collectors",
  "goty",
  "enhanced",
  "limited",
  "digital",
  "complete",
  "gold",
  "legendary",
  "anniversary",
  "special",
  "remastered",
  "remaster",
]);

const normalizeText = (value: string) =>
  value
    .normalize("NFC")
    .replace(CHAR_MAP_PATTERN, (match) => charMap[match])
    .normalize("NFD")
    .replace(COMBINING_MARKS, "");

const getReleaseYear = (title: string): number | undefined => {
  const match = RELEASE_YEAR.exec(title);
  return match ? Number(match[1]) : undefined;
};

const tokenizeTitle = (title: string): string[] =>
  normalizeText(
    title
      .replace(RELEASE_YEAR_GLOBAL, " ")
      .replace(EDITION_PHRASE, " ")
      .replace(BUILD, " ")
      .replace(VERSION, " ")
      .replace(/['’]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
  )
    .split(" ")
    .filter(
      (token) => token && !IGNORED_TOKENS.has(token) && !LONG_NUMBER.test(token)
    );

export const normalizeTitle = (title: string): string =>
  tokenizeTitle(title).join(" ");

export const scoreTitleMatch = (
  requestedTitle: string,
  candidateTitle: string
): number => {
  const requestedYear = getReleaseYear(requestedTitle);
  const candidateYear = getReleaseYear(candidateTitle);

  if (
    requestedYear !== undefined &&
    candidateYear !== undefined &&
    requestedYear !== candidateYear
  ) {
    return 0;
  }

  const requested = new Set(tokenizeTitle(requestedTitle));
  const candidate = new Set(tokenizeTitle(candidateTitle));

  if (!requested.size || !candidate.size) return 0;

  const requestedNumbers = new Set(
    [...requested].filter((t) => NUMBER.test(t))
  );
  const candidateNumbers = new Set(
    [...candidate].filter((t) => NUMBER.test(t))
  );

  if (requestedNumbers.size !== candidateNumbers.size) return 0;

  for (const number of requestedNumbers) {
    if (!candidateNumbers.has(number)) return 0;
  }

  let intersection = 0;

  for (const token of requested) {
    if (candidate.has(token)) intersection += 1;
  }

  if (!intersection) return 0;

  return Number(
    ((intersection * intersection) / (requested.size * candidate.size)).toFixed(
      4
    )
  );
};

export const isConfidentMatch = (
  requestedTitle: string,
  candidateTitle: string,
  threshold = 0.8
): boolean => scoreTitleMatch(requestedTitle, candidateTitle) >= threshold;

const STEAM_APP_ID_PATTERNS = [
  /store\.steampowered\.com\/app\/(\d+)/i,
  /steamcommunity\.com\/app\/(\d+)/i,
  /steam:\/\/rungameid\/(\d+)/i,
  /[?&](?:appid|steamAppId)=(\d+)/i,
];

export const extractSteamAppId = (
  value: string | null | undefined
): number | undefined => {
  if (!value) return undefined;

  for (const pattern of STEAM_APP_ID_PATTERNS) {
    const match = pattern.exec(value);
    if (!match) continue;

    const appId = Number(match[1]);
    return Number.isSafeInteger(appId) && appId > 0 ? appId : undefined;
  }

  return undefined;
};
