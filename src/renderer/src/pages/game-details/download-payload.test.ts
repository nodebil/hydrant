import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ProviderHosterLink,
  ProviderSearchHit,
  SourceProviderId,
} from "@types";
import { Downloader } from "../../../../shared/constants.js";
import { getDownloadersForUri } from "../../../../shared/downloader-mapping.js";
import { normalizeUriGroups } from "../../../../shared/repack-uri-groups.js";
import { toSyntheticRepack } from "../../../../shared/source-repack.js";
import { buildStartDownloadPayload } from "./download-payload.js";

const provider = {
  id: "steamrip" as SourceProviderId,
  name: "SteamRip",
};

const hit: ProviderSearchHit = {
  providerId: "steamrip",
  title: "ELDEN RING Deluxe Edition",
  url: "https://steamrip.com/elden-ring-de-free-download-1gg/",
  confidence: 1,
  build: "25827938",
  size: "69.1 GB",
  uploadDate: "2026-11-05",
};

const gofile: ProviderHosterLink = {
  kind: "hoster",
  url: "https://gofile.io/d/qpvferIa",
  label: "Gofile",
  hosterId: "gofile",
  size: "69.1 GB",
};

const fuckingFastParts = [
  "https://fuckingfast.co/a#Game.part1.rar",
  "https://fuckingfast.co/b#Game.part2.rar",
  "https://fuckingfast.co/c#Game.part3.rar",
];

const multipart: ProviderHosterLink = {
  kind: "hoster",
  url: fuckingFastParts[0],
  label: "FuckingFast",
  hosterId: "fuckingfast",
  size: "69.1 GB",
  parts: fuckingFastParts,
};

const base = {
  objectId: "1245620",
  title: "ELDEN RING",
  shop: "steam" as const,
  downloadPath: "D:\\Downloads",
  automaticallyExtract: true,
  automaticallyDeleteArchiveFiles: false,
};

describe("buildStartDownloadPayload", () => {
  it("forwards the game and modal options with the selected mirror", () => {
    const repack = normalizeUriGroups(
      toSyntheticRepack(provider, hit, [gofile]),
      getDownloadersForUri
    );

    const payload = buildStartDownloadPayload(repack, Downloader.Gofile, {
      ...base,
      fileIndices: [0, 2],
      selectedFilesSize: 128,
    });

    assert.equal(payload.uri, gofile.url);
    assert.equal(payload.parts, undefined);
    assert.equal(payload.downloader, Downloader.Gofile);
    assert.equal(payload.fileSize, "69.1 GB");
    assert.equal(payload.objectId, "1245620");
    assert.equal(payload.title, "ELDEN RING");
    assert.equal(payload.shop, "steam");
    assert.equal(payload.downloadPath, "D:\\Downloads");
    assert.equal(payload.automaticallyExtract, true);
    assert.equal(payload.automaticallyDeleteArchiveFiles, false);
    assert.deepEqual(payload.fileIndices, [0, 2]);
    assert.equal(payload.selectedFilesSize, 128);
    assert.equal("id" in payload, false);
    assert.equal("downloadSourceId" in payload, false);
  });

  it("sends the whole multipart group with its first part as the URI", () => {
    const repack = normalizeUriGroups(
      toSyntheticRepack(provider, hit, [gofile, multipart]),
      getDownloadersForUri
    );

    const payload = buildStartDownloadPayload(
      repack,
      Downloader.FuckingFast,
      base
    );

    assert.equal(payload.uri, fuckingFastParts[0]);
    assert.deepEqual(payload.parts, fuckingFastParts);
    assert.equal(payload.fileSize, "69.1 GB");
  });
});
