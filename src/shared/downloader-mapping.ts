import { isArchiveOrgFileUri } from "./archive-org.js";
import { Downloader } from "./constants.js";

const realDebridHosts = ["https://1fichier.com", "https://mediafire.com"];

export const getDownloadersForUri = (uri: string) => {
  if (uri.startsWith("https://gofile.io")) return [Downloader.Gofile];

  if (uri.startsWith("https://pixeldrain.com")) return [Downloader.PixelDrain];
  if (uri.startsWith("https://datanodes.to")) return [Downloader.Datanodes];
  if (uri.startsWith("https://www.mediafire.com"))
    return [Downloader.Mediafire];
  if (
    uri.startsWith("https://fuckingfast.co") ||
    uri.startsWith("https://fuckingfast.net")
  ) {
    return [Downloader.FuckingFast];
  }
  if (
    uri.startsWith("https://vikingfile.com") ||
    uri.startsWith("https://vik1ngfile.site")
  ) {
    return [Downloader.VikingFile];
  }
  if (uri.startsWith("https://www.rootz.so")) {
    return [Downloader.Rootz];
  }
  if (uri.startsWith("https://filekeeper.net/")) {
    return [Downloader.FileKeeper];
  }
  if (
    uri.startsWith("https://buzzheavier.com") ||
    uri.startsWith("https://bzzhr.to") ||
    uri.startsWith("https://bzzhr.co")
  ) {
    return [Downloader.Buzzheavier];
  }
  if (
    uri.startsWith("https://fileditchfiles.st/") ||
    uri.startsWith("https://itsfileditchfiles.st/") ||
    uri.startsWith("https://fileditchfiles.me/")
  ) {
    return [Downloader.Fileditch];
  }
  if (
    uri.startsWith("https://akirabox.to/") ||
    uri.startsWith("https://akirabox.com/")
  ) {
    return [Downloader.Akirabox];
  }
  if (isArchiveOrgFileUri(uri)) {
    return [Downloader.ArchiveOrg];
  }

  if (realDebridHosts.some((host) => uri.startsWith(host)))
    return [Downloader.RealDebrid];

  if (uri.startsWith("magnet:")) {
    return [
      Downloader.Torrent,
      Downloader.Hydra,
      Downloader.TorBox,
      Downloader.RealDebrid,
      Downloader.Premiumize,
      Downloader.AllDebrid,
    ];
  }

  return [];
};

export const getDownloadersForUris = (uris: string[]) => {
  const downloadersSet = uris.reduce<Set<Downloader>>((prev, next) => {
    const downloaders = getDownloadersForUri(next);
    downloaders.forEach((downloader) => prev.add(downloader));

    return prev;
  }, new Set());

  return Array.from(downloadersSet);
};
