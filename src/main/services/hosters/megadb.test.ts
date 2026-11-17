import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import ts from "typescript";
import { DownloadError } from "../../../shared/constants.js";
import * as urlPolicyModule from "../source-fetch/url-policy.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

const pageUrl = "https://megadb.net/89bf12c47dbe5b69";
const ptUrl = "https://megadb.net/89bf12c47dbe5b69?pt=redacted";
const fileUrl =
  "https://fs12.megadb.xyz/89bf12c47dbe5b69/FTL-Faster-Than-Light-SteamRIP.com.rar";
const approvedReferer = "https://steamrip.com/";

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  redirect?: RequestRedirect;
}

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  log: () => undefined,
};

const loadHoster = (
  wait: (ms: number) => Promise<unknown> = async () => undefined
) => {
  const { outputText } = ts.transpileModule(
    readFileSync(new URL("./megadb.ts", import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: "megadb.ts",
    }
  );
  const stubs: Record<string, unknown> = {
    "node:timers/promises": { setTimeout: wait },
    "../../../shared/constants.js": { DownloadError },
    "../logger.js": { logger: noopLogger },
    "../source-fetch/http-client.js": { SOURCE_USER_AGENT: "test" },
    "../source-fetch/url-policy.js": urlPolicyModule,
  };
  const exports: Record<string, unknown> = {};
  new Function("exports", "require", outputText)(exports, (name: string) => {
    const stub = stubs[name];
    if (!stub) throw new Error(`Unexpected import: ${name}`);
    return stub;
  });

  return {
    api: exports.MegaDBApi as { getDownloadUrl(uri: string): Promise<string> },
    resolve: exports.resolveMegaDBLink as (
      uri: string,
      options: {
        fetchImpl?: typeof fetch;
        wait?: (ms: number) => Promise<unknown>;
      }
    ) => Promise<string>,
    parsePage: exports.parseMegaDBPage as (html: string) => {
      pt?: string;
      notFound: boolean;
      referrerError: boolean;
      countdownMs: number;
    },
    isHost: exports.isMegaDBHost as (value: string) => boolean,
    isFileHost: exports.isMegaDBFileHost as (value: string) => boolean,
  };
};

const readCall = (call: FetchCall) => ({
  url: call.url,
  referer: call.headers.referer,
  cookie: call.headers.cookie,
  userAgent: call.headers["user-agent"],
});

const createFetch = (
  respond: (call: FetchCall) => Response
): { fetchImpl: typeof fetch; calls: FetchCall[] } => {
  const calls: FetchCall[] = [];

  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const call: FetchCall = {
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      redirect: init?.redirect,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;

  return { fetchImpl, calls };
};

const pageResponse = (html: string, setCookie = "filehosting=abc; Path=/") =>
  new Response(html, {
    status: 200,
    headers: { "content-type": "text/html", "set-cookie": setCookie },
  });

const redirectResponse = (location: string) =>
  new Response(null, { status: 302, headers: { location } });

const rejectsWith = async (promise: Promise<unknown>, message: string) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, message);
    return true;
  });
};

