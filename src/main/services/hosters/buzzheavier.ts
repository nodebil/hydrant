import { DownloadError } from "../../../shared/constants.js";
import { logger } from "../logger.js";
import { attr, parseHtml, text } from "../providers/html.js";
import { HiddenBrowserSession } from "../source-fetch/browser-session.js";
import { isSourceUrlAllowed } from "../source-fetch/url-policy.js";

const BUZZHEAVIER_DOMAINS = ["buzzheavier.com", "bzzhr.to", "bzzhr.co"];
const BUZZHEAVIER_PARTITION = "persist:hydra-buzzheavier";
const PAGE_TIMEOUT_MS = 45_000;
const DOWNLOAD_BUTTON_SELECTOR = "a.download-btn[hx-get]";
const NOT_FOUND_SELECTOR = '[hx-get="/notfound/recovery"]';

const pageReadyScript = `Boolean(
  document.querySelector(${JSON.stringify(DOWNLOAD_BUTTON_SELECTOR)}) ||
  document.querySelector(${JSON.stringify(NOT_FOUND_SELECTOR)})
)`;

// The download button answers with the signed file URL in HX-Redirect.
const requestDirectLink = (path: string) => `(async () => {
  const response = await fetch(${JSON.stringify(path)}, {
    method: "GET",
    headers: { "HX-Request": "true" },
  });
  return { status: response.status, redirect: response.headers.get("HX-Redirect") };
})()`;

const unavailableError = () => new Error(DownloadError.HosterUnlockUnavailable);

export interface BuzzheavierPage {
  downloadPath?: string;
  notFound: boolean;
}

export const parseBuzzheavierPage = (
  html: string,
  pageUrl: string
): BuzzheavierPage => {
  const document = parseHtml(html, pageUrl);
  const downloadPath = attr(document, DOWNLOAD_BUTTON_SELECTOR, "hx-get");

  if (downloadPath?.startsWith("/") && !downloadPath.startsWith("//")) {
    return { downloadPath, notFound: false };
  }

  const notFound =
    /^not found$/i.test(document.title.trim()) ||
    Boolean(document.querySelector(NOT_FOUND_SELECTOR)) ||
    /returned to the void/i.test(text(document, "body") ?? "");

  return { notFound };
};

export const isBuzzheavierHost = (value: string): boolean => {
  try {
    return (
      new URL(value).protocol === "https:" &&
      isSourceUrlAllowed(value, BUZZHEAVIER_DOMAINS)
    );
  } catch {
    return false;
  }
};

const resolveDirectLink = async (url: string): Promise<string> => {
  const session = await HiddenBrowserSession.open({
    partition: BUZZHEAVIER_PARTITION,
    timeoutMs: PAGE_TIMEOUT_MS,
    allowedHosts: BUZZHEAVIER_DOMAINS,
  });

  try {
    logger.log(`[Buzzheavier] Starting download link extraction for: ${url}`);

    try {
      await session.navigate(url.split("#")[0]);
      await session.waitForFunction<boolean>(pageReadyScript);
    } catch (error) {
      logger.error("[Buzzheavier] Page did not become readable:", error);
      throw unavailableError();
    }

    let page: BuzzheavierPage;
    try {
      page = parseBuzzheavierPage(await session.readHtml(), url);
    } catch (error) {
      logger.error("[Buzzheavier] Page could not be read:", error);
      throw unavailableError();
    }

    if (page.notFound) {
      throw new Error(DownloadError.HosterUnlockFileNotFound);
    }
    if (!page.downloadPath) {
      logger.error("[Buzzheavier] Download button is missing from the page.");
      throw unavailableError();
    }

    let response: { status: number; redirect: string | null } | null;
    try {
      response = await session.evaluate<{
        status: number;
        redirect: string | null;
      } | null>(requestDirectLink(page.downloadPath));
    } catch (error) {
      logger.error("[Buzzheavier] Download request failed:", error);
      throw unavailableError();
    }

    if (!response?.redirect || !isBuzzheavierHost(response.redirect)) {
      logger.error(
        `[Buzzheavier] Download request returned no usable link (HTTP ${response?.status ?? "unknown"}).`
      );
      throw unavailableError();
    }

    logger.log("[Buzzheavier] Successfully extracted direct link");
    return response.redirect;
  } finally {
    session.close();
  }
};

export class BuzzheavierApi {
  private static pending: Promise<unknown> = Promise.resolve();

  public static async getDownloadUrl(uri: string): Promise<string> {
    if (!isBuzzheavierHost(uri)) {
      throw new Error("Invalid Buzzheavier URL");
    }

    // One hidden window per link; run them one at a time to bound Electron windows.
    const result = this.pending.then(() => resolveDirectLink(uri));
    this.pending = result.catch(() => undefined);
    return result;
  }
}
