import type { ProviderDefinition, SourceProviderId } from "@types";
import { UnsupportedSourceError } from "../source-fetch/errors.js";

const providers = new Map<SourceProviderId, ProviderDefinition>();

const byPriorityThenId = (
  a: ProviderDefinition,
  b: ProviderDefinition
): number =>
  a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const registerProvider = (provider: ProviderDefinition): void => {
  if (providers.has(provider.id)) {
    throw new Error(`Provider already registered: ${provider.id}`);
  }

  providers.set(provider.id, provider);
};

export const getProvider = (id: SourceProviderId): ProviderDefinition => {
  const provider = providers.get(id);

  if (!provider) {
    throw new UnsupportedSourceError(
      "UNSUPPORTED_PROVIDER",
      `No provider registered for id: ${id}`
    );
  }

  return provider;
};

export const listProviders = (): ProviderDefinition[] =>
  [...providers.values()].sort(byPriorityThenId);
