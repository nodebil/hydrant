import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import { setTimeout as sleep } from "node:timers/promises";
import { SourceFetchError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const CLOUDFLARE_DETECTION_TIMEOUT_MS = 2_000;

export type BrowserWindowFactory = (
  options: BrowserWindowConstructorOptions
) => BrowserWindow | Promise<BrowserWindow>;

export interface HiddenBrowserSessionOptions {
  partition: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  allowedHosts?: string[];
  windowFactory?: BrowserWindowFactory;
}

const CLOUDFLARE_CHALLENGE_PROBE = `(() => {
  const title = document.title || "";
  const text = document.body ? (document.body.innerText || "").slice(0, 2000) : "";
  const hasChallengeElement = Boolean(document.querySelector(
    "#challenge-form, #cf-challenge-running, #cf-please-wait, .cf-browser-verification, [data-translate='checking_browser']"
  ));
  return hasChallengeElement || /just a moment|checking your browser|verify you are human|attention required/i.test(title + "\\n" + text);
})()`;

const HTML_PROBE = `document.documentElement ? document.documentElement.outerHTML : ""`;

const selectorProbe = (selector: string) => `(() => {
  try {
    return Boolean(document.querySelector(${JSON.stringify(selector)}));
  } catch {
    return false;
  }
})()`;

const toHttpUrl = (value: string): URL | null => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
};

const timeoutError = () =>
  new SourceFetchError(
    "TIMEOUT",
    "The hidden browser page did not settle in time."
  );

const blockedError = () =>
  new SourceFetchError(
    "BLOCKED",
    "The hidden browser page is behind a Cloudflare challenge."
  );

const closedError = () =>
  new SourceFetchError("NETWORK", "The hidden browser window is closed.");

const TIMEOUT = Symbol("timeout");

const withDeadline = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void
): Promise<T> => {
  const timer = new AbortController();
  let timedOut = false;

  try {
    const result = await Promise.race<unknown>([
      promise.catch((error) => {
        // The timeout must win when stopping the page rejects the pending call.
        if (timedOut) return TIMEOUT;
        throw error;
      }),
      sleep(Math.max(0, timeoutMs), undefined, { signal: timer.signal }).then(
        () => {
          timedOut = true;
          return TIMEOUT;
        }
      ),
    ]);

    if (result === TIMEOUT) {
      onTimeout();
      throw timeoutError();
    }

    return result as T;
  } finally {
    timer.abort();
  }
};

const createBrowserWindow = async (
  options: BrowserWindowConstructorOptions
): Promise<BrowserWindow> => {
  const { BrowserWindow } = await import("electron");
  return new BrowserWindow(options);
};

export class HiddenBrowserSession {
  private readonly deadline: number;
  private readonly pollIntervalMs: number;
  private readonly allowedHosts: Set<string>;
  private closed = false;

  private constructor(
    private readonly window: BrowserWindow,
    options: HiddenBrowserSessionOptions
  ) {
    this.deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.pollIntervalMs = Math.max(
      1,
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    );
    this.allowedHosts = new Set(
      (options.allowedHosts ?? []).map((host) => host.toLowerCase())
    );
  }

