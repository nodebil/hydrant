import type {
  SourceProviderResultEvent,
  SourceProviderStatusEvent,
} from "@types";
import {
  SOURCE_PROVIDER_RESULT_CHANNEL,
  SOURCE_PROVIDER_SEARCH_CHANNEL,
  SOURCE_PROVIDER_STATUS_CHANNEL,
} from "@shared";
import { logger } from "@main/services/logger";
import { isProviderAvailable } from "@main/services/providers/availability";
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

const sendResult = (
  event: Electron.IpcMainInvokeEvent,
  payload: SourceProviderResultEvent
) => {
  if (!event.sender.isDestroyed()) {
    event.sender.send(SOURCE_PROVIDER_RESULT_CHANNEL, payload);
  }
};

const searchSourceProviders = async (
  event: Electron.IpcMainInvokeEvent,
  payload: unknown
) => {
  const request = validateSourceSearchRequest(payload);
  const controller = beginSourceProviderSearch(request.requestId);

  try {
    return await searchProviders(request, {
      signal: controller.signal,
      logger,
      isProviderEnabled: isProviderAvailable,
      onStatus: (status) => sendStatus(event, status),
      onProviderResult: (result) =>
        sendResult(event, { requestId: request.requestId, result }),
    });
  } finally {
    finishSourceProviderSearch(request.requestId, controller);
  }
};

registerEvent(SOURCE_PROVIDER_SEARCH_CHANNEL, searchSourceProviders);
