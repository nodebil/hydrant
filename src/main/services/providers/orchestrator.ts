import type {
  ProviderDefinition,
  RankedSourceCandidate,
  SelectionPolicy,
  SourceErrorCode,
  SourceGameRepack,
  SourceLogger,
  SourcePreferences,
  SourceProviderStatusEvent,
  SourceSearchRequest,
  SourceSearchResult,
  SourceSearchStatus,
} from "@types";
import { DEFAULT_SOURCE_PREFERENCES } from "../../../shared/source-providers.js";
import { toSyntheticRepack } from "../../../shared/source-repack.js";
import {
  rankSourceCandidates,
  type SourceCandidate,
} from "../resolvers/ranking.js";
import { listResolvers } from "../resolvers/registry.js";
import { manualSelectionPolicy } from "../resolvers/selection-policy.js";
import {
  SourceFetchError,
  isSourceFetchError,
} from "../source-fetch/errors.js";
import { createSourceHttpClient } from "../source-fetch/http-client.js";
import {
  getSourceErrorName,
  logSourceEvent,
  type SourceTechnique,
} from "../source-fetch/source-log.js";
import { parseHttpUrl } from "../source-fetch/url-policy.js";
import { getProvider, listProviders } from "./registry.js";

export interface SearchProvidersOptions {
  signal: AbortSignal;
  logger: SourceLogger;
  onStatus?: (event: SourceProviderStatusEvent) => void;
  preferences?: SourcePreferences;
  policy?: SelectionPolicy;
  onCandidateSelected?: (candidate: RankedSourceCandidate) => void;
}

const cancelled = () =>
  new SourceFetchError("CANCELLED", "Source provider search cancelled");

const ensureActive = (signal: AbortSignal): void => {
  if (signal.aborted) throw cancelled();
};

const isAbortError = (error: unknown) =>
  error instanceof Error && error.name === "AbortError";

const getErrorCode = (error: unknown): SourceErrorCode => {
  if (isAbortError(error)) return "CANCELLED";
  if (isSourceFetchError(error)) return error.code;

  // shortcut: unexpected provider failures share PARSE until the taxonomy grows.
  return "PARSE";
};

const getStatus = (code: SourceErrorCode): SourceSearchStatus => {
  if (code === "NOT_FOUND") return "not-found";
  if (code === "TIMEOUT") return "timeout";
  if (code === "UNSUPPORTED_PROVIDER") return "unsupported";

  return "error";
};

const runProvider = async (
  provider: ProviderDefinition,
  request: SourceSearchRequest,
  options: SearchProvidersOptions,
  candidates: SourceCandidate[]
): Promise<SourceSearchResult> => {
  const { signal, logger, onStatus } = options;
  const startedAt = performance.now();
  const host = parseHttpUrl(provider.baseUrl)?.hostname;
  const technique: SourceTechnique = provider.requiresBrowser
    ? "browser"
    : "http";
  const logBase = {
    requestId: request.requestId,
    providerId: provider.id,
    technique,
    ...(host ? { host } : {}),
  };
  const emit = (
    phase: SourceProviderStatusEvent["phase"],
    extra: Pick<SourceProviderStatusEvent, "count" | "errorCode"> = {}
  ) => {
    onStatus?.({
      requestId: request.requestId,
      providerId: provider.id,
      phase,
      ...extra,
    });
  };
  const finish = (
    result: Omit<SourceSearchResult, "providerId" | "durationMs">,
    error?: unknown
  ): SourceSearchResult => {
    const finished = {
      providerId: provider.id,
      ...result,
      durationMs: Math.round(performance.now() - startedAt),
    };

    logSourceEvent(
      logger,
      {
        event: "provider.search.finish",
        ...logBase,
        outcome: finished.status,
        count: finished.repacks.length,
        durationMs: finished.durationMs,
        ...(finished.errorCode ? { errorCode: finished.errorCode } : {}),
        ...(error ? { errorName: getSourceErrorName(error) } : {}),
      },
      finished.errorCode && finished.errorCode !== "CANCELLED" ? "warn" : "info"
    );

    return finished;
  };

  logSourceEvent(
    logger,
    { event: "provider.search.start", ...logBase },
    "debug"
  );
  emit("searching");

  try {
    ensureActive(signal);

    const client = createSourceHttpClient({
      timeoutMs: provider.timeoutMs,
      ...(host ? { allowedHosts: [host] } : {}),
    });
    const context = {
      signal,
      fetch: client.fetch,
      logger,
      requestId: request.requestId,
    };

    const hits = await provider.search(request, context);
    ensureActive(signal);

    if (hits.length === 0) {
      emit("done", { count: 0 });
      return finish({ status: "not-found", hits: [], repacks: [] });
    }

    emit("scraping", { count: hits.length });

    const repacks: SourceGameRepack[] = [];
    for (const hit of hits) {
      const links = await provider.scrape(hit, context);
      ensureActive(signal);

      const repack = toSyntheticRepack(provider, hit, links);
      if (repack.uris.length === 0 && !repack.uriGroups?.length) continue;

      repacks.push(repack);
      candidates.push({
        providerId: provider.id,
        providerPriority: provider.priority,
        repack,
        confidence: hit.confidence,
        // shortcut: requests carry no target build yet; enable this when a build target exists.
        buildMatch: false,
        hosterIds: links.flatMap((link) =>
          link.hosterId ? [link.hosterId] : []
        ),
      });
    }

    emit("done", { count: repacks.length });

    return finish({
      status: repacks.length > 0 ? "ok" : "not-found",
      hits,
      repacks,
    });
  } catch (error) {
    const errorCode = getErrorCode(error);
    emit("error", { errorCode });

    return finish(
      {
        status: getStatus(errorCode),
        hits: [],
        repacks: [],
        errorCode,
      },
      error
    );
  }
};

export const searchProviders = async (
  request: SourceSearchRequest,
  options: SearchProvidersOptions
): Promise<SourceSearchResult[]> => {
  const providers = request.providerIds
    ? request.providerIds.map(getProvider)
    : listProviders().filter((provider) => provider.enabledByDefault);
  const preferences = options.preferences ?? DEFAULT_SOURCE_PREFERENCES;
  const policy = options.policy ?? manualSelectionPolicy;

  const runs = await Promise.all(
    providers.map(async (provider) => {
      const candidates: SourceCandidate[] = [];
      const result = await runProvider(provider, request, options, candidates);

      return { result, candidates };
    })
  );

  const ranked = rankSourceCandidates(
    runs.flatMap((run) => run.candidates),
    preferences,
    Object.fromEntries(
      listResolvers().map((resolver) => [resolver.id, resolver.priority])
    )
  );
  const rankById = new Map(
    ranked.map((candidate, index) => [candidate.repack.id, index])
  );

  const results = runs.map(({ result }) => ({
    ...result,
    repacks: [...result.repacks].sort(
      (a, b) =>
        (rankById.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (rankById.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    ),
  }));

  const selected = policy.select(ranked, preferences);
  if (selected) options.onCandidateSelected?.(selected);

  return results;
};