  static async open(
    options: HiddenBrowserSessionOptions
  ): Promise<HiddenBrowserSession> {
    if (!options.partition.trim()) {
      throw new SourceFetchError(
        "INVALID_INPUT",
        "The hidden browser partition is required."
      );
    }

    const window = await (options.windowFactory ?? createBrowserWindow)({
      show: false,
      webPreferences: {
        partition: options.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });

    const session = new HiddenBrowserSession(window, options);
    try {
      session.harden();
      return session;
    } catch (error) {
      session.close();
      throw error;
    }
  }

  async navigate(url: string): Promise<void> {
    this.throwIfClosed();

    const parsed = toHttpUrl(url);
    if (!parsed) {
      throw new SourceFetchError(
        "INVALID_INPUT",
        "The hidden browser URL must use HTTP or HTTPS."
      );
    }

    this.allowedHosts.add(parsed.hostname.toLowerCase());

    try {
      await withDeadline(
        this.window.loadURL(parsed.href).then(() => undefined),
        this.remainingMs(),
        () => this.stopLoading()
      );
    } catch (error) {
      if (error instanceof SourceFetchError) throw error;
      throw new SourceFetchError(
        "NETWORK",
        "The hidden browser page failed to load.",
        { cause: error }
      );
    }
  }

  async waitForSelector(selector: string): Promise<void> {
    if (!selector.trim()) {
      throw new SourceFetchError(
        "INVALID_INPUT",
        "The hidden browser selector is empty."
      );
    }
    await this.waitForFunction<boolean>(selectorProbe(selector));
  }

  async waitForFunction<T>(script: string): Promise<T> {
    if (!script.trim()) {
      throw new SourceFetchError(
        "INVALID_INPUT",
        "The hidden browser wait script is empty."
      );
    }

    while (!this.closed && !this.window.isDestroyed()) {
      try {
        const value = await this.executeWithTimeout<T>(
          script,
          this.remainingMs()
        );
        if (value) return value;
      } catch (error) {
        if (error instanceof SourceFetchError && error.code === "TIMEOUT") {
          break;
        }
        if (!(error instanceof SourceFetchError) || error.code !== "PARSE") {
          throw error;
        }
      }

      if (this.remainingMs() <= 0) break;
      await sleep(Math.min(this.pollIntervalMs, this.remainingMs()));
    }

    if (this.closed || this.window.isDestroyed()) throw closedError();
    if (await this.detectCloudflare()) throw blockedError();
    throw timeoutError();
  }

  async evaluate<T>(script: string): Promise<T> {
    this.throwIfClosed();
    return this.executeWithTimeout<T>(script, this.remainingMs());
  }

  async readHtml(): Promise<string> {
    const html = await this.evaluate<string>(HTML_PROBE);
    return typeof html === "string" ? html : "";
  }

  async detectCloudflare(): Promise<boolean> {
    if (this.closed || this.window.isDestroyed()) return false;
    try {
      return Boolean(
        await this.executeWithTimeout<boolean>(
          CLOUDFLARE_CHALLENGE_PROBE,
          CLOUDFLARE_DETECTION_TIMEOUT_MS
        )
      );
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    // Electron throws when reading webContents from an already-destroyed window.
    if (this.window.isDestroyed()) return;

    const contents = this.window.webContents;
    if (!contents.isDestroyed()) {
      contents.removeListener("will-navigate", this.onWillNavigate);
      contents.removeListener("will-redirect", this.onWillRedirect);
      contents.removeListener("will-attach-webview", this.onWillAttachWebview);
    }

    try {
      contents.session.removeListener("will-download", this.onWillDownload);
    } catch {
      // The session can already be gone during shutdown.
    }

    if (!this.window.isDestroyed()) this.window.destroy();
  }

  private harden(): void {
    const contents = this.window.webContents;

    contents.setAudioMuted(true);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", this.onWillNavigate);
    contents.on("will-redirect", this.onWillRedirect);
    contents.on("will-attach-webview", this.onWillAttachWebview);
    contents.session.on("will-download", this.onWillDownload);
  }

  private readonly onWillNavigate = (
    event: Electron.Event,
    url: string
  ): void => {
    if (!this.isAllowedUrl(url)) event.preventDefault();
  };

  private readonly onWillRedirect = (
    event: Electron.Event,
    url: string,
    _isInPlace: boolean,
    isMainFrame: boolean
  ): void => {
    if (isMainFrame && !this.isAllowedUrl(url)) event.preventDefault();
  };

  private readonly onWillAttachWebview = (event: Electron.Event): void => {
    event.preventDefault();
  };

  private readonly onWillDownload = (event: Electron.Event): void => {
    event.preventDefault();
  };

  private isAllowedUrl(value: string): boolean {
    const url = toHttpUrl(value);
    if (!url || this.allowedHosts.size === 0) return false;

    const host = url.hostname.toLowerCase();
    for (const allowed of this.allowedHosts) {
      if (host === allowed || host.endsWith(`.${allowed}`)) return true;
    }
    return false;
  }

  private remainingMs(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  private stopLoading(): void {
    try {
      this.window.webContents.stop();
    } catch {
      // The window may have been destroyed by the caller.
    }
  }

  private throwIfClosed(): void {
    if (this.closed || this.window.isDestroyed()) throw closedError();
  }

  private async executeWithTimeout<T>(
    script: string,
    timeoutMs: number
  ): Promise<T> {
    try {
      const pending = this.window.webContents.executeJavaScript(
        script
      ) as Promise<T>;
      return await withDeadline(pending, timeoutMs, () => this.stopLoading());
    } catch (error) {
      if (error instanceof SourceFetchError) throw error;
      throw new SourceFetchError(
        "PARSE",
        "The hidden browser page script failed.",
        { cause: error }
      );
    }
  }
}
