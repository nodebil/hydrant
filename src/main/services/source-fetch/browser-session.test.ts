import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import type { SourceErrorCode } from "@types";
import {
  assertHiddenBrowserOptions,
  HiddenBrowserSession,
} from "./browser-session.js";
import { SourceFetchError } from "./errors.js";

type Listener = (...args: unknown[]) => void;

class FakeEmitter {
  private readonly listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  removeListener(event: string, listener: Listener): void {
    const listeners = this.listeners.get(event);
    if (!listeners) return;
    this.listeners.set(
      event,
      listeners.filter((current) => current !== listener)
    );
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

class FakeSession extends FakeEmitter {}

class FakeWebContents extends FakeEmitter {
  readonly session = new FakeSession();
  audioMuted = false;
  windowOpenHandler: ((details: { url: string }) => { action: string }) | null =
    null;
  stopped = false;
  destroyed = false;
  executeJavaScriptImpl: (source: string) => unknown = () => false;
  stopHandler: (() => void) | null = null;

  async executeJavaScript(source: string): Promise<unknown> {
    return this.executeJavaScriptImpl(source);
  }

  setAudioMuted(muted: boolean): void {
    this.audioMuted = muted;
  }

  setWindowOpenHandler(
    handler: (details: { url: string }) => { action: string }
  ): void {
    this.windowOpenHandler = handler;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  stop(): void {
    this.stopped = true;
    this.stopHandler?.();
  }
}

class FakeWindow {
  readonly webContents = new FakeWebContents();
  readonly loadedUrls: string[] = [];
  destroyed = false;
  loadURLImpl: (url: string) => Promise<void> = async () => undefined;

  constructor(readonly options: BrowserWindowConstructorOptions) {}

  async loadURL(url: string): Promise<void> {
    this.loadedUrls.push(url);
    return this.loadURLImpl(url);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
    this.webContents.destroyed = true;
  }
}

const fakeEvent = () => {
  const event = {
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  return event;
};

const openSession = async (
  options: Partial<{
    timeoutMs: number;
    pollIntervalMs: number;
    allowedHosts: string[];
  }> = {}
) => {
  let fakeWindow: FakeWindow | undefined;

  const session = await HiddenBrowserSession.open({
    partition: "test",
    timeoutMs: 100,
    pollIntervalMs: 1,
    windowFactory: (windowOptions) => {
      fakeWindow = new FakeWindow(windowOptions);
      return fakeWindow as unknown as BrowserWindow;
    },
    ...options,
  });

  assert.ok(fakeWindow);
  return { session, window: fakeWindow };
};

const assertRejectsWithCode = async (
  promise: Promise<unknown>,
  code: SourceErrorCode
) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof SourceFetchError);
    assert.equal(error.code, code);
    return true;
  });
};

