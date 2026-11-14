import { Downloader } from "../../../../shared/constants.js";
import { getDownloadersForUri } from "../../../../shared/downloader-mapping.js";
import { getUriGroupParts } from "../../../../shared/repack-uri-groups.js";
import type { GameRepack, StartGameDownloadPayload } from "@types";

type StartDownloadPayloadBase = Omit<
  StartGameDownloadPayload,
  "downloader" | "uri" | "parts" | "fileSize"
>;

export const buildStartDownloadPayload = (
  repack: GameRepack,
  downloader: Downloader,
  base: StartDownloadPayloadBase
): StartGameDownloadPayload => {
  const uri = repack.uris.find((candidate) =>
    getDownloadersForUri(candidate).includes(downloader)
  )!;

  return {
    ...base,
    downloader,
    uri,
    parts: getUriGroupParts(repack, uri),
    fileSize: repack.fileSize,
  };
};
