import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SourceLogger } from "@types";
import { SourceFetchError } from "./errors.js";
import {
  getSourceErrorName,
  logSourceEvent,
  type SourceLogLevel,
} from "./source-log.js";

type LogCall = {
  level: SourceLogLevel;
  params: unknown[];
};

const captureLogger = () => {
  const calls: LogCall[] = [];
  const logger: SourceLogger = {
    debug: (...params) => calls.push({ level: "debug", params }),
    info: (...params) => calls.push({ level: "info", params }),
    warn: (...params) => calls.push({ level: "warn", params }),
    error: (...params) => calls.push({ level: "error", params }),
  };

  return { calls, logger };
};

describe("source log", () => {
  it("emits one structured event with request, host, technique, and timing", () => {
    const { calls, logger } = captureLogger();

    logSourceEvent(logger, {
      event: "provider.search.finish",
      requestId: "request-1",
      providerId: "steamrip",
      host: "steamrip.com",
      technique: "http",
      durationMs: 42,
      outcome: "ok",
      count: 2,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].level, "info");
    assert.deepEqual(calls[0].params, [
      "[Source]",
      {
        event: "provider.search.finish",
        requestId: "request-1",
        providerId: "steamrip",
        host: "steamrip.com",
        technique: "http",
        durationMs: 42,
        outcome: "ok",
        count: 2,
      },
    ]);
  });

  it("redacts cookies, tokens, and signed URL parameters from details", () => {
    const { calls, logger } = captureLogger();

    logSourceEvent(
      logger,
      {
        event: "provider.search.finish",
        requestId: "request-1",
        details: {
          cookie: "session=secret",
          url: "https://cdn.test/file?part=1&token=secret&key=secret&X-Goog-Signature=secret",
        },
      },
      "warn"
    );

    assert.equal(calls[0].level, "warn");
    const payload = calls[0].params[1] as {
      details: { cookie: string; url: string };
    };

    assert.equal(payload.details.cookie, "[REDACTED]");
    assert.equal(
      payload.details.url,
      "https://cdn.test/file?part=1&token=%5BREDACTED%5D&key=%5BREDACTED%5D&X-Goog-Signature=%5BREDACTED%5D"
    );
  });

  it("reports the error class without logging the error message", () => {
    assert.equal(
      getSourceErrorName(new SourceFetchError("TIMEOUT", "signed url")),
      "SourceFetchError"
    );
    assert.equal(getSourceErrorName("not an error"), "string");
  });
});