describe("HiddenBrowserSession", () => {
  it("opens a hidden, sandboxed window and denies unsafe actions", async () => {
    const { session, window } = await openSession({
      allowedHosts: ["fuckingfast.co"],
    });

    try {
      assert.equal(window.options.show, false);
      assert.deepEqual(window.options.webPreferences, {
        partition: "test",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
      });
      assert.equal(window.webContents.audioMuted, true);
      assert.deepEqual(window.webContents.windowOpenHandler?.({ url: "x" }), {
        action: "deny",
      });

      const download = fakeEvent();
      window.webContents.session.emit("will-download", download);
      assert.equal(download.defaultPrevented, true);

      const webview = fakeEvent();
      window.webContents.emit("will-attach-webview", webview);
      assert.equal(webview.defaultPrevented, true);
    } finally {
      session.close();
    }
  });

  it("rejects weakened hidden window security options", () => {
    const secure = {
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    };

    assert.doesNotThrow(() => assertHiddenBrowserOptions(secure));
    assert.throws(
      () =>
        assertHiddenBrowserOptions({
          ...secure,
          webPreferences: { ...secure.webPreferences, sandbox: false },
        }),
      (error: unknown) =>
        error instanceof SourceFetchError && error.code === "INVALID_INPUT"
    );
    assert.throws(
      () => assertHiddenBrowserOptions({ ...secure, show: true }),
      (error: unknown) =>
        error instanceof SourceFetchError && error.code === "INVALID_INPUT"
    );
  });

  it("allows only allowlisted navigation hosts", async () => {
    const { session, window } = await openSession({
      allowedHosts: ["fuckingfast.co"],
    });

    try {
      await session.navigate("https://fuckingfast.co/file");

      const sameHost = fakeEvent();
      window.webContents.emit(
        "will-navigate",
        sameHost,
        "https://fuckingfast.co/next"
      );
      assert.equal(sameHost.defaultPrevented, false);

      const subdomain = fakeEvent();
      window.webContents.emit(
        "will-navigate",
        subdomain,
        "https://cdn.fuckingfast.co/next"
      );
      assert.equal(subdomain.defaultPrevented, false);

      const foreignHost = fakeEvent();
      window.webContents.emit(
        "will-navigate",
        foreignHost,
        "https://example.com/"
      );
      assert.equal(foreignHost.defaultPrevented, true);

      const foreignRedirect = fakeEvent();
      window.webContents.emit(
        "will-redirect",
        foreignRedirect,
        "https://example.com/",
        false,
        true
      );
      assert.equal(foreignRedirect.defaultPrevented, true);

      const frameRedirect = fakeEvent();
      window.webContents.emit(
        "will-redirect",
        frameRedirect,
        "https://example.com/",
        false,
        false
      );
      assert.equal(frameRedirect.defaultPrevented, false);
    } finally {
      session.close();
    }
  });

  it("waits for a selector and evaluates static scripts", async () => {
    const { session, window } = await openSession();
    let calls = 0;

    try {
      window.webContents.executeJavaScriptImpl = (source) => {
        if (source.includes("outerHTML")) return "<html><body>ok</body></html>";
        if (source.includes("Boolean")) return ++calls >= 3;
        return "ready";
      };

      await session.waitForSelector("#ready");
      assert.equal(calls, 3);
      assert.equal(await session.readHtml(), "<html><body>ok</body></html>");
      assert.equal(
        await session.evaluate("document.querySelector('#ready').textContent"),
        "ready"
      );
    } finally {
      session.close();
    }
  });

  it("maps a stopped navigation to TIMEOUT, not NETWORK", async () => {
    const { session, window } = await openSession({ timeoutMs: 20 });

    try {
      let rejectLoad: ((error: Error) => void) | null = null;
      window.loadURLImpl = () =>
        new Promise<void>((_resolve, reject) => {
          rejectLoad = reject;
        });
      window.webContents.stopHandler = () => rejectLoad?.(new Error("stopped"));

      await assertRejectsWithCode(
        session.navigate("http://127.0.0.1/"),
        "TIMEOUT"
      );
      assert.equal(window.webContents.stopped, true);
    } finally {
      session.close();
    }
  });

  it("times out when the page never settles", async () => {
    const { session, window } = await openSession({
      timeoutMs: 40,
      pollIntervalMs: 5,
    });

    try {
      window.webContents.executeJavaScriptImpl = () => false;

      assert.equal(await session.detectCloudflare(), false);
      await assertRejectsWithCode(session.waitForSelector("#ready"), "TIMEOUT");
    } finally {
      session.close();
    }
  });

  it("reports a Cloudflare challenge as BLOCKED", async () => {
    const { session, window } = await openSession({
      timeoutMs: 40,
      pollIntervalMs: 5,
    });

    try {
      window.webContents.executeJavaScriptImpl = (source) =>
        source.includes("challenge-form");

      assert.equal(await session.detectCloudflare(), true);
      await assertRejectsWithCode(session.waitForSelector("#ready"), "BLOCKED");
    } finally {
      session.close();
    }
  });

  it("closes the window once and removes its handlers", async () => {
    const { session, window } = await openSession();

    session.close();
    session.close();

    assert.equal(window.destroyed, true);

    const download = fakeEvent();
    window.webContents.session.emit("will-download", download);
    assert.equal(download.defaultPrevented, false);
  });

  it("rejects non-HTTP URLs and maps page script failures to PARSE", async () => {
    const { session, window } = await openSession();

    try {
      await assertRejectsWithCode(
        session.navigate("ftp://example.com"),
        "INVALID_INPUT"
      );

      window.webContents.executeJavaScriptImpl = () => {
        throw new Error("boom");
      };

      await assertRejectsWithCode(
        session.evaluate("throw new Error()"),
        "PARSE"
      );
    } finally {
      session.close();
    }
  });
});
