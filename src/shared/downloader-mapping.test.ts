import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Downloader } from "./constants.js";
import {
  getDownloadersForUri,
  getDownloadersForUris,
} from "./downloader-mapping.js";

describe("downloader mapping", () => {
  it("maps implemented hosters and leaves unimplemented hosters unmapped", () => {
    assert.deepEqual(getDownloadersForUri("https://gofile.io/d/qpvferIa"), [
      Downloader.Gofile,
    ]);
    assert.deepEqual(getDownloadersForUri("https://bzzhr.to/kgze9ln1colu"), [
      Downloader.Buzzheavier,
    ]);
    assert.deepEqual(
      getDownloadersForUri("https://itsfileditchfiles.st/a/b/file.rar"),
      [Downloader.Fileditch]
    );
  });

  it("maps every Fileditch file host", () => {
    for (const uri of [
      "https://fileditchfiles.st/a/b/file.rar",
      "https://itsfileditchfiles.st/a/b/file.rar",
      "https://fileditchfiles.me/a/b/file.rar",
    ]) {
      assert.deepEqual(getDownloadersForUri(uri), [Downloader.Fileditch]);
    }

    assert.deepEqual(
      getDownloadersForUri("https://fileditchfiles.st.evil.test/a/b/file.rar"),
      []
    );
  });

  it("maps every Akirabox host", () => {
    for (const uri of [
      "https://akirabox.to/b5OzdkewO3B8/file",
      "https://akirabox.com/b5OzdkewO3B8/file",
    ]) {
      assert.deepEqual(getDownloadersForUri(uri), [Downloader.Akirabox]);
    }

    assert.deepEqual(
      getDownloadersForUri("https://akirabox.to.evil.test/b5OzdkewO3B8/file"),
      []
    );
  });

  it("maps MegaDB file pages", () => {
    assert.deepEqual(
      getDownloadersForUri("https://megadb.net/89bf12c47dbe5b69"),
      [Downloader.MegaDB]
    );
    assert.deepEqual(
      getDownloadersForUri("https://megadb.net.evil.test/89bf12c47dbe5b69"),
      []
    );
  });

  it("maps every Buzzheavier domain", () => {
    for (const uri of [
      "https://buzzheavier.com/abc",
      "https://bzzhr.to/abc",
      "https://bzzhr.co/abc",
    ]) {
      assert.deepEqual(getDownloadersForUri(uri), [Downloader.Buzzheavier]);
    }
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
