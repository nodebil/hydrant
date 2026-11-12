import type {
  RankedSourceCandidate,
  SourceGameRepack,
  SourcePreferences,
  SourceProviderId,
} from "@types";
import { DEFAULT_SOURCE_PREFERENCES } from "../../../shared/source-providers.js";

export interface SourceCandidate {
  providerId: SourceProviderId;
  providerPriority: number;
  repack: SourceGameRepack;
  confidence: number;
  buildMatch: boolean;
  hosterIds: string[];
}

export type HosterPriorities = Readonly<Record<string, number>>;

const CONFIDENCE_SCALE = 1_000_000;
const BUILD_MATCH_BONUS = 100_000;
const PROVIDER_RANK_PENALTY = 10_000;
const HOSTER_RANK_PENALTY = 100;

const getHosterRanks = (
  candidates: SourceCandidate[],
  preferences: SourcePreferences,
  priorities: HosterPriorities
): Map<string, number> => {
  const hosterIds = new Set<string>();

  for (const candidate of candidates) {
    for (const hosterId of candidate.hosterIds) hosterIds.add(hosterId);
  }

  const preferenceRank = (hosterId: string) => {
    const index = preferences.hosterPriority.indexOf(hosterId);
    return index >= 0 ? index : preferences.hosterPriority.length;
  };

  return new Map(
    [...hosterIds]
      .sort(
        (a, b) =>
          preferenceRank(a) - preferenceRank(b) ||
          (priorities[a] ?? Number.MAX_SAFE_INTEGER) -
            (priorities[b] ?? Number.MAX_SAFE_INTEGER) ||
          (a < b ? -1 : a > b ? 1 : 0)
      )
      .map((hosterId, index) => [hosterId, index])
  );
};

const getCandidateHosterRank = (
  hosterIds: string[],
  ranks: Map<string, number>
): number => {
  let rank = ranks.size;

  for (const hosterId of hosterIds) {
    const value = ranks.get(hosterId);
    if (value !== undefined && value < rank) rank = value;
  }

  return rank;
};

const getProviderRanks = (
  candidates: SourceCandidate[],
  preferences: SourcePreferences
): Map<SourceProviderId, number> => {
  const priorityById = new Map<SourceProviderId, number>();

  for (const candidate of candidates) {
    if (!priorityById.has(candidate.providerId)) {
      priorityById.set(candidate.providerId, candidate.providerPriority);
    }
  }

  const preferenceRank = (providerId: SourceProviderId) => {
    const index = preferences.providerPriority.indexOf(providerId);
    return index >= 0 ? index : preferences.providerPriority.length;
  };

  return new Map(
    [...priorityById.keys()]
      .sort(
        (a, b) =>
          preferenceRank(a) - preferenceRank(b) ||
          (priorityById.get(a) ?? 0) - (priorityById.get(b) ?? 0) ||
          (a < b ? -1 : a > b ? 1 : 0)
      )
      .map((providerId, index) => [providerId, index])
  );
};

const compareRepackIds = (
  a: RankedSourceCandidate,
  b: RankedSourceCandidate
) => (a.repack.id < b.repack.id ? -1 : a.repack.id > b.repack.id ? 1 : 0);

// Confidence dominates; build match, provider rank, hoster rank, then repack id break ties.
export const rankSourceCandidates = (
  candidates: SourceCandidate[],
  preferences: SourcePreferences = DEFAULT_SOURCE_PREFERENCES,
  hosterPriorities: HosterPriorities = {}
): RankedSourceCandidate[] => {
  const providerRanks = getProviderRanks(candidates, preferences);
  const hosterRanks = getHosterRanks(candidates, preferences, hosterPriorities);

  const ranked = candidates.map((candidate) => {
    const hosterRank = getCandidateHosterRank(candidate.hosterIds, hosterRanks);
    const confidence = Math.min(1, Math.max(0, candidate.confidence));

    return {
      providerId: candidate.providerId,
      repack: candidate.repack,
      confidence,
      buildMatch: candidate.buildMatch,
      hosterRank,
      score:
        Math.round(confidence * CONFIDENCE_SCALE) +
        (candidate.buildMatch ? BUILD_MATCH_BONUS : 0) -
        (providerRanks.get(candidate.providerId) ?? 0) * PROVIDER_RANK_PENALTY -
        hosterRank * HOSTER_RANK_PENALTY,
    };
  });

  return ranked.sort((a, b) => b.score - a.score || compareRepackIds(a, b));
};
