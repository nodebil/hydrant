import type { ResolverDefinition } from "@types";
import { UnsupportedSourceError } from "../source-fetch/errors.js";

const resolvers = new Map<string, ResolverDefinition>();

const byPriorityThenId = (
  a: ResolverDefinition,
  b: ResolverDefinition
): number =>
  a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const registerResolver = (resolver: ResolverDefinition): void => {
  if (resolvers.has(resolver.id)) {
    throw new Error(`Resolver already registered: ${resolver.id}`);
  }

  resolvers.set(resolver.id, resolver);
};

export const getResolver = (id: string): ResolverDefinition => {
  const resolver = resolvers.get(id);

  if (!resolver) {
    throw new UnsupportedSourceError(
      "UNSUPPORTED_HOSTER",
      `No resolver registered for id: ${id}`
    );
  }

  return resolver;
};

export const listResolvers = (): ResolverDefinition[] =>
  [...resolvers.values()].sort(byPriorityThenId);

export const getResolverForUrl = (url: string | URL): ResolverDefinition => {
  let parsed: URL;

  try {
    parsed = url instanceof URL ? url : new URL(url);
  } catch {
    throw new UnsupportedSourceError(
      "UNSUPPORTED_HOSTER",
      "Invalid source URL"
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UnsupportedSourceError(
      "UNSUPPORTED_HOSTER",
      `Unsupported source URL scheme: ${parsed.protocol}`
    );
  }

  const resolver = listResolvers().find((candidate) =>
    candidate.matches(parsed)
  );

  if (!resolver) {
    throw new UnsupportedSourceError(
      "UNSUPPORTED_HOSTER",
      `No resolver registered for host: ${parsed.hostname}`
    );
  }

  return resolver;
};
