import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Downloader } from "../../../shared/constants.js";
import {
  VIKINGFILE_PARALLEL_RANGE_SIZE,
  getHosterParallelRangeSize,
} from "./download-range-policy.ts";

describe("getHosterParallelRangeSize", () => {
  it("uses 1 GiB ranges for VikingFile", () => {
    assert.equal(
      getHosterParallelRangeSize(Downloader.VikingFile),
      VIKINGFILE_PARALLEL_RANGE_SIZE
    );
  });

  it("leaves other hosters and debrid on the default tuning", () => {
    for (const downloader of [
      Downloader.Gofile,
      Downloader.Buzzheavier,
      Downloader.Fileditch,
      Downloader.Akirabox,
      Downloader.MegaDB,
      Downloader.RealDebrid,
      Downloader.Premiumize,
      Downloader.AllDebrid,
      Downloader.TorBox,
    ]) {
      assert.equal(getHosterParallelRangeSize(downloader), undefined);
    }
    assert.equal(getHosterParallelRangeSize(undefined), undefined);
  });
});
