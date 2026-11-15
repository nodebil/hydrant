import type { SourceProviderId } from "@types";
import { listProviders } from "./registry.js";

export const listAvailableProviderIds = (): SourceProviderId[] =>
  listProviders().map((provider) => provider.id);

export const isProviderAvailable = async (
  providerId: SourceProviderId
): Promise<boolean> => listAvailableProviderIds().includes(providerId);
