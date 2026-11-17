import type {
  ProviderDefinition,
  RankedSourceCandidate,
  SelectionPolicy,
  SourceErrorCode,
  SourceGameRepack,
  SourceLogger,
  SourcePreferences,
  SourceProviderId,
  SourceProviderStatusEvent,
  SourceSearchRequest,
  SourceSearchResult,
  SourceSearchStatus,
} from "@types";
import { DEFAULT_SOURCE_PREFERENCES } from "../../../shared/source-providers.js";
import { toSyntheticRepack } from "../../../shared/source-repack.js";
import { mapWithConcurrency } from "../cloud-save/map-with-concurrency.js";
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
  isProviderEnabled?: (providerId: SourceProviderId) => Promise<boolean>;
  onStatus?: (event: SourceProviderStatusEvent) => void;
  preferences?: SourcePreferences;
  policy?: SelectionPolicy;
  onCandidateSelected?: (candidate: RankedSourceCandidate) => void;
  providerTimeoutMs?: number;
  concurrency?: number;
}

const DEFAULT_PROVIDER_TIMEOUT_MS = 60_000;
const DEFAULT_PROVIDER_CONCURRENCY = 2;

const cancelled = () =>
  new SourceFetchError("CANCELLED", "Source provider search cancelled");

const timeoutError = () =>
  new SourceFetchError("TIMEOUT", "Source provider search timed out");

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

const getRepackLinkKey = (repack: SourceGameRepack): string =>
  [
    [...repack.uris].sort().join("\n"),
    ...(repack.uriGroups ?? [])
      .map((group) => [...group].sort().join("\n"))
      .sort(),
  ].join("\u0000");

const runProvider = async (
  provider: ProviderDefinition,
  request: SourceSearchRequest,
  options: SearchProvidersOptions,
  candidates: SourceCandidate[]
): Promise<SourceSearchResult> => {
  const { logger, onStatus } = options;
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
    details: { title: request.title },
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

  const controller = new AbortController();
  const signal = controller.signal;
  const onRequestAbort = () => controller.abort();

  if (options.signal.aborted) controller.abort();
  else options.signal.addEventListener("abort", onRequestAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        reject(timeoutError());
        controller.abort();
      },
      Math.max(1, options.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS)
    );
  });

  const search = async () => {
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
      return { hits, repacks: [] as SourceGameRepack[] };
    }

    emit("scraping", { count: hits.length });

    const repacks: SourceGameRepack[] = [];
    const repackIds = new Set<string>();
    const repackLinks = new Set<string>();

    for (const hit of hits) {
      const links = await provider.scrape(hit, context);
      ensureActive(signal);

      const repack = toSyntheticRepack(provider, hit, links);
      if (repack.uris.length === 0 && !repack.uriGroups?.length) continue;

      // First card wins: one game returned twice must not duplicate cards.
      const linkKey = getRepackLinkKey(repack);
      if (repackIds.has(repack.id) || repackLinks.has(linkKey)) continue;

      repackIds.add(repack.id);
      repackLinks.add(linkKey);
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

    return { hits, repacks };
  };

  try {
    ensureActive(signal);

    const { hits, repacks } = await Promise.race([search(), deadline]);

    emit("done", { count: repacks.length });

    return finish({
      status: repacks.length > 0 ? "ok" : "not-found",
      hits,
      repacks,
    });
  } catch (error) {
    const errorCode = getErrorCode(error);
    emit("error", { errorCode });
    candidates.length = 0;

    return finish(
      {
        status: getStatus(errorCode),
        hits: [],
        repacks: [],
        errorCode,
      },
      error
    );
  } finally {
    if (timer) clearTimeout(timer);
    options.signal.removeEventListener("abort", onRequestAbort);
  }
};

const filterEnabledProviders = async (
  providers: ProviderDefinition[],
  isProviderEnabled?: (providerId: SourceProviderId) => Promise<boolean>
): Promise<ProviderDefinition[]> => {
  if (!isProviderEnabled) return providers;

  const flags = await Promise.all(
    providers.map((provider) => isProviderEnabled(provider.id))
  );

  return providers.filter((_, index) => flags[index]);
};

export const searchProviders = async (
  request: SourceSearchRequest,
  options: SearchProvidersOptions
): Promise<SourceSearchResult[]> => {
  const requestedProviders = request.providerIds
    ? request.providerIds.map(getProvider)
    : listProviders().filter((provider) => provider.enabledByDefault);
  const providers = await filterEnabledProviders(
    requestedProviders,
    options.isProviderEnabled
  );
  const preferences = options.preferences ?? DEFAULT_SOURCE_PREFERENCES;
  const policy = options.policy ?? manualSelectionPolicy;

  const runs = await mapWithConcurrency(
    providers,
    Math.max(1, options.concurrency ?? DEFAULT_PROVIDER_CONCURRENCY),
    async (provider) => {
      const candidates: SourceCandidate[] = [];
      const result = await runProvider(provider, request, options, candidates);

      return { result, candidates };
    }
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
