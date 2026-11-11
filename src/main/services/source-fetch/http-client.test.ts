import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import type { SourceErrorCode } from "@types";
import { SourceFetchError } from "./errors.js";
import { createSourceHttpClient } from "./http-client.js";

const counters = {
  forbidden: 0,
  rateLimit: 0,
  serverError: 0,
  active: 0,
  maxActive: 0,
};

let server: http.Server;
let baseUrl: string;

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

describe("createSourceHttpClient", () => {
  before(async () => {
    server = http.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      switch (url.pathname) {
        case "/ok":
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
          });
          response.end("hello");
          return;
        case "/set-cookie":
          response.writeHead(200, {
            "content-type": "text/plain",
            "set-cookie": "session=abc; Path=/",
          });
          response.end("set");
          return;
        case "/echo":
          response.writeHead(200, { "content-type": "text/plain" });
          response.end(
            `cookie=${request.headers.cookie ?? ""}\n` +
              `ua=${request.headers["user-agent"] ?? ""}\n` +
              `referer=${request.headers.referer ?? ""}`
          );
          return;
        case "/redirect":
          response.writeHead(302, { location: "/ok" });
          response.end();
          return;
        case "/forbidden":
          counters.forbidden++;
          response.writeHead(403, { "content-type": "text/html" });
          response.end("<html>blocked</html>");
          return;
        case "/not-found":
          response.writeHead(404, { "content-type": "text/html" });
          response.end("missing");
          return;
        case "/rate-limit":
          counters.rateLimit++;
          if (counters.rateLimit === 1) {
            response.writeHead(429, {
              "content-type": "text/plain",
              "retry-after": "0",
            });
            response.end("slow down");
          } else {
            response.writeHead(200, { "content-type": "text/plain" });
            response.end("ok");
          }
          return;
        case "/server-error":
          counters.serverError++;
          if (counters.serverError === 1) {
            response.writeHead(500, { "content-type": "text/plain" });
            response.end("boom");
          } else {
            response.writeHead(200, { "content-type": "text/plain" });
            response.end("ok");
          }
          return;
        case "/slow":
          setTimeout(() => {
            if (!response.destroyed) {
              response.writeHead(200, { "content-type": "text/plain" });
              response.end("slow");
            }
          }, 200);
          return;
        case "/large":
          response.writeHead(200, { "content-type": "text/plain" });
          for (let index = 0; index < 20; index++) {
            response.write("0123456789");
          }
          response.end();
          return;
        case "/large-declared":
          response.writeHead(200, {
            "content-type": "text/plain",
            "content-length": "1000",
          });
          response.end("0".repeat(1000));
          return;
        case "/octet":
          response.writeHead(200, {
            "content-type": "application/octet-stream",
          });
          response.end(Buffer.from([0, 1, 2, 3]));
          return;
        case "/loop":
          response.writeHead(302, { location: "/loop" });
          response.end();
          return;
        case "/concurrency":
          counters.active++;
          counters.maxActive = Math.max(counters.maxActive, counters.active);
          setTimeout(() => {
            counters.active--;
            if (!response.destroyed) {
              response.writeHead(200, { "content-type": "text/plain" });
              response.end("ok");
            }
          }, 25);
          return;
        default:
          response.writeHead(404);
          response.end();
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("The test server did not bind to a TCP port.");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("follows redirects and preserves the final URL", async () => {
    const client = createSourceHttpClient({ retries: 0 });

    const response = await client.fetch(`${baseUrl}/redirect`);

    assert.equal(response.status, 200);
    assert.equal(response.url, `${baseUrl}/ok`);
    assert.equal(await response.text(), "hello");
  });

  it("sends the user agent, referer, and cookies", async () => {
    const client = createSourceHttpClient({
      retries: 0,
      userAgent: "hydra-test-agent",
    });

    await (await client.fetch(`${baseUrl}/set-cookie`)).text();

    const response = await client.fetch(`${baseUrl}/echo`, {
      headers: { Referer: `${baseUrl}/game` },
    });
    const body = await response.text();

    assert.match(body, /cookie=session=abc/);
    assert.match(body, /ua=hydra-test-agent/);
    assert.match(body, new RegExp(`referer=${baseUrl}/game`));
  });

  it("maps HTTP status codes to source errors without retrying", async () => {
    counters.forbidden = 0;
    const client = createSourceHttpClient({
      retries: 3,
      retryBaseDelayMs: 1,
    });

    await assertRejectsWithCode(
      client.fetch(`${baseUrl}/forbidden`),
      "BLOCKED"
    );
    await assertRejectsWithCode(
      client.fetch(`${baseUrl}/not-found`),
      "NOT_FOUND"
    );
    assert.equal(counters.forbidden, 1);
  });

  it("retries 429 and respects Retry-After", async () => {
    counters.rateLimit = 0;
    const client = createSourceHttpClient({
      retries: 1,
      retryBaseDelayMs: 1,
    });

    const response = await client.fetch(`${baseUrl}/rate-limit`);

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
    assert.equal(counters.rateLimit, 2);
  });

  it("retries a server error", async () => {
    counters.serverError = 0;
    const client = createSourceHttpClient({
      retries: 1,
      retryBaseDelayMs: 1,
    });

    const response = await client.fetch(`${baseUrl}/server-error`);

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
    assert.equal(counters.serverError, 2);
  });

  it("times out with TIMEOUT", async () => {
    const client = createSourceHttpClient({ retries: 0, timeoutMs: 20 });

    await assertRejectsWithCode(client.fetch(`${baseUrl}/slow`), "TIMEOUT");
  });

  it("aborts with CANCELLED", async () => {
    const controller = new AbortController();
    const client = createSourceHttpClient({ retries: 0, timeoutMs: 1000 });
    const request = client.fetch(`${baseUrl}/slow`, {
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 10);

    await assertRejectsWithCode(request, "CANCELLED");
  });

  it("caps chunked and declared response bodies", async () => {
    const client = createSourceHttpClient({
      retries: 0,
      maxResponseBytes: 10,
    });

    const response = await client.fetch(`${baseUrl}/large`);
    await assertRejectsWithCode(response.text(), "PARSE");
    await assertRejectsWithCode(
      client.fetch(`${baseUrl}/large-declared`),
      "PARSE"
    );
  });

  it("rejects an unexpected content type", async () => {
    const client = createSourceHttpClient({ retries: 0 });

    await assertRejectsWithCode(client.fetch(`${baseUrl}/octet`), "PARSE");
  });

  it("limits concurrent requests per host", async () => {
    counters.active = 0;
    counters.maxActive = 0;
    const client = createSourceHttpClient({
      retries: 0,
      maxConcurrentPerHost: 2,
    });

    await Promise.all(
      Array.from({ length: 6 }, () =>
        client
          .fetch(`${baseUrl}/concurrency`)
          .then((response) => response.text())
      )
    );

    assert.equal(counters.maxActive, 2);
  });

  it("maps redirect loops to NETWORK", async () => {
    const client = createSourceHttpClient({ retries: 0 });

    await assertRejectsWithCode(client.fetch(`${baseUrl}/loop`), "NETWORK");
  });

  it("rejects invalid and non-HTTP URLs", async () => {
    const client = createSourceHttpClient({ retries: 0 });

    await assertRejectsWithCode(client.fetch("not a url"), "INVALID_INPUT");
    await assertRejectsWithCode(
      client.fetch("ftp://example.com/file"),
      "INVALID_INPUT"
    );
  });
});
