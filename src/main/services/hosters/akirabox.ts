import { DownloadError } from "../../../shared/constants.js";
import { logger } from "../logger.js";
import { attr, parseHtml, text } from "../providers/html.js";
import { HiddenBrowserSession } from "../source-fetch/browser-session.js";
import { isSourceUrlAllowed } from "../source-fetch/url-policy.js";

// akirabox.com file pages redirect to akirabox.to, so both hosts must pass the redirect guard.
const AKIRABOX_DOMAINS = ["akirabox.to", "akirabox.com"];
const AKIRABOX_PARTITION = "persist:hydra-akirabox";
const PAGE_TIMEOUT_MS = 45_000;
const DOWNLOAD_LINK_SELECTOR =
  "a#download[href^='https://akirabox.com/download/']";
const NOT_FOUND_MARKER = "This file or page isn";
const NOT_FOUND_PATTERN = /This file or page isn.t available/i;

export const AKIRABOX_REFERER = "https://akirabox.to/";

const pageReadyScript = `(() => {
  if (document.querySelector(${JSON.stringify(DOWNLOAD_LINK_SELECTOR)})) return true;
  return (document.body?.innerText ?? "").includes(${JSON.stringify(NOT_FOUND_MARKER)});
})()`;

const unavailableError = () => new Error(DownloadError.HosterUnlockUnavailable);

export interface AkiraboxPage {
  downloadUrl?: string;
  notFound: boolean;
}

export const parseAkiraboxPage = (
  html: string,
  pageUrl: string
): AkiraboxPage => {
  const document = parseHtml(html, pageUrl);

  return {
    downloadUrl: attr(document, DOWNLOAD_LINK_SELECTOR, "href"),
    notFound: NOT_FOUND_PATTERN.test(text(document, "body") ?? ""),
  };
};

export const isAkiraboxHost = (value: string): boolean => {
  try {
    return (
      new URL(value).protocol === "https:" &&
      isSourceUrlAllowed(value, AKIRABOX_DOMAINS)
    );
  } catch {
    return false;
  }
};

const resolveDirectLink = async (url: string): Promise<string> => {
  // Electron's default UA matches its client hints; a spoofed Chrome UA makes Turnstile withhold the token.
  const session = await HiddenBrowserSession.open({
    partition: AKIRABOX_PARTITION,
    timeoutMs: PAGE_TIMEOUT_MS,
    allowedHosts: AKIRABOX_DOMAINS,
  });

  try {
    logger.log(`[Akirabox] Starting download link extraction for: ${url}`);

    let page: AkiraboxPage;
    try {
      await session.navigate(url.split("#")[0]);
      await session.waitForFunction<boolean>(pageReadyScript);
      page = parseAkiraboxPage(await session.readHtml(), url);
    } catch (error) {
      logger.error("[Akirabox] Page did not become readable:", error);
      throw unavailableError();
    }

    if (page.notFound) {
      throw new Error(DownloadError.HosterUnlockFileNotFound);
    }
    if (!page.downloadUrl || !isAkiraboxHost(page.downloadUrl)) {
      logger.error("[Akirabox] Download link is missing or unsafe.");
      throw unavailableError();
    }

    logger.log("[Akirabox] Successfully extracted direct link");
    return page.downloadUrl;
  } finally {
    session.close();
  }
};

export class AkiraboxApi {
  private static pending: Promise<unknown> = Promise.resolve();

  public static async getDownloadUrl(uri: string): Promise<string> {
    if (!isAkiraboxHost(uri)) {
      throw new Error("Invalid Akirabox URL");
    }

    // One hidden window per link; run them one at a time to bound Electron windows.
    const result = this.pending.then(() => resolveDirectLink(uri));
    this.pending = result.catch(() => undefined);
    return result;
  }
}
