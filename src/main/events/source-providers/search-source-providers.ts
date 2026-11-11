import type { SourceProviderStatusEvent } from "@types";
import {
  SOURCE_PROVIDER_SEARCH_CHANNEL,
  SOURCE_PROVIDER_STATUS_CHANNEL,
} from "@shared";
import { logger } from "@main/services/logger";
import { isSourceProviderSearchEnabled } from "@main/services/providers/feature-flags";
import { searchProviders } from "@main/services/providers/orchestrator";
import {
  beginSourceProviderSearch,
  finishSourceProviderSearch,
} from "@main/services/providers/search-sessions";
import { validateSourceSearchRequest } from "@main/services/providers/validation";
import { registerEvent } from "../register-event";

const sendStatus = (
  event: Electron.IpcMainInvokeEvent,
  status: SourceProviderStatusEvent
) => {
  if (!event.sender.isDestroyed()) {
    event.sender.send(SOURCE_PROVIDER_STATUS_CHANNEL, status);
  }
};

const searchSourceProviders = async (
  event: Electron.IpcMainInvokeEvent,
  payload: unknown
) => {
  const request = validateSourceSearchRequest(payload);
  const controller = beginSourceProviderSearch(request.requestId);

  try {
    if (!(await isSourceProviderSearchEnabled())) return [];

    return await searchProviders(request, {
      signal: controller.signal,
      logger,
      onStatus: (status) => sendStatus(event, status),
    });
  } finally {
    finishSourceProviderSearch(request.requestId, controller);
  }
};

registerEvent(SOURCE_PROVIDER_SEARCH_CHANNEL, searchSourceProviders);
