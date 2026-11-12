import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ProviderHosterLink,
  ProviderLink,
  ProviderSearchHit,
  SourceProviderId,
} from "@types";
import { Downloader } from "./constants.js";
import {
  normalizeUriGroups,
  withoutMultipartHosterDownloads,
} from "./repack-uri-groups.js";
import { toSyntheticRepack } from "./source-repack.js";

const provider = {
  id: "steamrip" as SourceProviderId,
  name: "SteamRip",
};

const hit: ProviderSearchHit = {
  providerId: "steamrip",
  title: "ELDEN RING Deluxe Edition",
  url: "https://steamrip.com/elden-ring-de-free-download-1gg/",
  confidence: 1,
  build: "Build 25827938",
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

const pixelDrain: ProviderHosterLink = {
  kind: "hoster",
  url: "https://pixeldrain.com/u/abc123",
  label: "PixelDrain",
  hosterId: "pixeldrain",
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

const getDownloadersForUri = (uri: string): Downloader[] => {
  if (uri.startsWith("https://gofile.io")) return [Downloader.Gofile];
  if (uri.startsWith("https://pixeldrain.com")) return [Downloader.PixelDrain];
  if (uri.startsWith("https://fuckingfast.co")) return [Downloader.FuckingFast];
  if (uri.startsWith("https://1fichier.com")) return [Downloader.RealDebrid];
  return [];
};

describe("toSyntheticRepack", () => {
  it("maps mirrors and metadata onto a stable synthetic repack", () => {
    const repack = toSyntheticRepack(provider, hit, [gofile, pixelDrain]);

    assert.equal(repack.id, "provider:steamrip:595afaff");
    assert.equal(repack.title, "ELDEN RING Deluxe Edition Build 25827938");
    assert.equal(repack.fileSize, "69.1 GB");
    assert.deepEqual(repack.uris, [gofile.url, pixelDrain.url]);
    assert.equal(repack.uriGroups, undefined);
    assert.deepEqual(repack.unavailableUris, []);
    assert.equal(repack.uploadDate, "2026-11-05");
    assert.equal(repack.downloadSourceId, "provider:steamrip");
    assert.equal(repack.downloadSourceName, "SteamRip");
    assert.match(repack.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("groups multipart parts as one download option", () => {
    const repack = toSyntheticRepack(provider, hit, [gofile, multipart]);

    assert.deepEqual(repack.uris, [gofile.url]);
    assert.deepEqual(repack.uriGroups, [fuckingFastParts]);
  });

  it("lists single and multipart mirrors as separate options after filtering", () => {
    const repack = toSyntheticRepack(provider, hit, [gofile, multipart]);
    const filtered = normalizeUriGroups(repack, getDownloadersForUri);

    assert.deepEqual(filtered.uris, [gofile.url, fuckingFastParts[0]]);
    assert.deepEqual(filtered.uriGroups, [fuckingFastParts]);
  });

  it("drops a multipart group instead of keeping its first part when the feature is off", () => {
    const repack = toSyntheticRepack(provider, hit, [gofile, multipart]);
    const filtered = withoutMultipartHosterDownloads(repack);

    assert.deepEqual(filtered.uris, [gofile.url]);
    assert.equal(filtered.uriGroups, undefined);
  });

  it("keeps a multipart-only repack grouped until the feature is off", () => {
    const repack = toSyntheticRepack(provider, hit, [multipart]);

    assert.deepEqual(repack.uris, []);
    assert.deepEqual(repack.uriGroups, [fuckingFastParts]);
    assert.deepEqual(normalizeUriGroups(repack, getDownloadersForUri).uris, [
      fuckingFastParts[0],
    ]);
    assert.deepEqual(withoutMultipartHosterDownloads(repack).uris, []);
  });

  it("drops multipart groups without a multipart downloader", () => {
    const parts = ["https://1fichier.com/?a", "https://1fichier.com/?b"];
    const repack = toSyntheticRepack(provider, hit, [
      {
        kind: "hoster",
        url: parts[0],
        label: "1fichier",
        hosterId: "1fichier",
        parts,
      },
    ]);

    assert.deepEqual(normalizeUriGroups(repack, getDownloadersForUri).uris, []);
  });

  it("deduplicates links, repeated parts, and duplicate groups", () => {
    const repeatedPart: ProviderHosterLink = {
      ...multipart,
      url: fuckingFastParts[1],
      parts: [
        fuckingFastParts[0],
        fuckingFastParts[1],
        fuckingFastParts[1],
        fuckingFastParts[2],
      ],
    };
    const repack = toSyntheticRepack(provider, hit, [
      gofile,
      gofile,
      multipart,
      repeatedPart,
      { ...gofile, label: "Gofile mirror" },
    ]);

    assert.deepEqual(repack.uris, [gofile.url]);
    assert.deepEqual(repack.uriGroups, [fuckingFastParts]);
  });

  it("keeps the same id across repeated searches with different links", () => {
    const first = toSyntheticRepack(provider, hit, [gofile]);
    const second = toSyntheticRepack(provider, hit, [pixelDrain, multipart]);
    const otherHit: ProviderSearchHit = {
      ...hit,
      url: "https://steamrip.com/dead-space-2023-free-download/",
    };
    const other = toSyntheticRepack(provider, otherHit, [gofile]);

    assert.equal(first.id, second.id);
    assert.notEqual(first.id, other.id);
  });

  it("uses a link size only when every link reports the same size", () => {
    const noSize: ProviderSearchHit = { ...hit, size: undefined };

    assert.equal(
      toSyntheticRepack(provider, noSize, [
        { ...gofile, size: "67.5GB" },
        { ...pixelDrain, size: "67.5 GB" },
      ]).fileSize,
      "67.5GB"
    );

    assert.equal(
      toSyntheticRepack(provider, noSize, [
        gofile,
        { ...pixelDrain, size: undefined },
      ]).fileSize,
      null
    );

    assert.equal(
      toSyntheticRepack(provider, noSize, [
        gofile,
        { ...pixelDrain, size: "68.2 GB" },
      ]).fileSize,
      null
    );

    assert.equal(
      toSyntheticRepack(provider, hit, [
        { ...gofile, size: "1 GB" },
        { ...pixelDrain, size: "2 GB" },
      ]).fileSize,
      "69.1 GB"
    );
  });

  it("appends the build only when the title does not already contain it", () => {
    const partialHit: ProviderSearchHit = {
      ...hit,
      title: "ELDEN RING Deluxe Edition Build 25827938",
    };

    assert.equal(
      toSyntheticRepack(provider, partialHit, []).title,
      "ELDEN RING Deluxe Edition Build 25827938"
    );
    assert.equal(
      toSyntheticRepack(provider, { ...partialHit, title: "ELDEN RING" }, [])
        .title,
      "ELDEN RING Build 25827938"
    );
  });

  it("accepts links without hoster parts", () => {
    const torrent: ProviderLink = {
      kind: "torrent",
      url: "magnet:?xt=urn:btih:abc123",
      label: "Torrent",
    };

    assert.deepEqual(toSyntheticRepack(provider, hit, [torrent]).uris, [
      torrent.url,
    ]);
  });
});
