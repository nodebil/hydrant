import type { SourceErrorCode } from "@types";

export interface SourceFetchErrorOptions {
  status?: number;
  retryAfterMs?: number;
  cause?: unknown;
}

/** Typed failure shared by the source HTTP client, providers, and resolvers. */
export class SourceFetchError extends Error {
  readonly code: SourceErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    code: SourceErrorCode,
    message: string,
    options: SourceFetchErrorOptions = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "SourceFetchError";
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export const isSourceFetchError = (error: unknown): error is SourceFetchError =>
  error instanceof SourceFetchError;
