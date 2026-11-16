import { isIP } from "node:net";
import { DownloadError } from "../../../shared/constants.js";
import { logger } from "../logger.js";
import { parseHtml } from "../providers/html.js";
import { HiddenBrowserSession } from "../source-fetch/browser-session.js";
import { isSourceUrlAllowed } from "../source-fetch/url-policy.js";

const FILEDITCH_DOMAINS = [
  "fileditchfiles.st",
  "itsfileditchfiles.st",
  "fileditchfiles.me",
];
const FILEDITCH_PARTITION = "persist:hydra-fileditch";
const PAGE_TIMEOUT_MS = 45_000;
const DOWNLOAD_LINK_SELECTOR = "div.controls a[download]";
const NOT_FOUND_SELECTOR = "div.gone";

const pageReadyScript = `Boolean(
  document.querySelector(${JSON.stringify(DOWNLOAD_LINK_SELECTOR)}) ||
  document.querySelector(${JSON.stringify(NOT_FOUND_SELECTOR)})
)`;

// The page script requests the signed file URL on first hover and stores it in href.
const requestDirectLinkScript = `(async () => {
  const link = document.querySelector(${JSON.stringify(DOWNLOAD_LINK_SELECTOR)});
  if (!link) return null;
  link.dispatchEvent(new PointerEvent("pointerenter"));
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const href = link.getAttribute("href");
    if (href) return href;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
})()`;

const unavailableError = () => new Error(DownloadError.HosterUnlockUnavailable);

// Fileditch serves the file from a rotating signed host, so only the URL shape is checked.
const isDirectDownloadUrl = (value: string): boolean => {
  try {
    const { protocol, hostname, username, password } = new URL(value);
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

    return (
      protocol === "https:" &&
      !username &&
      !password &&
      isIP(host) === 0 &&
      host !== "localhost" &&
      !host.endsWith(".local")
    );
  } catch {
    return false;
  }
};

const getBlockedRedirectReferer = (
  session: HiddenBrowserSession
): string | null => {
  if (!session.lastBlockedRedirect) return null;

  try {
    const { protocol, origin } = new URL(session.lastBlockedRedirect);
    return protocol === "https:" ? origin : null;
  } catch {
    return null;
  }
};

const navigateToPage = async (
  session: HiddenBrowserSession,
  url: string
): Promise<void> => {
  try {
    await session.navigate(url);
  } catch (error) {
    // Hotlink-protected uploads answer with a redirect to the posting site.
    const referer = getBlockedRedirectReferer(session);
    if (!referer) throw error;

    logger.log(`[Fileditch] Retrying with the uploader referer: ${referer}`);
    await session.navigate(url, referer);
  }
};

export interface FileditchPage {
  hasDownloadLink: boolean;
  notFound: boolean;
}

export const parseFileditchPage = (
  html: string,
  pageUrl: string
): FileditchPage => {
  const document = parseHtml(html, pageUrl);

  return {
    hasDownloadLink: Boolean(document.querySelector(DOWNLOAD_LINK_SELECTOR)),
    notFound: Boolean(document.querySelector(NOT_FOUND_SELECTOR)),
  };
};

export const isFileditchHost = (value: string): boolean => {
  try {
    return (
      new URL(value).protocol === "https:" &&
      isSourceUrlAllowed(value, FILEDITCH_DOMAINS)
    );
  } catch {
    return false;
  }
};

const resolveDirectLink = async (url: string): Promise<string> => {
  const session = await HiddenBrowserSession.open({
    partition: FILEDITCH_PARTITION,
    timeoutMs: PAGE_TIMEOUT_MS,
    allowedHosts: FILEDITCH_DOMAINS,
  });

  try {
    logger.log(`[Fileditch] Starting download link extraction for: ${url}`);

    try {
      await navigateToPage(session, url.split("#")[0]);
      await session.waitForFunction<boolean>(pageReadyScript);
    } catch (error) {
      logger.error("[Fileditch] Page did not become readable:", error);
      throw unavailableError();
    }

    let page: FileditchPage;
    try {
      page = parseFileditchPage(await session.readHtml(), url);
    } catch (error) {
      logger.error("[Fileditch] Page could not be read:", error);
      throw unavailableError();
    }

    if (page.notFound) {
      throw new Error(DownloadError.HosterUnlockFileNotFound);
    }
    if (!page.hasDownloadLink) {
      logger.error("[Fileditch] Download control is missing from the page.");
      throw unavailableError();
    }

    let directLink: string | null;
    try {
      directLink = await session.evaluate<string | null>(
        requestDirectLinkScript
      );
    } catch (error) {
      logger.error("[Fileditch] Download request failed:", error);
      throw unavailableError();
    }

    if (!directLink || !isDirectDownloadUrl(directLink)) {
      logger.error(
        "[Fileditch] Download request returned no usable direct link."
      );
      throw unavailableError();
    }

    logger.log("[Fileditch] Successfully extracted direct link");
    return directLink;
  } finally {
    session.close();
  }
};

export class FileditchApi {
  private static pending: Promise<unknown> = Promise.resolve();

  public static async getDownloadUrl(uri: string): Promise<string> {
    if (!isFileditchHost(uri)) {
      throw new Error("Invalid Fileditch URL");
    }

    // One hidden window per link; run them one at a time to bound Electron windows.
    const result = this.pending.then(() => resolveDirectLink(uri));
    this.pending = result.catch(() => undefined);
    return result;
  }
}
