import { SOURCE_PROVIDER_CANCEL_CHANNEL } from "@shared";
import { cancelSourceProviderSearch } from "@main/services/providers/search-sessions";
import { validateRequestId } from "@main/services/providers/validation";
import { registerEvent } from "../register-event";

const cancelSourceProviderSearchEvent = (
  _event: Electron.IpcMainInvokeEvent,
  requestId: unknown
) => {
  cancelSourceProviderSearch(validateRequestId(requestId));
};

registerEvent(SOURCE_PROVIDER_CANCEL_CHANNEL, cancelSourceProviderSearchEvent);
