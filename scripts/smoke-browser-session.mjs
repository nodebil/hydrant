// Local-only smoke check for the hidden browser session.
// Usage: node scripts/smoke-browser-session.mjs
// It serves three fixture pages on 127.0.0.1 and runs the real Electron path.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import electronPath from "electron";
import { build } from "vite";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workDir = await mkdtemp(path.join(tmpdir(), "hydra-browser-session-"));

const smokeMain = `const assert = require("node:assert/strict");
const http = require("node:http");
const { app, BrowserWindow } = require("electron");
const { HiddenBrowserSession } = require("./browser-session.cjs");

app.disableHardwareAcceleration();
// Closing the last hidden window must not quit the smoke app mid-run.
app.on("window-all-closed", () => undefined);

const pages = {
  "/ok": "<!doctype html><html><body><div id='ready'>ready</div></body></html>",
  "/cloudflare":
    "<!doctype html><html><head><title>Just a moment...</title></head><body><div id='challenge-form'>checking your browser</div></body></html>",
  "/slow": "<!doctype html><html><body><div id='later'>later</div></body></html>",
};

const server = http.createServer((request, response) => {
  const body = pages[request.url];
  response.writeHead(body ? 200 : 404, {
    "content-type": "text/html; charset=utf-8",
  });
  response.end(body || "missing");
});

const hasCode = (code) => (error) =>
  Boolean(error) && error.code === code;

const openSession = (timeoutMs) =>
  HiddenBrowserSession.open({
    partition: "browser-session-smoke",
    timeoutMs,
    pollIntervalMs: 25,
  });

const run = async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;

  const ok = await openSession(5000);
  try {
    await ok.navigate(base + "/ok");
    assert.equal(await ok.detectCloudflare(), false);
    await ok.waitForSelector("#ready");
    assert.match(await ok.readHtml(), /id="ready"/);
    assert.equal(
      await ok.evaluate("document.querySelector('#ready').textContent"),
      "ready"
    );
  } finally {
    ok.close();
  }
  assert.equal(BrowserWindow.getAllWindows().length, 0);

  const blocked = await openSession(2000);
  try {
    await blocked.navigate(base + "/cloudflare");
    assert.equal(await blocked.detectCloudflare(), true);
    await assert.rejects(blocked.waitForSelector("#ready"), hasCode("BLOCKED"));
  } finally {
    blocked.close();
  }
  assert.equal(BrowserWindow.getAllWindows().length, 0);

  const timedOut = await openSession(1500);
  try {
    await timedOut.navigate(base + "/slow");
    await assert.rejects(timedOut.waitForSelector("#ready"), hasCode("TIMEOUT"));
  } finally {
    timedOut.close();
  }
  assert.equal(BrowserWindow.getAllWindows().length, 0);

  console.log(JSON.stringify({ browserSession: "passed" }));
};

app.whenReady().then(async () => {
  try {
    await run();
    server.close();
    app.quit();
  } catch (error) {
    console.error(error);
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    server.close();
    app.exit(1);
  }
});
`;

try {
  await build({
    configFile: false,
    logLevel: "silent",
    build: {
      lib: {
        entry: path.join(
          root,
          "src/main/services/source-fetch/browser-session.ts"
        ),
        formats: ["cjs"],
        fileName: () => "browser-session.cjs",
      },
      outDir: workDir,
      emptyOutDir: false,
      rollupOptions: { external: ["electron"] },
      ssr: true,
    },
  });

  const main = path.join(workDir, "smoke.cjs");
  await writeFile(main, smokeMain);

  const { stdout, stderr } = await execFileAsync(electronPath, [main], {
    cwd: root,
    timeout: 90_000,
    windowsHide: true,
  });

  process.stdout.write(stdout);
  process.stderr.write(stderr);
  assert.match(stdout, /"browserSession":"passed"/);
} finally {
  await rm(workDir, { recursive: true, force: true });
}
