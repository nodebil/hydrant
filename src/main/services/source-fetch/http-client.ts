import { CookieJar } from "tough-cookie";
import { SourceFetchError } from "./errors.js";

export const SOURCE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_RETRY_MAX_DELAY_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_PER_HOST = 2;

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const DEFAULT_ALLOWED_CONTENT_TYPES = [
  "text/*",
  "application/xhtml+xml",
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/rss+xml",
  "application/atom+xml",
  "application/javascript",
] as const;

export interface SourceHttpClientOptions {
  userAgent?: string;
  cookieJar?: CookieJar;
  timeoutMs?: number;
  retries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  maxResponseBytes?: number;
  maxConcurrentPerHost?: number;
  allowedContentTypes?: readonly string[];
  redirect?: RequestRedirect;
  fetchImpl?: typeof fetch;
}

export interface SourceHttpClient {
  fetch: typeof fetch;
  cookieJar: CookieJar;
}

interface HostWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

/** Keeps concurrent requests to one provider host below a fixed limit. */
class HostLimiter {
  private readonly active = new Map<string, number>();
  private readonly queues = new Map<string, HostWaiter[]>();

  constructor(private readonly limit: number) {}

  async acquire(host: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw cancelledError();

    const active = this.active.get(host) ?? 0;
    if (active < this.limit) {
      this.active.set(host, active + 1);
      return;
    }

    const queues = this.queues;
    await new Promise<void>((resolve, reject) => {
      const queue = queues.get(host) ?? [];
      const waiter: HostWaiter = {
        resolve: () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        reject: (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      function onAbort() {
        const index = queue.indexOf(waiter);
        if (index !== -1) queue.splice(index, 1);
        if (queue.length === 0 && queues.get(host) === queue) {
          queues.delete(host);
        }
        waiter.reject(cancelledError());
      }
      queue.push(waiter);
      queues.set(host, queue);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  release(host: string): void {
    const queue = this.queues.get(host);
    const next = queue?.shift();
    if (next) {
      if (queue && queue.length === 0) this.queues.delete(host);
      next.resolve();
      return;
    }

    const active = this.active.get(host) ?? 0;
    if (active <= 1) {
      this.active.delete(host);
    } else {
      this.active.set(host, active - 1);
    }
  }
}

const cancelledError = () =>
  new SourceFetchError("CANCELLED", "The source request was cancelled.");

const timedOutError = () =>
  new SourceFetchError("TIMEOUT", "The source request timed out.");

const statusError = (
  status: number,
  retryAfterMs: number | null
): SourceFetchError => {
  const options = { status, retryAfterMs: retryAfterMs ?? undefined };

  if (status === 404 || status === 410) {
    return new SourceFetchError(
      "NOT_FOUND",
      "The source returned no result.",
      options
    );
  }
  if (status === 401 || status === 403 || status === 407 || status === 451) {
    return new SourceFetchError(
      "BLOCKED",
      "The source blocked the request.",
      options
    );
  }
  if (status === 429) {
    return new SourceFetchError(
      "BLOCKED",
      "The source rate-limited the request.",
      options
    );
  }
  if (status === 400 || status === 422) {
    return new SourceFetchError(
      "INVALID_INPUT",
      "The source rejected the request.",
      options
    );
  }
  return new SourceFetchError("NETWORK", "The source request failed.", options);
};

const parseRetryAfter = (
  value: string | null,
  maxDelayMs: number
): number | null => {
  if (!value?.trim()) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, maxDelayMs);
  }

  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.min(Math.max(0, date - Date.now()), maxDelayMs);
  }

  return null;
};

const isRetryableError = (error: SourceFetchError) =>
  error.code === "NETWORK" || error.code === "TIMEOUT";

const sleep = (ms: number, signal: AbortSignal): Promise<void> => {
  if (ms <= 0) {
    if (signal.aborted) return Promise.reject(cancelledError());
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    function onAbort() {
      clearTimeout(timer);
      reject(cancelledError());
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
};

const getSetCookie = (headers: Headers): string[] => {
  const withSetCookie = headers as Headers & {
    getSetCookie?: () => string[];
  };
  if (typeof withSetCookie.getSetCookie === "function") {
    return withSetCookie.getSetCookie();
  }

  const single = headers.get("set-cookie");
  return single ? [single] : [];
};

const cancelBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // The body may already be closed or errored.
  }
};

const limitResponseBody = (response: Response, maxBytes: number): Response => {
  if (!response.body) return response;

  const reader = response.body.getReader();
  let bytesRead = 0;

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }

        bytesRead += value.byteLength;
        if (bytesRead > maxBytes) {
          await reader.cancel();
          controller.error(
            new SourceFetchError("PARSE", "The source response is too large.", {
              status: response.status,
            })
          );
          return;
        }

        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  const limited = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

  Object.defineProperties(limited, {
    url: { value: response.url, enumerable: true, configurable: true },
    redirected: {
      value: response.redirected,
      enumerable: true,
      configurable: true,
    },
    type: { value: response.type, enumerable: true, configurable: true },
  });

  return limited;
};

const validateResponse = async (
  response: Response,
  allowedContentTypes: readonly string[],
  maxResponseBytes: number
): Promise<Response> => {
  if (!response.ok) return response;

  const contentType = response.headers.get("content-type");
  if (contentType) {
    const mime = contentType.split(";")[0]?.trim().toLowerCase();
    if (mime && !isAllowedContentType(mime, allowedContentTypes)) {
      await cancelBody(response);
      throw new SourceFetchError(
        "PARSE",
        "The source returned an unexpected content type.",
        { status: response.status }
      );
    }
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
    await cancelBody(response);
    throw new SourceFetchError("PARSE", "The source response is too large.", {
      status: response.status,
    });
  }

  return limitResponseBody(response, maxResponseBytes);
};

const isAllowedContentType = (
  mime: string,
  allowedContentTypes: readonly string[]
): boolean => {
  if (mime.endsWith("+json") || mime.endsWith("+xml")) return true;

  return allowedContentTypes.some((allowed) => {
    const normalized = allowed.toLowerCase();
    if (normalized.endsWith("/*")) {
      return mime.startsWith(normalized.slice(0, -1));
    }
    return mime === normalized;
  });
};

export const createSourceHttpClient = (
  options: SourceHttpClientOptions = {}
): SourceHttpClient => {
  const userAgent = options.userAgent ?? SOURCE_USER_AGENT;
  const cookieJar = options.cookieJar ?? new CookieJar();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);
  const retryBaseDelayMs =
    options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const allowedContentTypes =
    options.allowedContentTypes ?? DEFAULT_ALLOWED_CONTENT_TYPES;
  const redirect = options.redirect ?? "follow";
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const limiter = new HostLimiter(
    Math.max(1, options.maxConcurrentPerHost ?? DEFAULT_MAX_CONCURRENT_PER_HOST)
  );

