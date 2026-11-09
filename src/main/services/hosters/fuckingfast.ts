import axios from "axios";
import { logger } from "@main/services";
import { isMultipartHosterDownloadsEnabled } from "../download/multipart-hoster-feature";
import { HiddenBrowserSession } from "../source-fetch/browser-session";
import { SourceFetchError } from "../source-fetch/errors";

export const HOSTER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0";

export async function extractHosterFilename(
  url: string,
  directUrl?: string
): Promise<string> {
  if (url.includes("#")) {
    const fragment = url.split("#")[1];
    if (fragment && !fragment.startsWith("http")) {
      return fragment;
    }
  }

  if (directUrl) {
    try {
      const response = await axios.head(directUrl, {
        timeout: 10000,
        headers: { "User-Agent": HOSTER_USER_AGENT },
      });

      const contentDisposition = response.headers["content-disposition"];
      if (contentDisposition) {
        const filenameMatch = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(
          contentDisposition
        );
        if (filenameMatch && filenameMatch[1]) {
          return filenameMatch[1].replace(/['"]/g, "");
        }
      }
    } catch {
      // Ignore errors
    }

    const urlPath = new URL(directUrl).pathname;
    const filename = urlPath.split("/").pop()?.split("?")[0];
    if (filename) {
      return filename;
    }
  }

  return "downloaded_file";
}

export function handleHosterError(error: unknown): never {
  if (axios.isAxiosError(error)) {
    if (error.response?.status === 404) {
      throw new Error("File not found");
    }
    if (error.response?.status === 429) {
      throw new Error("Rate limit exceeded. Please try again later.");
    }
    if (error.response?.status === 403) {
      throw new Error("Access denied. File may be private or deleted.");
    }
    throw new Error(`Network error: ${error.response?.status || "Unknown"}`);
  }
  throw error;
}

// ============================================
// FuckingFast API Class
// ============================================
const FUCKINGFAST_PARTITION = "persist:hydra-fuckingfast";
const PAGE_TIMEOUT_MS = 45_000;

type PageState = "ready" | "not-found" | "rate-limited";

// Matching the button's file ID keeps a slow navigation from reading the previous page.
const readPageState = (goPath: string) => `(() => {
  if (document.querySelector('[hx-post="' + ${JSON.stringify(goPath)} + '"]')) return "ready";
  const text = document.body ? document.body.innerText : "";
  if (text.includes("File Not Found Or Deleted")) return "not-found";
  if (/rate limit/i.test(text)) return "rate-limited";
  return null;
})()`;

// The download button posts here; the response names the file link in HX-Redirect.
const requestDownloadLink = (goPath: string) => `(async () => {
  const response = await fetch(${JSON.stringify(goPath)}, {
    method: "POST",
    headers: { "HX-Request": "true", "HX-Current-URL": location.href },
  });
  return { status: response.status, redirect: response.headers.get("HX-Redirect") };
})()`;

/**
 * FuckingFast pages sit behind a Cloudflare check that only a browser passes.
 * A hidden window resolves each link; the file itself downloads without it.
 */
export class FuckingFastApi {
  private static readonly FUCKINGFAST_DOMAINS = [
    "fuckingfast.co",
    "fuckingfast.net",
  ];

  private static pending: Promise<unknown> = Promise.resolve();

  private static isSupportedHost(url: string): boolean {
    try {
      const { protocol, hostname } = new URL(url);
      return (
        protocol === "https:" &&
        this.FUCKINGFAST_DOMAINS.some(
          (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
        )
      );
    } catch {
      return false;
    }
  }

  private static getGoPath(url: string): string {
    const fileId = new URL(url).pathname.split("/").find(Boolean);
    if (!fileId) throw new Error("Invalid FuckingFast URL");
    return `/f/${encodeURIComponent(fileId)}/go`;
  }

  private static async resolveDirectLink(url: string): Promise<string> {
    const goPath = this.getGoPath(url);
    const session = await HiddenBrowserSession.open({
      partition: FUCKINGFAST_PARTITION,
      timeoutMs: PAGE_TIMEOUT_MS,
      allowedHosts: this.FUCKINGFAST_DOMAINS,
    });

    try {
      logger.log(`[FuckingFast] Starting download link extraction for: ${url}`);
      await session.navigate(url.split("#")[0]);

      const state = await session.waitForFunction<PageState>(
        readPageState(goPath)
      );
      if (state === "not-found") throw new Error("File not found or deleted");
      if (state === "rate-limited") {
        throw new Error(
          "Rate limit exceeded. Please wait a few minutes and try again."
        );
      }

      const response = await session.evaluate<{
        status: number;
        redirect: string | null;
      } | null>(requestDownloadLink(goPath));
      if (!response) {
        throw new Error("FuckingFast did not return a download link in time.");
      }
      const { status, redirect } = response;
      if (status === 429) {
        throw new Error(
          "Rate limit exceeded. Please wait a few minutes and try again."
        );
      }
      if (!redirect || !this.isSupportedHost(redirect)) {
        throw new Error(
          `Could not extract download link from page (HTTP ${status})`
        );
      }

      logger.log(`[FuckingFast] Successfully extracted direct link`);
      return redirect;
    } catch (error) {
      logger.error(`[FuckingFast] Error:`, error);
      if (error instanceof SourceFetchError) {
        if (error.code === "BLOCKED") {
          throw new Error(
            "FuckingFast is behind a Cloudflare challenge. Try again later."
          );
        }
        if (error.code === "TIMEOUT") {
          throw new Error("The FuckingFast page did not finish loading.");
        }
      }
      throw error;
    } finally {
      session.close();
    }
  }

  private static readonly LEGACY_DOMAIN = "fuckingfast.co";

  private static readonly LEGACY_DIRECT_LINK_REGEX =
    /window\.open\("(https:\/\/fuckingfast\.co\/dl\/[^"]*)"\)/;

  /** Reads the link from the page HTML, as Hydra did before multi-part hoster downloads. */
  private static async getLegacyDirectLink(url: string): Promise<string> {
    if (!url.toLowerCase().includes(this.LEGACY_DOMAIN)) {
      throw new Error(
        `Unsupported domain. Supported domains: ${this.LEGACY_DOMAIN}`
      );
    }
    try {
      logger.log(`[FuckingFast] Starting download link extraction for: ${url}`);
      const response = await axios.get(url, {
        headers: { "User-Agent": HOSTER_USER_AGENT },
        timeout: 30000,
      });

      const html = response.data;

      if (html.toLowerCase().includes("rate limit")) {
        logger.error(`[FuckingFast] Rate limit detected`);
        throw new Error(
          "Rate limit exceeded. Please wait a few minutes and try again."
        );
      }

      if (html.includes("File Not Found Or Deleted")) {
        logger.error(`[FuckingFast] File not found or deleted`);
        throw new Error("File not found or deleted");
      }

      const match = this.LEGACY_DIRECT_LINK_REGEX.exec(html);
      if (!match || !match[1]) {
        logger.error(`[FuckingFast] Could not extract download link`);
        throw new Error("Could not extract download link from page");
      }

      logger.log(`[FuckingFast] Successfully extracted direct link`);
      return match[1];
    } catch (error) {
      logger.error(`[FuckingFast] Error:`, error);
      handleHosterError(error);
    }
  }

  public static async getDirectLink(url: string): Promise<string> {
    if (!(await isMultipartHosterDownloadsEnabled())) {
      return this.getLegacyDirectLink(url);
    }
    if (!this.isSupportedHost(url)) {
      throw new Error(
        `Unsupported domain. Supported domains: ${this.FUCKINGFAST_DOMAINS.join(", ")}`
      );
    }
    // One hidden window per link; run them one at a time to bound Electron windows.
    const result = this.pending.then(() => this.resolveDirectLink(url));
    this.pending = result.catch(() => undefined);
    return result;
  }

  public static async getFilename(
    url: string,
    directUrl?: string
  ): Promise<string> {
    return extractHosterFilename(url, directUrl);
  }
}
