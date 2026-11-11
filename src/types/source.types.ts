import type { Downloader } from "../shared/constants";
import type { GameShop } from "./game.types";
import type { GameRepack } from "./index";

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

export interface SourceLogger {
  debug(...params: unknown[]): void;
  info(...params: unknown[]): void;
  warn(...params: unknown[]): void;
  error(...params: unknown[]): void;
}

export interface SourceContext {
  signal: AbortSignal;
  fetch: typeof fetch;
  logger: SourceLogger;
}

export interface ProviderContext extends SourceContext {
  requestId: string;
}

export interface ResolveContext extends SourceContext {
  referer?: string;
}

export interface SourceSearchRequest {
  requestId: string;
  shop: GameShop;
  objectId: string;
  title: string;
  steamAppId?: number;
  providerIds?: SourceProviderId[];
}

export interface ProviderSearchHit {
  providerId: SourceProviderId;
  title: string;
  url: string;
  confidence: number;
  build?: string;
  size?: string;
  quality?: string;
  steamAppId?: number;
  uploadDate?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

interface ProviderLinkBase {
  url: string;
  label: string;
  hosterId?: string;
  size?: string;
  build?: string;
  referer?: string;
  confidence?: number;
}

export interface ProviderHosterLink extends ProviderLinkBase {
  kind: "hoster";
  hosterId: string;
  parts?: string[];
}

export interface ProviderTorrentLink extends ProviderLinkBase {
  kind: "torrent";
}

export interface ProviderNativeLink extends ProviderLinkBase {
  kind: "provider-native";
}

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

export interface ResolvedSource {
  url: string;
  filename?: string;
  size?: number;
  headers?: Record<string, string>;
  expiresAt?: number;
}

export type SourceRepackId = `provider:${string}:${string}`;
export type SourceDownloadSourceId = `provider:${string}`;

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
