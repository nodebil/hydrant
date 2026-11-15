import type { SourceProviderId } from "@types";
import { SOURCE_PROVIDER_AVAILABILITY_CHANNEL } from "@shared";
import { listAvailableProviderIds } from "@main/services/providers/availability";
import { registerEvent } from "../register-event";

const getSourceProviderAvailability = (
  _event: Electron.IpcMainInvokeEvent
): SourceProviderId[] => listAvailableProviderIds();

registerEvent(
  SOURCE_PROVIDER_AVAILABILITY_CHANNEL,
  getSourceProviderAvailability
);
