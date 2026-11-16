// Local-only live smoke for the Fileditch hoster path.
// Usage: node scripts/smoke-fileditch-resolver.mjs
// Resolves a live SteamRip Fileditch link and starts a real JsHttpDownloader transfer.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import electronPath from "electron";
import { build, loadEnv } from "vite";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = path.join(root, "node_modules", ".cache");
const env = loadEnv("production", root, "");
const replaceMainEnv = () => ({
  name: "replace-main-env",
  enforce: "pre",
  transform(code) {
    return code
      .replaceAll(
        "import.meta.env.MAIN_VITE_API_URL",
        JSON.stringify(env.MAIN_VITE_API_URL || "https://example.invalid")
      )
      .replaceAll("import.meta.env.MAIN_VITE_USER_DATA_PATH", "undefined");
  },
});

await mkdir(cacheDir, { recursive: true });
// Keep the bundle under the repo so its external dependencies resolve from node_modules.
const bundleDir = await mkdtemp(path.join(cacheDir, "fileditch-smoke-"));
const tempRoot = await mkdtemp(path.join(tmpdir(), "hydra-fileditch-smoke-"));

const smokeMain = `const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

process.on("uncaughtException", (error) => {
  console.error(error);
  app.exit(1);
});

const tempRoot = ${JSON.stringify(tempRoot)};
const userData = path.join(tempRoot, "userData");
const tempDir = path.join(tempRoot, "temp");
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(tempDir, { recursive: true });
app.setPath("userData", userData);
app.setPath("temp", tempDir);
app.disableHardwareAcceleration();
app.on("window-all-closed", () => undefined);

const { steamripProvider } = require("./steamrip.cjs");
const { FileditchApi } = require("./fileditch.cjs");
const { JsHttpDownloader } = require("./downloader.cjs");
const { configureRangeStateDirectory } = require("./rangeState.cjs");

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const run = async () => {
  const signal = new AbortController().signal;
  const request = {
    requestId: "smoke-fileditch",
    shop: "steam",
    objectId: "1245620",
    title: "ELDEN RING",
    steamAppId: 1245620,
  };
  const ctx = {
    signal,
    fetch: globalThis.fetch,
    logger,
    requestId: request.requestId,
  };

  const hits = await steamripProvider.search(request, ctx);
  assert.ok(hits.length > 0, "SteamRip returned no hit");

  const links = await steamripProvider.scrape(hits[0], ctx);
  const fileditchLink = links.find((link) => link.hosterId === "fileditch");
  assert.ok(fileditchLink, "SteamRip returned no Fileditch link");

  const directUrl = await FileditchApi.getDownloadUrl(fileditchLink.url);
  const head = await fetch(directUrl, { method: "HEAD" });
  assert.equal(head.status, 200, "Fileditch direct link did not answer 200");
  await head.body?.cancel();
  const contentLength = Number(head.headers.get("content-length")) || null;
  assert.ok(contentLength > 0, "Fileditch direct link has no content length");

  const downloader = new JsHttpDownloader();
  const rangeStateDir = path.join(userData, "DownloadRanges");
  fs.mkdirSync(rangeStateDir, { recursive: true });
  configureRangeStateDirectory(rangeStateDir);
  const savePath = fs.mkdtempSync(path.join(tempDir, "download-"));
  const runPromise = downloader.startDownload({
    url: directUrl,
    savePath,
    filename: "fileditch-smoke.bin",
    allowParallelRanges: false,
    allowResume: false,
  });

  let status = null;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    status = downloader.getDownloadStatus();
    if (status && status.bytesDownloaded >= 256 * 1024) break;
    if (status && (status.status === "complete" || status.status === "error")) break;
    await sleep(200);
  }

  downloader.pauseDownload();
  await runPromise.catch(() => undefined);
  downloader.cancelDownload(false);

  assert.ok(status, "JsHttpDownloader returned no status");
  assert.ok(status.bytesDownloaded > 0, "JsHttpDownloader wrote no bytes");

  const partialPath = path.join(savePath, status.folderName);
  assert.ok(fs.existsSync(partialPath), "partial file is missing");
  const partialBytes = fs.statSync(partialPath).size;
  assert.ok(partialBytes > 0, "partial file is empty");

  const deadUrl =
    "https://fileditchfiles.st/beta18/0000000000000000dead/Missing.rar";
  let deadOutcome = "resolved";
  try {
    await FileditchApi.getDownloadUrl(deadUrl);
  } catch (error) {
    deadOutcome = error instanceof Error ? error.message : String(error);
  }
  assert.equal(
    deadOutcome,
    "download_error_hoster_unlock_file_not_found",
    "a missing Fileditch file did not report NOT_FOUND"
  );

  const windowsLeft = BrowserWindow.getAllWindows().length;
  assert.equal(windowsLeft, 0, "the hidden browser window was not closed");

  console.log(
    "SMOKE " +
      JSON.stringify({
        steamripLink: fileditchLink.url,
        directHost: new URL(directUrl).hostname,
        headStatus: head.status,
        contentLength,
        contentType: head.headers.get("content-type"),
        contentDisposition: head.headers.get("content-disposition"),
        partialBytes,
        folderName: status.folderName,
        deadOutcome,
        windowsLeft,
      })
  );
  console.log("RESULT " + JSON.stringify({ fileditch: "passed" }));

  app.quit();
};

app.whenReady().then(async () => {
  try {
    await run();
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
`;

try {
  await build({
    configFile: false,
    logLevel: "silent",
    resolve: {
      alias: {
        "@main": path.join(root, "src/main"),
        "@shared": path.join(root, "src/shared"),
        "@locales": path.join(root, "src/locales"),
        "@resources": path.join(root, "resources"),
      },
    },
    plugins: [replaceMainEnv()],
    build: {
      lib: {
        entry: {
          steamrip: path.join(root, "src/main/services/providers/steamrip.ts"),
          fileditch: path.join(root, "src/main/services/hosters/fileditch.ts"),
          downloader: path.join(
            root,
            "src/main/services/download/js-http-downloader.ts"
          ),
          rangeState: path.join(
            root,
            "src/main/services/download/range-download-state.ts"
          ),
        },
        formats: ["cjs"],
        fileName: (_format, entryName) => `${entryName}.cjs`,
      },
      outDir: bundleDir,
      emptyOutDir: false,
      rollupOptions: { external: ["electron"] },
      ssr: true,
    },
  });

  const main = path.join(bundleDir, "smoke.cjs");
  await writeFile(main, smokeMain);

  const { stdout, stderr } = await execFileAsync(electronPath, [main], {
    cwd: root,
    timeout: 300_000,
    windowsHide: true,
  });

  process.stdout.write(stdout);
  process.stderr.write(stderr);
  assert.match(stdout, /"fileditch":"passed"/);
} finally {
  await rm(bundleDir, { recursive: true, force: true });
  await rm(tempRoot, { recursive: true, force: true });
}
