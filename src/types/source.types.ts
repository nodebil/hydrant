import type { Downloader } from "../shared/constants";
import type { GameShop } from "./game.types";
import type { GameRepack } from "./index";

/**
 * Known provider ids. The intersection keeps editor completion for the audited
 * providers while still accepting future provider ids without a type change.
 */
export type SourceProviderId =
  | "steamrip"
  | "steamgg"
  | "gamebounty"
  | "ankergames"
  | (string & Record<never, never>);

export type SourceSearchStatus =
  | "ok"
  | "not-found"
  | "error"
  | "timeout"
  | "unsupported";

export type SourceErrorCode =
  | "NETWORK"
  | "TIMEOUT"
  | "BLOCKED"
  | "NOT_FOUND"
  | "PARSE"
  | "UNSUPPORTED_HOSTER"
  | "UNSUPPORTED_PROVIDER"
  | "RESOLVER_FAILED"
  | "CANCELLED"
  | "FLAG_DISABLED"
  | "INVALID_INPUT";

/** Logging seam so provider and resolver code stays testable without Electron. */
export interface SourceLogger {
  debug(...params: unknown[]): void;
  info(...params: unknown[]): void;
  warn(...params: unknown[]): void;
  error(...params: unknown[]): void;
}

/**
 * Per-request network scope. Provider and resolver modules must use this
 * fetch instead of reaching for Electron or building a parallel client.
 */
export interface SourceContext {
  signal: AbortSignal;
  fetch: typeof fetch;
  logger: SourceLogger;
}

export interface ProviderContext extends SourceContext {
  requestId: string;
}

export interface ResolveContext extends SourceContext {
  /** Provider page URL, when the hoster validates the referer. */
  referer?: string;
}

export interface SourceSearchRequest {
  requestId: string;
  shop: GameShop;
  objectId: string;
  title: string;
  steamAppId?: number;
  /** Omitted means every enabled provider. */
  providerIds?: SourceProviderId[];
}

export interface ProviderSearchHit {
  providerId: SourceProviderId;
  title: string;
  url: string;
  /** Deterministic title/build match score in the 0..1 range. */
  confidence: number;
  build?: string;
  size?: string;
  quality?: string;
  steamAppId?: number;
  uploadDate?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

interface ProviderLinkBase {
  /** Stable hoster page, magnet/torrent, or provider-native handle. */
  url: string;
  /** User-facing hoster or part label. */
  label: string;
  hosterId?: string;
  size?: string;
  build?: string;
  /** Provider page URL used as the referer during resolution. */
  referer?: string;
  confidence?: number;
}

/**
 * A stable hoster page (or direct file) URL. v1 emits only this kind; the
 * direct URL is resolved at download time.
 */
export interface ProviderHosterLink extends ProviderLinkBase {
  kind: "hoster";
  hosterId: string;
  /**
   * Every part in order, including `url`, for a multipart upload. Hydra's
   * existing uriGroups/parts handling consumes this list.
   */
  parts?: string[];
}

/** A magnet or .torrent URL. Never sent through a web resolver. */
export interface ProviderTorrentLink extends ProviderLinkBase {
  kind: "torrent";
}

/** A provider-owned handle or challenge flow (for example AnkerGames). */
export interface ProviderNativeLink extends ProviderLinkBase {
  kind: "provider-native";
}

/**
 * Discriminated on `kind` so provider, IPC, adapter, and download code cannot
 * silently treat a torrent or provider-native handle as a hoster page.
 */
export type ProviderLink =
  | ProviderHosterLink
  | ProviderTorrentLink
  | ProviderNativeLink;

export interface SourceProviderCapabilities {
  search: boolean;
  scrape: boolean;
  latest?: boolean;
}

export interface ProviderDefinition {
  id: SourceProviderId;
  name: string;
  baseUrl: string;
  priority: number;
  enabledByDefault: boolean;
  /** Metadata seam; the browser session is supplied by the source-fetch layer. */
  requiresBrowser?: boolean;
  timeoutMs?: number;
  capabilities: SourceProviderCapabilities;
  search(
    request: SourceSearchRequest,
    ctx: ProviderContext
  ): Promise<ProviderSearchHit[]>;
  scrape(hit: ProviderSearchHit, ctx: ProviderContext): Promise<ProviderLink[]>;
}

export interface ResolverCapabilities {
  multipart?: boolean;
  availability?: boolean;
}

/**
 * Maps one hoster URL to a Hydra Downloader. `id` is the lower-case hoster id
 * used by ProviderLink.hosterId; `downloader` reuses the existing enum.
 */
export interface ResolverDefinition {
  id: string;
  downloader: Downloader;
  matches(url: URL): boolean;
  resolve(url: string, ctx: ResolveContext): Promise<ResolvedSource>;
  priority: number;
  timeoutMs?: number;
  requiresBrowser?: boolean;
  capabilities?: ResolverCapabilities;
}

/** One direct URL, ready to be mapped onto DownloadManager's JS options. */
export interface ResolvedSource {
  url: string;
  filename?: string;
  /** Size in bytes when the hoster reports it. */
  size?: number;
  headers?: Record<string, string>;
  /** Unix epoch milliseconds, when the hoster exposes a signed expiry. */
  expiresAt?: number;
}

/**
 * Synthetic repack ids are deterministic: the hash is an FNV-1a of the
 * provider page URL, so repeated searches return the same id.
 */
export type SourceRepackId = `provider:${string}:${string}`;
export type SourceDownloadSourceId = `provider:${string}`;

/**
 * Reuses Hydra's GameRepack shape so the existing download-options modal,
 * startGameDownload, extraction, and queue paths keep working.
 */
export interface SourceGameRepack extends GameRepack {
  id: SourceRepackId;
  downloadSourceId: SourceDownloadSourceId;
}

export interface SourceSearchResult {
  providerId: SourceProviderId;
  status: SourceSearchStatus;
  hits: ProviderSearchHit[];
  repacks: SourceGameRepack[];
  durationMs: number;
  errorCode?: SourceErrorCode;
  message?: string;
}

export interface SourcePreferences {
  providerPriority: SourceProviderId[];
  hosterPriority: string[];
  autoPick: boolean;
}

export interface RankedSourceCandidate {
  providerId: SourceProviderId;
  repack: SourceGameRepack;
  score: number;
  confidence: number;
  buildMatch: boolean;
  hosterRank: number;
}

/** v1 uses a manual policy; the auto policy is the reserved seam. */
export interface SelectionPolicy {
  readonly id: "manual" | "auto";
  select(
    candidates: RankedSourceCandidate[],
    preferences: SourcePreferences
  ): RankedSourceCandidate | null;
}

export type SourceProviderPhase = "searching" | "scraping" | "done" | "error";

export interface SourceProviderStatusEvent {
  requestId: string;
  providerId: SourceProviderId;
  phase: SourceProviderPhase;
  message?: string;
  count?: number;
  errorCode?: SourceErrorCode;
}

export interface SourceCancelRequest {
  requestId: string;
}
