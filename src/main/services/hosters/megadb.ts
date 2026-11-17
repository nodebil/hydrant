import { setTimeout as sleep } from "node:timers/promises";
import { DownloadError } from "../../../shared/constants.js";
import { logger } from "../logger.js";
import { SOURCE_USER_AGENT } from "../source-fetch/http-client.js";
import { isSourceUrlAllowed } from "../source-fetch/url-policy.js";

const MEGADB_HOSTS = ["megadb.net"];
const MEGADB_FILE_HOST_SUFFIX = ".megadb.xyz";
// The approved referer is recorded per uploaded file; a new posting site needs its origin here.
const MEGADB_REFERERS = [
  "https://steamrip.com/",
  "https://steamgg.net/",
  "https://gamebounty.com/",
];
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 2;

const FINAL_URL_PATTERN = /finalDownloadUrl\s*=\s*['"]([^'"]+)['"]/;
const COUNTDOWN_PATTERN = /var\s+seconds\s*=\s*(\d+)/;
const REFERRER_PATTERN = /Referrer not allowed/i;
const NOT_FOUND_PATTERN =
  /FILE NOT FOUND|no longer available|has been removed/i;

export const isMegaDBHost = (value: string): boolean => {
  try {
    return (
      new URL(value).protocol === "https:" &&
      isSourceUrlAllowed(value, MEGADB_HOSTS)
    );
  } catch {
    return false;
  }
};

export const isMegaDBFileHost = (value: string): boolean => {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    return url.protocol === "https:" && host.endsWith(MEGADB_FILE_HOST_SUFFIX);
  } catch {
    return false;
  }
};

export interface MegaDBPage {
  pt?: string;
  notFound: boolean;
  referrerError: boolean;
  countdownMs: number;
}

export const parseMegaDBPage = (html: string): MegaDBPage => {
  const seconds = Number(html.match(COUNTDOWN_PATTERN)?.[1] ?? "10");
  return {
    pt: html.match(FINAL_URL_PATTERN)?.[1],
    notFound: NOT_FOUND_PATTERN.test(html),
    referrerError: REFERRER_PATTERN.test(html),
    countdownMs: Math.min(Math.max(seconds, 10), 30) * 1000,
  };
};

const unavailableError = () => new Error(DownloadError.HosterUnlockUnavailable);

const fetchWithTimeout = (
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit
) =>
  fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

const resolveWithReferer = async (
  uri: string,
  referer: string,
  fetchImpl: typeof fetch,
  wait: (ms: number) => Promise<unknown>
): Promise<string | null> => {
  const pageResponse = await fetchWithTimeout(fetchImpl, uri, {
    headers: { referer, "user-agent": SOURCE_USER_AGENT },
  });
  const page = parseMegaDBPage(await pageResponse.text());

  // The error page contains both strings; a wrong referer must try the next origin, not report NOT_FOUND.
  if (page.referrerError) return null;
  if (page.notFound) throw new Error(DownloadError.HosterUnlockFileNotFound);
  if (!page.pt) return null;

  const cookie = (pageResponse.headers.getSetCookie?.() ?? [])
    .map((value) => value.split(";")[0])
    .join("; ");
  if (!cookie) return null;

  await wait(page.countdownMs + 2000);

  const ptResponse = await fetchWithTimeout(fetchImpl, page.pt, {
    headers: {
      referer,
      cookie,
      "user-agent": SOURCE_USER_AGENT,
    },
    redirect: "manual",
  });
  const location = ptResponse.headers.get("location");

  if (ptResponse.status >= 300 && ptResponse.status < 400 && location) {
    const url = new URL(location, page.pt).href;
    if (isMegaDBFileHost(url)) return url;
  }

  return null;
};

export const resolveMegaDBLink = async (
  uri: string,
  options: {
    fetchImpl?: typeof fetch;
    wait?: (ms: number) => Promise<unknown>;
  } = {}
): Promise<string> => {
  if (!isMegaDBHost(uri)) throw new Error("Invalid MegaDB URL");

  const fetchImpl = options.fetchImpl ?? fetch;
  const wait = options.wait ?? sleep;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    for (const referer of MEGADB_REFERERS) {
      const url = await resolveWithReferer(uri, referer, fetchImpl, wait);
      if (url) return url;
    }
  }

  logger.error("[MegaDB] No approved referer or download link was found.");
  throw unavailableError();
};

export class MegaDBApi {
  private static pending: Promise<unknown> = Promise.resolve();

  public static async getDownloadUrl(uri: string): Promise<string> {
    // One resolve at a time: each attempt includes a 12 s server-enforced countdown.
    const result = this.pending.then(() => resolveMegaDBLink(uri));
    this.pending = result.catch(() => undefined);
    return result;
  }
}
