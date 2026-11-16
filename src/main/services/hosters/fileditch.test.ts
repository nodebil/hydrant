import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { describe, it } from "node:test";
import ts from "typescript";
import { DownloadError } from "../../../shared/constants.js";
import { SourceFetchError } from "../source-fetch/errors.js";
import * as errorsModule from "../source-fetch/errors.js";
import * as urlPolicyModule from "../source-fetch/url-policy.js";
import * as htmlModule from "../providers/html.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

const pageUrl =
  "https://fileditchfiles.st/balpha8/91a5fd8370b5ab6a24b6/Hydrant.Audit.part1.rar";
const directUrl =
  "https://signed.fileditch.test/MTc5NDc4ODMzMTpyZWRhY3RlZA/Hydrant.Audit.part1.rar";

interface FakeSessionOptions {
  partition: string;
  timeoutMs: number;
  allowedHosts: string[];
}

interface FakeSession {
  readonly lastBlockedRedirect: string | null;
  navigate(url: string, referer?: string): Promise<void>;
  waitForFunction<T>(_script: string): Promise<T>;
  readHtml(): Promise<string>;
  evaluate<T>(_script: string): Promise<T>;
  close(): void;
}

interface FakeSessionState {
  opened: FakeSessionOptions[];
  closed: number;
  evaluated: string[];
  navigated: string[];
  referers: Array<string | undefined>;
}

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  log: () => undefined,
};

const loadHoster = (
  createSession: (
    options: FakeSessionOptions,
    state: FakeSessionState
  ) => Promise<FakeSession>
) => {
  const { outputText } = ts.transpileModule(
    readFileSync(new URL("./fileditch.ts", import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: "fileditch.ts",
    }
  );
  const state: FakeSessionState = {
    opened: [],
    closed: 0,
    evaluated: [],
    navigated: [],
    referers: [],
  };
  const stubs: Record<string, unknown> = {
    "node:net": { isIP },
    "../../../shared/constants.js": { DownloadError },
    "../logger.js": { logger: noopLogger },
    "../providers/html.js": htmlModule,
    "../source-fetch/browser-session.js": {
      HiddenBrowserSession: {
        open: (options: FakeSessionOptions) => createSession(options, state),
      },
    },
    "../source-fetch/errors.js": errorsModule,
    "../source-fetch/url-policy.js": urlPolicyModule,
  };
  const exports: Record<string, unknown> = {};
  new Function("exports", "require", outputText)(exports, (name: string) => {
    const stub = stubs[name];
    if (!stub) throw new Error(`Unexpected import: ${name}`);
    return stub;
  });

  return {
    state,
    api: exports.FileditchApi as {
      getDownloadUrl(uri: string): Promise<string>;
    },
    parsePage: exports.parseFileditchPage as (
      html: string,
      url: string
    ) => { hasDownloadLink: boolean; notFound: boolean },
    isHost: exports.isFileditchHost as (value: string) => boolean,
  };
};

const createSession = (html: string, response: string | null = directUrl) => {
  return async (
    options: FakeSessionOptions,
    state: FakeSessionState
  ): Promise<FakeSession> => {
    state.opened.push(options);
    return {
      lastBlockedRedirect: null,
      navigate: async (url, referer) => {
        state.navigated.push(url);
        state.referers.push(referer);
      },
      waitForFunction: async <T>() => true as T,
      readHtml: async () => html,
      evaluate: async <T>(script: string) => {
        state.evaluated.push(script);
        return response as T;
      },
      close: () => {
        state.closed += 1;
      },
    };
  };
};

const rejectsWith = async (promise: Promise<unknown>, message: string) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, message);
    return true;
  });
};