describe("megadb hoster", () => {
  const parser = loadHoster();

  it("reads the token and countdown from the live file page", () => {
    const page = parser.parsePage(fixture("megadb-file.html"));

    assert.deepEqual(page, {
      pt: ptUrl,
      notFound: false,
      referrerError: false,
      countdownMs: 10_000,
    });
  });

  it("recognizes the referrer and not-found error pages", () => {
    const referrer = parser.parsePage(fixture("megadb-referrer.html"));
    const notFound = parser.parsePage(fixture("megadb-not-found.html"));

    assert.equal(referrer.referrerError, true);
    assert.equal(notFound.notFound, true);
    assert.equal(notFound.referrerError, false);
  });

  it("accepts only MegaDB page and file hosts", () => {
    assert.equal(parser.isHost(pageUrl), true);
    assert.equal(parser.isHost("http://megadb.net/89bf12c47dbe5b69"), false);
    assert.equal(
      parser.isHost("https://megadb.net.evil.test/89bf12c47dbe5b69"),
      false
    );

    assert.equal(parser.isFileHost(fileUrl), true);
    assert.equal(
      parser.isFileHost("https://megadb.net/89bf12c47dbe5b69"),
      false
    );
    assert.equal(
      parser.isFileHost("http://fs12.megadb.xyz/89bf12c47dbe5b69/file.rar"),
      false
    );
    assert.equal(
      parser.isFileHost("https://fs12.megadb.xyz.evil.test/file.rar"),
      false
    );
  });

  it("resolves the file URL with the approved referer and page cookie", async () => {
    const waits: number[] = [];
    const { fetchImpl, calls } = createFetch((call) => {
      if (call.url === pageUrl)
        return pageResponse(fixture("megadb-file.html"));
      if (call.url === ptUrl) return redirectResponse(fileUrl);
      throw new Error(`Unexpected fetch: ${call.url}`);
    });
    const hoster = loadHoster(async (ms) => {
      waits.push(ms);
    });

    const url = await hoster.resolve(pageUrl, { fetchImpl });

    assert.equal(url, fileUrl);
    assert.deepEqual(waits, [12_000]);
    assert.deepEqual(readCall(calls[0]), {
      url: pageUrl,
      referer: approvedReferer,
      cookie: undefined,
      userAgent: "test",
    });
    assert.deepEqual(readCall(calls[1]), {
      url: ptUrl,
      referer: approvedReferer,
      cookie: "filehosting=abc",
      userAgent: "test",
    });
    assert.equal(calls[1].redirect, "manual");
  });

  it("tries the next approved referer when the page rejects the first one", async () => {
    const { fetchImpl, calls } = createFetch((call) => {
      if (call.url === ptUrl) return redirectResponse(fileUrl);
      return call.headers.referer === "https://steamgg.net/"
        ? pageResponse(fixture("megadb-file.html"))
        : pageResponse(fixture("megadb-referrer.html"));
    });
    const hoster = loadHoster();

    const url = await hoster.resolve(pageUrl, { fetchImpl });

    assert.equal(url, fileUrl);
    assert.deepEqual(
      calls.map((call) => call.headers.referer),
      [approvedReferer, "https://steamgg.net/", "https://steamgg.net/"]
    );
  });

  it("fails closed when no known referer is approved", async () => {
    const { fetchImpl, calls } = createFetch(() =>
      pageResponse(fixture("megadb-referrer.html"))
    );
    const hoster = loadHoster();

    await rejectsWith(
      hoster.resolve(pageUrl, { fetchImpl }),
      DownloadError.HosterUnlockUnavailable
    );
    assert.equal(calls.length, 6);
  });

  it("reports a removed file without trying another referer", async () => {
    const { fetchImpl, calls } = createFetch(() =>
      pageResponse(fixture("megadb-not-found.html"))
    );
    const hoster = loadHoster();

    await rejectsWith(
      hoster.resolve(pageUrl, { fetchImpl }),
      DownloadError.HosterUnlockFileNotFound
    );
    assert.equal(calls.length, 1);
  });

  it("retries with a fresh page when the countdown token is not ready", async () => {
    const waits: number[] = [];
    let ptCalls = 0;
    const { fetchImpl, calls } = createFetch((call) => {
      if (call.url === ptUrl) {
        ptCalls += 1;
        return pageResponse(fixture("megadb-file.html"));
      }
      return call.headers.referer === approvedReferer
        ? pageResponse(fixture("megadb-file.html"))
        : pageResponse(fixture("megadb-referrer.html"));
    });
    const hoster = loadHoster(async (ms) => {
      waits.push(ms);
    });

    await rejectsWith(
      hoster.resolve(pageUrl, { fetchImpl }),
      DownloadError.HosterUnlockUnavailable
    );
    assert.equal(ptCalls, 2);
    assert.deepEqual(waits, [12_000, 12_000]);
    assert.equal(
      calls.filter(
        (call) =>
          call.url === pageUrl && call.headers.referer === approvedReferer
      ).length,
      2
    );
  });

  it("rejects unsupported URLs before fetching", async () => {
    const { calls } = createFetch(() => {
      throw new Error("must not fetch");
    });
    const hoster = loadHoster();

    await assert.rejects(
      hoster.api.getDownloadUrl("https://megadb.net.evil.test/abc"),
      /Invalid MegaDB URL/
    );
    assert.equal(calls.length, 0);
  });
});
