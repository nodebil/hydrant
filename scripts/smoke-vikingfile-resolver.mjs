// Local-only live smoke for the VikingFile hoster path.
// Usage: node scripts/smoke-vikingfile-resolver.mjs <https://vikingfile.com/f/...>
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
const pageUrl = process.argv[2];

if (!pageUrl) {
  console.error("Usage: node scripts/smoke-vikingfile-resolver.mjs <page-url>");
  process.exit(1);
}

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
const bundleDir = await mkdtemp(path.join(cacheDir, "vikingfile-smoke-"));
const tempRoot = await mkdtemp(path.join(tmpdir(), "hydra-vikingfile-smoke-"));

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

const { VikingFileApi } = require("./vikingfile.cjs");

const RAR_MAGIC = "526172211a070100";

const run = async () => {
  const directUrl = await VikingFileApi.getDownloadUrl(${JSON.stringify(pageUrl)});
  assert.equal(new URL(directUrl).protocol, "https:", "the link is not https");

  const response = await fetch(directUrl, { headers: { Range: "bytes=0-15" } });
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 206, "the direct link did not answer 206");
  assert.equal(bytes.length, 16, "the range response is not 16 bytes");
  assert.equal(
    bytes.toString("hex").startsWith(RAR_MAGIC),
    true,
    "the range response is not a RAR archive"
  );

  const windowsLeft = BrowserWindow.getAllWindows().length;
  assert.equal(windowsLeft, 0, "the hidden browser window was not closed");

  console.log(
    "SMOKE " +
      JSON.stringify({
        pageHost: new URL(${JSON.stringify(pageUrl)}).host,
        directHost: new URL(directUrl).host,
        status: response.status,
        contentType: response.headers.get("content-type"),
        magic: bytes.subarray(0, 8).toString("hex"),
        windowsLeft,
      })
  );
  console.log("RESULT " + JSON.stringify({ vikingfile: "passed" }));
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
          vikingfile: path.join(
            root,
            "src/main/services/hosters/vikingfile.ts"
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
  assert.match(stdout, /"vikingfile":"passed"/);
} finally {
  await rm(bundleDir, { recursive: true, force: true });
  await rm(tempRoot, { recursive: true, force: true });
}
