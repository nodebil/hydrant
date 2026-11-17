// Local-only live smoke for the Akirabox hoster path.
// Usage: node scripts/smoke-akirabox-resolver.mjs [page-url]
// Resolves a live Akirabox file page and starts a real JsHttpDownloader transfer.
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
const pageUrl = process.argv[2] ?? "https://akirabox.to/b5OzdkewO3B8/file";
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
const bundleDir = await mkdtemp(path.join(cacheDir, "akirabox-smoke-"));
const tempRoot = await mkdtemp(path.join(tmpdir(), "hydra-akirabox-smoke-"));

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

const { AkiraboxApi, AKIRABOX_REFERER } = require("./akirabox.cjs");
const { JsHttpDownloader } = require("./downloader.cjs");
const { configureRangeStateDirectory } = require("./rangeState.cjs");

const ZIP_MAGIC = "504b0304";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const run = async () => {
  const started = Date.now();
  const directUrl = await AkiraboxApi.getDownloadUrl(${JSON.stringify(pageUrl)});
  const resolvedMs = Date.now() - started;
  const parsed = new URL(directUrl);

  assert.equal(parsed.hostname, "akirabox.com", "the link host is not akirabox.com");
  assert.ok(parsed.pathname.startsWith("/download/"), "the link path is not /download/");

  const range = await fetch(directUrl, {
    headers: { Range: "bytes=0-15", Referer: AKIRABOX_REFERER },
  });
  const rangeBytes = Buffer.from(await range.arrayBuffer());

  assert.equal(range.status, 206, "the range request did not answer 206");
  assert.equal(rangeBytes.length, 16, "the range body is not 16 bytes");
  assert.equal(
    rangeBytes.subarray(0, 4).toString("hex"),
    ZIP_MAGIC,
    "the range body is not a ZIP archive"
  );

  const rangeStateDir = path.join(userData, "DownloadRanges");
  fs.mkdirSync(rangeStateDir, { recursive: true });
  configureRangeStateDirectory(rangeStateDir);

  const downloader = new JsHttpDownloader();
  const savePath = fs.mkdtempSync(path.join(tempDir, "download-"));
  const runPromise = downloader.startDownload({
    url: directUrl,
    savePath,
    filename: "akirabox-smoke.bin",
    headers: { Referer: AKIRABOX_REFERER },
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

  const deadUrl = "https://akirabox.to/000000000000/file";
  let deadOutcome = "resolved";
  try {
    await AkiraboxApi.getDownloadUrl(deadUrl);
  } catch (error) {
    deadOutcome = error instanceof Error ? error.message : String(error);
  }
  assert.equal(
    deadOutcome,
    "download_error_hoster_unlock_file_not_found",
    "a missing Akirabox file did not report NOT_FOUND"
  );

  const windowsLeft = BrowserWindow.getAllWindows().length;
  assert.equal(windowsLeft, 0, "the hidden browser window was not closed");

  console.log(
    "SMOKE " +
      JSON.stringify({
        resolvedMs,
        directHost: parsed.hostname,
        rangeStatus: range.status,
        rangeBytes: rangeBytes.length,
        magic: rangeBytes.subarray(0, 4).toString("hex"),
        rangeContentLength: range.headers.get("content-length"),
        fileSize: status.fileSize,
        partialBytes,
        folderName: status.folderName,
        deadOutcome,
        windowsLeft,
      })
  );
  console.log("RESULT " + JSON.stringify({ akirabox: "passed" }));

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
          akirabox: path.join(root, "src/main/services/hosters/akirabox.ts"),
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
  assert.match(stdout, /"akirabox":"passed"/);
} finally {
  await rm(bundleDir, { recursive: true, force: true });
  await rm(tempRoot, { recursive: true, force: true });
}
