import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Downloader } from "./constants.js";
import {
  getDownloadersForUri,
  getDownloadersForUris,
} from "./downloader-mapping.js";

describe("downloader mapping", () => {
  it("maps the v1 hoster and leaves unimplemented hosters unmapped", () => {
    assert.deepEqual(getDownloadersForUri("https://gofile.io/d/qpvferIa"), [
      Downloader.Gofile,
    ]);
    assert.deepEqual(getDownloadersForUri("https://bzzhr.to/kgze9ln1colu"), []);
    assert.deepEqual(
      getDownloadersForUri("https://itsfileditchfiles.st/a/b/file.rar"),
      []
    );
  });

  it("keeps the existing native hoster mappings", () => {
    assert.deepEqual(
      getDownloadersForUri("https://archive.org/download/item/file.zip"),
      [Downloader.ArchiveOrg]
    );
    assert.deepEqual(getDownloadersForUri("https://filekeeper.net/abc/file"), [
      Downloader.FileKeeper,
    ]);
    assert.deepEqual(getDownloadersForUri("https://www.rootz.so/d/abc"), [
      Downloader.Rootz,
    ]);
    assert.deepEqual(getDownloadersForUri("https://pixeldrain.com/u/abc"), [
      Downloader.PixelDrain,
    ]);
  });

  it("keeps torrents on the torrent and debrid downloaders", () => {
    assert.deepEqual(getDownloadersForUri("magnet:?xt=urn:btih:abc"), [
      Downloader.Torrent,
      Downloader.Hydra,
      Downloader.TorBox,
      Downloader.RealDebrid,
      Downloader.Premiumize,
      Downloader.AllDebrid,
    ]);
  });

  it("collects each downloader once across URIs", () => {
    assert.deepEqual(
      getDownloadersForUris([
        "https://gofile.io/d/one",
        "https://gofile.io/d/two",
        "https://example.com/file.zip",
      ]),
      [Downloader.Gofile]
    );
  });
});
