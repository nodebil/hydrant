import { Downloader } from "../../../shared/constants.js";

// VikingFile counts range requests; 8 MiB chunks gets an IP banned for an hour.
export const VIKINGFILE_PARALLEL_RANGE_SIZE = 1024 * 1024 * 1024;

const KNOWN_HOSTER_RANGE_SIZES = new Map<Downloader, number>([
  [Downloader.VikingFile, VIKINGFILE_PARALLEL_RANGE_SIZE],
]);

export function getHosterParallelRangeSize(
  downloader: Downloader | undefined
): number | undefined {
  return downloader ? KNOWN_HOSTER_RANGE_SIZES.get(downloader) : undefined;
}