  const fetchWithSourcePolicy: typeof fetch = async (input, init) => {
    let baseRequest: Request;
    try {
      baseRequest = new Request(input, init);
    } catch (error) {
      throw new SourceFetchError(
        "INVALID_INPUT",
        "The source URL is invalid.",
        {
          cause: error,
        }
      );
    }

    let requestUrl: URL;
    try {
      requestUrl = new URL(baseRequest.url);
    } catch (error) {
      throw new SourceFetchError(
        "INVALID_INPUT",
        "The source URL is invalid.",
        {
          cause: error,
        }
      );
    }

    if (requestUrl.protocol !== "http:" && requestUrl.protocol !== "https:") {
      throw new SourceFetchError(
        "INVALID_INPUT",
        "The source URL must use HTTP or HTTPS."
      );
    }

    const callerSignal = baseRequest.signal;
    const host = requestUrl.hostname;

    const performAttempt = async (): Promise<Response> => {
      if (callerSignal.aborted) throw cancelledError();

      const controller = new AbortController();
      let timedOut = false;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, timeoutMs)
          : null;
      const onAbort = () => controller.abort();
      callerSignal.addEventListener("abort", onAbort, { once: true });

      try {
        const headers = new Headers(baseRequest.headers);
        if (!headers.has("user-agent")) {
          headers.set("user-agent", userAgent);
        }
        if (!headers.has("cookie")) {
          const cookie = await cookieJar.getCookieString(baseRequest.url);
          if (cookie) headers.set("cookie", cookie);
        }
        if (
          !headers.has("referer") &&
          baseRequest.referrer &&
          baseRequest.referrer !== "about:client"
        ) {
          headers.set("referer", baseRequest.referrer);
        }

        const request = new Request(baseRequest, {
          headers,
          signal: controller.signal,
          redirect,
        });

        await limiter.acquire(host, controller.signal);
        try {
          const response = await fetchImpl(request);
          const setCookies = getSetCookie(response.headers);
          if (setCookies.length > 0) {
            const cookieUrl = response.url || baseRequest.url;
            for (const cookie of setCookies) {
              try {
                await cookieJar.setCookie(cookie, cookieUrl);
              } catch {
                // Ignore cookies the jar rejects; they must not fail the request.
              }
            }
          }
          return response;
        } finally {
          limiter.release(host);
        }
      } catch (error) {
        if (timedOut) throw timedOutError();
        if (callerSignal.aborted) throw cancelledError();
        if (error instanceof SourceFetchError) throw error;
        throw new SourceFetchError("NETWORK", "The source request failed.", {
          cause: error,
        });
      } finally {
        if (timer) clearTimeout(timer);
        callerSignal.removeEventListener("abort", onAbort);
      }
    };

    let lastError: SourceFetchError | undefined;
    let delayMs = 0;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        await sleep(delayMs, callerSignal);
      }

      let response: Response;
      try {
        response = await performAttempt();
      } catch (error) {
        const fetchError =
          error instanceof SourceFetchError
            ? error
            : new SourceFetchError("NETWORK", "The source request failed.", {
                cause: error,
              });

        if (
          fetchError.code === "CANCELLED" ||
          attempt >= retries ||
          !isRetryableError(fetchError)
        ) {
          throw fetchError;
        }

        lastError = fetchError;
        delayMs = Math.min(retryBaseDelayMs * 2 ** attempt, retryMaxDelayMs);
        continue;
      }

      if (response.status >= 300 && response.status < 400) {
        return response;
      }

      if (!response.ok) {
        const retryAfterMs = parseRetryAfter(
          response.headers.get("retry-after"),
          retryMaxDelayMs
        );
        const error = statusError(response.status, retryAfterMs);
        await cancelBody(response);

        if (RETRYABLE_STATUS.has(response.status) && attempt < retries) {
          lastError = error;
          delayMs =
            retryAfterMs ??
            Math.min(retryBaseDelayMs * 2 ** attempt, retryMaxDelayMs);
          continue;
        }

        throw error;
      }

      return validateResponse(response, allowedContentTypes, maxResponseBytes);
    }

    throw (
      lastError ?? new SourceFetchError("NETWORK", "The source request failed.")
    );
  };

  return { fetch: fetchWithSourcePolicy, cookieJar };
};
