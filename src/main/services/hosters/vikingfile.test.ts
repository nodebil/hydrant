import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import ts from "typescript";
import { DownloadError } from "../../../shared/constants.js";
import { SourceFetchError } from "../source-fetch/errors.js";
import * as errorsModule from "../source-fetch/errors.js";
import * as urlPolicyModule from "../source-fetch/url-policy.js";
import * as htmlModule from "../providers/html.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

const pageUrl = "https://vikingfile.com/f/redacted123";
const directUrl =
  "https://vikingfile.com/d/redacted123/Hydrant.Audit.part1.rar";

interface FakeSessionOptions {
  partition: string;
  timeoutMs: number;
  allowedHosts: string[];
}

interface FakeSession {
  navigate(url: string): Promise<void>;
  waitForFunction<T>(_script: string): Promise<T>;
  readHtml(): Promise<string>;
  close(): void;
}

interface FakeSessionState {
  opened: FakeSessionOptions[];
  closed: number;
  navigated: string[];
  waited: string[];
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
    readFileSync(new URL("./vikingfile.ts", import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: "vikingfile.ts",
    }
  );
  const state: FakeSessionState = {
    opened: [],
    closed: 0,
    navigated: [],
    waited: [],
  };
  const stubs: Record<string, unknown> = {
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
    api: exports.VikingFileApi as {
      getDownloadUrl(uri: string): Promise<string>;
    },
    parsePage: exports.parseVikingFilePage as (
      html: string,
      url: string
    ) => { downloadUrl?: string; notFound: boolean; error: boolean },
    isHost: exports.isVikingFileHost as (value: string) => boolean,
  };
};

const createSession = (
  html: string,
  settle: () => Promise<unknown> = async () => true
) => {
  return async (
    options: FakeSessionOptions,
    state: FakeSessionState
  ): Promise<FakeSession> => {
    state.opened.push(options);
    return {
      navigate: async (url) => {
        state.navigated.push(url);
      },
      waitForFunction: async <T>(script: string) => {
        state.waited.push(script);
        return (await settle()) as T;
      },
      readHtml: async () => html,
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

describe("vikingfile hoster", () => {
  const parser = loadHoster(async () => {
    throw new Error("The parser tests must not open a browser session.");
  });

  it("reads the resolved download link from the file page", () => {
    const page = parser.parsePage(fixture("vikingfile-file.html"), pageUrl);

    assert.deepEqual(page, {
      downloadUrl: directUrl,
      notFound: false,
      error: false,
    });
  });

  it("classifies the not-found, waiting, and error pages", () => {
    const notFound = parser.parsePage(
      fixture("vikingfile-not-found.html"),
      pageUrl
    );
    const waiting = parser.parsePage(fixture("vikingfile-drift.html"), pageUrl);
    const failed = parser.parsePage(fixture("vikingfile-error.html"), pageUrl);

    assert.deepEqual(notFound, {
      downloadUrl: undefined,
      notFound: true,
      error: false,
    });
    assert.deepEqual(waiting, {
      downloadUrl: undefined,
      notFound: false,
      error: false,
    });
    assert.deepEqual(failed, {
      downloadUrl: undefined,
      notFound: false,
      error: true,
    });
  });

  it("accepts only VikingFile file hosts over https", () => {
    assert.equal(parser.isHost(pageUrl), true);
    assert.equal(parser.isHost("https://vik1ngfile.site/f/redacted123"), true);
    assert.equal(
      parser.isHost("https://vikingfile.com.evil.test/f/redacted123"),
      false
    );
    assert.equal(parser.isHost("http://vikingfile.com/f/redacted123"), false);
  });

  it("resolves a live page through one hidden window and closes it", async () => {
    const hoster = loadHoster(createSession(fixture("vikingfile-file.html")));

    const url = await hoster.api.getDownloadUrl(`${pageUrl}#fragment`);

    assert.equal(url, directUrl);
    assert.equal(hoster.state.opened.length, 1);
    assert.equal(hoster.state.opened[0].partition, "persist:hydra-vikingfile");
    assert.deepEqual(hoster.state.opened[0].allowedHosts, [
      "vikingfile.com",
      "vik1ngfile.site",
    ]);
    assert.deepEqual(hoster.state.navigated, [pageUrl]);
    assert.match(hoster.state.waited[0], /File not found/);
    assert.match(hoster.state.waited[0], /download-link/);
    assert.equal(hoster.state.closed, 1);
  });

  it("reports a removed file and still closes the window", async () => {
    const hoster = loadHoster(
      createSession(fixture("vikingfile-not-found.html"))
    );

    await rejectsWith(
      hoster.api.getDownloadUrl(pageUrl),
      DownloadError.HosterUnlockFileNotFound
    );
    assert.equal(hoster.state.closed, 1);
  });

  it("reports an unavailable hoster for a waiting, error, or drifted page", async () => {
    for (const html of [
      fixture("vikingfile-drift.html"),
      fixture("vikingfile-error.html"),
    ]) {
      const hoster = loadHoster(createSession(html));
      await rejectsWith(
        hoster.api.getDownloadUrl(pageUrl),
        DownloadError.HosterUnlockUnavailable
      );
      assert.equal(hoster.state.closed, 1);
    }

    const foreign = loadHoster(
      createSession(
        fixture("vikingfile-file.html").replace(
          "https://vikingfile.com/d/redacted123",
          "https://vikingfile.com.evil.test/d/redacted123"
        )
      )
    );
    await rejectsWith(
      foreign.api.getDownloadUrl(pageUrl),
      DownloadError.HosterUnlockUnavailable
    );
    assert.equal(foreign.state.closed, 1);
  });

  it("turns a timeout or blocked page into an unavailable error", async () => {
    for (const code of ["TIMEOUT", "BLOCKED"] as const) {
      const hoster = loadHoster(
        createSession(fixture("vikingfile-file.html"), async () => {
          throw new SourceFetchError(code, "The page did not settle.");
        })
      );
      await rejectsWith(
        hoster.api.getDownloadUrl(pageUrl),
        DownloadError.HosterUnlockUnavailable
      );
      assert.equal(hoster.state.closed, 1);
    }
  });

  it("rejects unsupported URLs before opening a window", async () => {
    const hoster = loadHoster(createSession(fixture("vikingfile-file.html")));

    await assert.rejects(
      hoster.api.getDownloadUrl("https://example.com/f/redacted123"),
      /Invalid VikingFile URL/
    );
    assert.equal(hoster.state.opened.length, 0);
  });
});
