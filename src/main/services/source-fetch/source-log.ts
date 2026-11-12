import type { SourceErrorCode, SourceLogger } from "@types";
import { sanitizeNetworkLogPayload } from "../network-log-payload.js";

export type SourceLogLevel = "debug" | "info" | "warn" | "error";
export type SourceTechnique = "http" | "browser";

export interface SourceLogEvent {
  event: string;
  requestId?: string;
  providerId?: string;
  hosterId?: string;
  host?: string;
  technique?: SourceTechnique;
  durationMs?: number;
  status?: number;
  outcome?: string;
  count?: number;
  errorCode?: SourceErrorCode;
  errorName?: string;
  details?: Record<string, unknown>;
}

export const getSourceErrorName = (error: unknown): string =>
  error instanceof Error ? error.name : typeof error;

export const logSourceEvent = (
  logger: SourceLogger,
  event: SourceLogEvent,
  level: SourceLogLevel = "info"
): void => {
  logger[level]("[Source]", sanitizeNetworkLogPayload(event));
};
