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

const pageUrl = "https://buzzheavier.com/redacted123";
const directUrl = "https://ts.buzzheavier.com/d/redacted123?v=redacted";

interface FakeSessionOptions {
  partition: string;
  timeoutMs: number;
  allowedHosts: string[];
}

interface FakeSession {
  navigate(url: string): Promise<void>;
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
    readFileSync(new URL("./buzzheavier.ts", import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: "buzzheavier.ts",
    }
  );
  const state: FakeSessionState = {
    opened: [],
    closed: 0,
    evaluated: [],
    navigated: [],
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
    api: exports.BuzzheavierApi as {
      getDownloadUrl(uri: string): Promise<string>;
    },
    parsePage: exports.parseBuzzheavierPage as (
      html: string,
      url: string
    ) => { downloadPath?: string; notFound: boolean },
    isDirectLink: exports.isBuzzheavierHost as (value: string) => boolean,
  };
};

const createSession = (
  html: string,
  response: { status: number; redirect: string | null } = {
    status: 204,
    redirect: directUrl,
  }
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

describe("buzzheavier hoster", () => {
  const parser = loadHoster(async () => {
    throw new Error("The parser tests must not open a browser session.");
  });

  it("reads the signed download path from the live file page", () => {
    const page = parser.parsePage(fixture("buzzheavier-file.html"), pageUrl);

    assert.equal(page.notFound, false);
    assert.equal(
      page.downloadPath,
      "/redacted123/download?t=MTc5NDcwMTU5NjgzMg.redacted"
    );
  });

  it("recognizes the not-found page and a drifted page", () => {
    const notFound = parser.parsePage(
      fixture("buzzheavier-not-found.html"),
      pageUrl
    );
    const drifted = parser.parsePage(
      fixture("buzzheavier-drift.html"),
      pageUrl
    );

    assert.deepEqual(notFound, { notFound: true });
    assert.deepEqual(drifted, { notFound: false });
  });

  it("accepts only Buzzheavier direct hosts", () => {
    assert.equal(parser.isDirectLink(directUrl), true);
    assert.equal(
      parser.isDirectLink("https://ts.bzzhr.co/d/redacted123?v=redacted"),
      true
    );
    assert.equal(
      parser.isDirectLink("https://buzzheavier.com.evil.test/file"),
      false
    );
    assert.equal(parser.isDirectLink("http://ts.buzzheavier.com/d/x"), false);
  });

  it("resolves a live page through one hidden window and closes it", async () => {
    const hoster = loadHoster(createSession(fixture("buzzheavier-file.html")));

    const url = await hoster.api.getDownloadUrl(pageUrl);

    assert.equal(url, directUrl);
    assert.equal(hoster.state.opened.length, 1);
    assert.equal(hoster.state.opened[0].partition, "persist:hydra-buzzheavier");
    assert.deepEqual(hoster.state.opened[0].allowedHosts, [
      "buzzheavier.com",
      "bzzhr.to",
      "bzzhr.co",
    ]);
    assert.deepEqual(hoster.state.navigated, [pageUrl]);
    assert.match(hoster.state.evaluated[0], /"HX-Request": "true"/);
    assert.match(hoster.state.evaluated[0], /\/redacted123\/download\?t=/);
    assert.equal(hoster.state.closed, 1);
  });

  it("reports a removed file and still closes the window", async () => {
    const hoster = loadHoster(
      createSession(fixture("buzzheavier-not-found.html"))
    );

    await rejectsWith(
      hoster.api.getDownloadUrl(pageUrl),
      DownloadError.HosterUnlockFileNotFound
    );
    assert.equal(hoster.state.evaluated.length, 0);
    assert.equal(hoster.state.closed, 1);
  });

  it("reports an unavailable hoster when the button is gone or the link is foreign", async () => {
    const drifted = loadHoster(
      createSession(fixture("buzzheavier-drift.html"))
    );
    await rejectsWith(
      drifted.api.getDownloadUrl(pageUrl),
      DownloadError.HosterUnlockUnavailable
    );

    const foreign = loadHoster(
      createSession(fixture("buzzheavier-file.html"), {
        status: 204,
        redirect: "https://ts.buzzheavier.com.evil.test/d/redacted123",
      })
    );
    await rejectsWith(
      foreign.api.getDownloadUrl(pageUrl),
      DownloadError.HosterUnlockUnavailable
    );
  });

  it("turns a blocked navigation into an unavailable error", async () => {
    const hoster = loadHoster(async (options, state) => {
      state.opened.push(options);
      return {
        navigate: async () => {
          throw new SourceFetchError("NETWORK", "The redirect was blocked.");
        },
        waitForFunction: async <T>() => true as T,
        readHtml: async () => "",
        evaluate: async <T>() => ({}) as T,
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
    const hoster = loadHoster(createSession(fixture("buzzheavier-file.html")));

    await assert.rejects(
      hoster.api.getDownloadUrl("https://example.com/redacted123"),
      /Invalid Buzzheavier URL/
    );
    assert.equal(hoster.state.opened.length, 0);
  });
});