describe("fileditch hoster", () => {
  const parser = loadHoster(async () => {
    throw new Error("The parser tests must not open a browser session.");
  });

  it("reads the download control from the live file page", () => {
    const page = parser.parsePage(fixture("fileditch-file.html"), pageUrl);

    assert.deepEqual(page, { hasDownloadLink: true, notFound: false });
  });

  it("recognizes the unavailable page and a drifted page", () => {
    const notFound = parser.parsePage(
      fixture("fileditch-not-found.html"),
      pageUrl
    );
    const drifted = parser.parsePage(fixture("fileditch-drift.html"), pageUrl);

    assert.deepEqual(notFound, { hasDownloadLink: false, notFound: true });
    assert.deepEqual(drifted, { hasDownloadLink: false, notFound: false });
  });

  it("accepts only Fileditch file hosts", () => {
    assert.equal(parser.isHost(pageUrl), true);
    assert.equal(
      parser.isHost("https://itsfileditchfiles.st/a/b/Hydrant.Audit.rar"),
      true
    );
    assert.equal(
      parser.isHost("https://fileditchfiles.me/a/b/Hydrant.Audit.rar"),
      true
    );
    assert.equal(
      parser.isHost("https://fileditchfiles.st.evil.test/a/b/file.rar"),
      false
    );
    assert.equal(parser.isHost("https://fileditch.com/a/b/file.rar"), false);
    assert.equal(parser.isHost("http://fileditchfiles.st/a/b/file.rar"), false);
  });

  it("resolves a live page through one hidden window and closes it", async () => {
    const hoster = loadHoster(createSession(fixture("fileditch-file.html")));

    const url = await hoster.api.getDownloadUrl(`${pageUrl}#fragment`);

    assert.equal(url, directUrl);
    assert.equal(hoster.state.opened.length, 1);
    assert.equal(hoster.state.opened[0].partition, "persist:hydra-fileditch");
    assert.deepEqual(hoster.state.opened[0].allowedHosts, [
      "fileditchfiles.st",
      "itsfileditchfiles.st",
      "fileditchfiles.me",
    ]);
    assert.deepEqual(hoster.state.navigated, [pageUrl]);
    assert.deepEqual(hoster.state.referers, [undefined]);
    assert.match(hoster.state.evaluated[0], /pointerenter/);
    assert.match(hoster.state.evaluated[0], /a\[download\]/);
    assert.equal(hoster.state.closed, 1);
  });

  it("reports a removed file and still closes the window", async () => {
    const hoster = loadHoster(
      createSession(fixture("fileditch-not-found.html"))
    );

    await rejectsWith(
      hoster.api.getDownloadUrl(pageUrl),
      DownloadError.HosterUnlockFileNotFound
    );
    assert.equal(hoster.state.evaluated.length, 0);
    assert.equal(hoster.state.closed, 1);
  });

  it("reports an unavailable hoster when the control is gone or the link is unusable", async () => {
    const drifted = loadHoster(createSession(fixture("fileditch-drift.html")));
    await rejectsWith(
      drifted.api.getDownloadUrl(pageUrl),
      DownloadError.HosterUnlockUnavailable
    );

    for (const response of [
      null,
      "http://signed.example.test/d/file.rar",
      "https://203.0.113.10/d/file.rar",
      "https://[::1]/d/file.rar",
      "https://intranet.local/d/file.rar",
      "https://user:secret@signed.example.test/d/file.rar",
    ]) {
      const hoster = loadHoster(
        createSession(fixture("fileditch-file.html"), response)
      );
      await rejectsWith(
        hoster.api.getDownloadUrl(pageUrl),
        DownloadError.HosterUnlockUnavailable
      );
      assert.equal(hoster.state.closed, 1);
    }
  });

  it("retries with the uploader referer after a blocked redirect", async () => {
    const hoster = loadHoster(async (options, state) => {
      state.opened.push(options);
      let attempts = 0;
      const session = {
        lastBlockedRedirect: null as string | null,
        navigate: async (url: string, referer?: string) => {
          state.navigated.push(url);
          state.referers.push(referer);
          attempts += 1;

          if (attempts === 1) {
            session.lastBlockedRedirect = "https://steamrip.com/";
            throw new SourceFetchError("NETWORK", "The redirect was blocked.");
          }
        },
        waitForFunction: async <T>() => true as T,
        readHtml: async () => fixture("fileditch-file.html"),
        evaluate: async <T>() => directUrl as T,
        close: () => {
          state.closed += 1;
        },
      };
      return session;
    });

    const url = await hoster.api.getDownloadUrl(pageUrl);

    assert.equal(url, directUrl);
    assert.deepEqual(hoster.state.navigated, [pageUrl, pageUrl]);
    assert.deepEqual(hoster.state.referers, [
      undefined,
      "https://steamrip.com",
    ]);
    assert.equal(hoster.state.closed, 1);
  });

  it("turns a blocked navigation into an unavailable error", async () => {
    const hoster = loadHoster(async (options, state) => {
      state.opened.push(options);
      return {
        lastBlockedRedirect: null,
        navigate: async () => {
          throw new SourceFetchError("NETWORK", "The redirect was blocked.");
        },
        waitForFunction: async <T>() => true as T,
        readHtml: async () => "",
        evaluate: async <T>() => null as T,
        close: () => {
          state.closed += 1;
        },
      };
    });

    await rejectsWith(
      hoster.api.getDownloadUrl(pageUrl),
      DownloadError.HosterUnlockUnavailable
    );
    assert.equal(hoster.state.closed, 1);
  });

  it("turns a failed direct-link request into an unavailable error", async () => {
    const hoster = loadHoster(async (options, state) => {
      state.opened.push(options);
      return {
        lastBlockedRedirect: null,
        navigate: async () => undefined,
        waitForFunction: async <T>() => true as T,
        readHtml: async () => fixture("fileditch-file.html"),
        evaluate: async () => {
          throw new SourceFetchError("TIMEOUT", "The page did not answer.");
        },
        close: () => {
          state.closed += 1;
        },
      };
    });

    await rejectsWith(
      hoster.api.getDownloadUrl(pageUrl),
      DownloadError.HosterUnlockUnavailable
    );
    assert.equal(hoster.state.closed, 1);
  });

  it("rejects unsupported URLs before opening a window", async () => {
    const hoster = loadHoster(createSession(fixture("fileditch-file.html")));

    await assert.rejects(
      hoster.api.getDownloadUrl("https://fileditch.com/file.rar"),
      /Invalid Fileditch URL/
    );
    assert.equal(hoster.state.opened.length, 0);
  });
});
