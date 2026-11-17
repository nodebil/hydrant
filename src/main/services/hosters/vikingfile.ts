import { DownloadError } from "../../../shared/constants.js";
import { logger } from "../logger.js";
import { attr, parseHtml, text } from "../providers/html.js";
import { HiddenBrowserSession } from "../source-fetch/browser-session.js";
import { isSourceUrlAllowed } from "../source-fetch/url-policy.js";

// vikingfile.com redirects to vik1ngfile.site, so both hosts must pass the redirect guard.
const VIKINGFILE_DOMAINS = ["vikingfile.com", "vik1ngfile.site"];
const VIKINGFILE_PARTITION = "persist:hydra-vikingfile";
const PAGE_TIMEOUT_MS = 45_000;
const DOWNLOAD_LINK_SELECTOR = "a#download-link[href]";
const DOWNLOAD_LINK_ID = "#download-link";
const NOT_FOUND_TITLE = "File not found";
const ERROR_PREFIX = "Error";

const pageReadyScript = `(() => {
  if (document.title === ${JSON.stringify(NOT_FOUND_TITLE)}) return true;
  if (document.querySelector(${JSON.stringify(DOWNLOAD_LINK_SELECTOR)})) return true;
  const link = document.querySelector(${JSON.stringify(DOWNLOAD_LINK_ID)});
  return Boolean(link && (link.textContent || "").trim().startsWith(${JSON.stringify(ERROR_PREFIX)}));
})()`;

const unavailableError = () => new Error(DownloadError.HosterUnlockUnavailable);

export interface VikingFilePage {
  downloadUrl?: string;
  notFound: boolean;
  error: boolean;
}

export const parseVikingFilePage = (
  html: string,
  pageUrl: string
): VikingFilePage => {
  const document = parseHtml(html, pageUrl);

  return {
    downloadUrl: attr(document, DOWNLOAD_LINK_SELECTOR, "href"),
    notFound: document.title.trim() === NOT_FOUND_TITLE,
    error: (text(document, DOWNLOAD_LINK_ID) ?? "").startsWith(ERROR_PREFIX),
  };
};

export const isVikingFileHost = (value: string): boolean => {
  try {
    return (
      new URL(value).protocol === "https:" &&
      isSourceUrlAllowed(value, VIKINGFILE_DOMAINS)
    );
  } catch {
    return false;
  }
};

const resolveDirectLink = async (url: string): Promise<string> => {
  // Electron's default UA matches its client hints; a spoofed Chrome UA makes Turnstile withhold the token.
  const session = await HiddenBrowserSession.open({
    partition: VIKINGFILE_PARTITION,
    timeoutMs: PAGE_TIMEOUT_MS,
    allowedHosts: VIKINGFILE_DOMAINS,
  });

  try {
    logger.log(`[VikingFile] Starting download link extraction for: ${url}`);

    let page: VikingFilePage;
    try {
      await session.navigate(url.split("#")[0]);
      await session.waitForFunction<boolean>(pageReadyScript);
      page = parseVikingFilePage(await session.readHtml(), url);
    } catch (error) {
      logger.error("[VikingFile] Page did not become readable:", error);
      throw unavailableError();
    }

    if (page.notFound) {
      throw new Error(DownloadError.HosterUnlockFileNotFound);
    }
    if (page.error) {
      logger.error("[VikingFile] The page reported an error.");
      throw unavailableError();
    }
    if (!page.downloadUrl || !isVikingFileHost(page.downloadUrl)) {
      logger.error("[VikingFile] Download link is missing or unsafe.");
      throw unavailableError();
    }

    logger.log("[VikingFile] Successfully extracted direct link");
    return page.downloadUrl;
  } finally {
    session.close();
  }
};

export class VikingFileApi {
  private static pending: Promise<unknown> = Promise.resolve();

  public static async getDownloadUrl(uri: string): Promise<string> {
    if (!isVikingFileHost(uri)) {
      throw new Error("Invalid VikingFile URL");
    }

    // One hidden window per link; run them one at a time to bound Electron windows.
    const result = this.pending.then(() => resolveDirectLink(uri));
    this.pending = result.catch(() => undefined);
    return result;
  }
}
