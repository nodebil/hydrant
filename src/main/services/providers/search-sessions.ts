import { SourceFetchError } from "../source-fetch/errors.js";

const activeSearches = new Map<string, AbortController>();

export const beginSourceProviderSearch = (
  requestId: string
): AbortController => {
  if (activeSearches.has(requestId)) {
    throw new SourceFetchError("INVALID_INPUT", "Duplicate request id");
  }

  const controller = new AbortController();
  activeSearches.set(requestId, controller);

  return controller;
};

export const finishSourceProviderSearch = (
  requestId: string,
  controller: AbortController
): void => {
  if (activeSearches.get(requestId) === controller) {
    activeSearches.delete(requestId);
  }
};

export const cancelSourceProviderSearch = (requestId: string): boolean => {
  const controller = activeSearches.get(requestId);
  if (!controller) return false;

  controller.abort();
  return true;
};
