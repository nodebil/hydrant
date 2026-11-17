import type {
  SourceGameRepack,
  SourceSearchResult,
  SourceSearchStatus,
} from "@types";

const FAILED_STATUSES: SourceSearchStatus[] = [
  "error",
  "timeout",
  "unsupported",
];

const isFailedSourceSearchStatus = (status: SourceSearchStatus): boolean =>
  FAILED_STATUSES.includes(status);

export type SourceSearchOutcome =
  | "done"
  | "failed"
  | "unsupported"
  | "unavailable";

export const getSourceSearchOutcome = (
  results: SourceSearchResult[]
): SourceSearchOutcome => {
  if (results.length === 0) return "unavailable";

  if (results.every((result) => isFailedSourceSearchStatus(result.status))) {
    return results.every((result) => result.status === "unsupported")
      ? "unsupported"
      : "failed";
  }

  return "done";
};

export const appendSourceRepacks = (
  current: SourceGameRepack[],
  incoming: SourceGameRepack[]
): SourceGameRepack[] => {
  const seen = new Set(current.map((repack) => repack.id));
  const appended = incoming.filter((repack) => !seen.has(repack.id));

  return appended.length > 0 ? [...current, ...appended] : current;
};
