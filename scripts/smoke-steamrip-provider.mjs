// Local-only live smoke for the SteamRip provider.
// Usage: node scripts/smoke-steamrip-provider.mjs
// Fetches live SteamRip pages in memory and prints a JSON report.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import electronPath from "electron";
import { build } from "vite";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = path.join(root, "node_modules", ".cache");

await mkdir(cacheDir, { recursive: true });
// Keep the bundle under the repo so its external jsdom resolves from node_modules.
const workDir = await mkdtemp(path.join(cacheDir, "steamrip-smoke-"));

const smokeMain = `const assert = require("node:assert/strict");
const { app, BrowserWindow } = require("electron");

process.on("uncaughtException", (error) => {
  console.error(error);
  app.exit(1);
});

const { steamripProvider } = require("./steamrip.cjs");

app.disableHardwareAcceleration();
app.on("window-all-closed", () => undefined);

const SOURCE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0";

const games = [
  { title: "ELDEN RING", appId: 1245620, expect: ["gofile", "buzzheavier", "fileditch"] },
  { title: "Marvel's Spider-Man Remastered", appId: 1817070, expect: ["gofile", "buzzheavier"] },
  { title: "Dead Space (2023)", appId: 1693980, expect: ["buzzheavier"] },
  { title: "Prison Architect", appId: 233450, expect: ["gofile"] },
  { title: "BOXROOM", appId: 4335460, expect: ["buzzheavier", "fileditch"] },
];

const fallbackGames = ["ELDEN RING", "BOXROOM"];

const logger = { debug() {}, info() {}, warn() {}, error() {} };

const requestPath = (input) => {
  const href =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const url = new URL(href);
  return url.pathname + url.search;
};

const createCountingFetch = () => {
  const requests = [];
  const fetchImpl = async (input, init) => {
    const response = await fetch(input, {
      ...init,
      headers: { "user-agent": SOURCE_USER_AGENT, accept: "*/*" },
    });
    const bytes = (await response.clone().arrayBuffer()).byteLength;
    requests.push({ path: requestPath(input), status: response.status, bytes });

    return response;
  };

  return { fetch: fetchImpl, requests };
};

const makeRequest = (game) => ({
  requestId: "smoke-" + String(game.appId),
  shop: "steam",
  objectId: String(game.appId),
  title: game.title,
  steamAppId: game.appId,
});

const collectRepacks = async (hits, ctx) => {
  const repacks = [];

  for (const hit of hits) {
    const links = await steamripProvider.scrape(hit, ctx);
    if (links.length === 0) continue;

    repacks.push({
      title: hit.title,
      build: hit.build ?? null,
      size: hit.size ?? null,
      hosters: [...new Set(links.map((link) => link.hosterId))],
      links: links.flatMap((link) => (link.parts ? link.parts : [link.url])),
    });
  }

  return repacks;
};

const run = async () => {
  const report = [];
  const apiLinks = new Map();

  for (const game of games) {
    const counting = createCountingFetch();
    const ctx = {
      signal: new AbortController().signal,
      fetch: counting.fetch,
      logger,
      requestId: "smoke-api-" + String(game.appId),
    };

    const hits = await steamripProvider.search(makeRequest(game), ctx);
    const searchRequests = counting.requests.length;
    const scrapeStart = counting.requests.length;
    const repacks = await collectRepacks(hits, ctx);
    const scrapeRequests = counting.requests.length - scrapeStart;

    assert.equal(searchRequests, 1, game.title + " made " + String(searchRequests) + " API requests");
    assert.equal(scrapeRequests, 0, game.title + " re-fetched content during scrape");
    assert.ok(repacks.length >= 1, game.title + " resolved to no repacks");
    assert.equal(BrowserWindow.getAllWindows().length, 0, game.title + " left a window open");

    const hosters = [...new Set(repacks.flatMap((repack) => repack.hosters))];
    for (const hoster of game.expect) {
      assert.ok(hosters.includes(hoster), game.title + " is missing " + hoster);
    }

    apiLinks.set(
      game.title,
      repacks.flatMap((repack) => repack.links).sort()
    );
    report.push({
      game: game.title,
      search: "api",
      requests: searchRequests,
      scrapeRequests,
      bytes: counting.requests.reduce((total, request) => total + request.bytes, 0),
      hits: hits.length,
      repacks,
    });
    console.log("SMOKE " + JSON.stringify(report[report.length - 1]));
  }

  for (const title of fallbackGames) {
    const game = games.find((entry) => entry.title === title);
    const attempts = [];
    const fetchImpl = async (input) => {
      attempts.push(requestPath(input));
      throw new Error("smoke: simulated SteamRip API failure");
    };
    const ctx = {
      signal: new AbortController().signal,
      fetch: fetchImpl,
      logger,
      requestId: "smoke-browser-" + String(game.appId),
    };

    const hits = await steamripProvider.search(makeRequest(game), ctx);
    const repacks = await collectRepacks(hits, ctx);
    const links = repacks.flatMap((repack) => repack.links).sort();

    assert.equal(attempts.length, 1, title + " did not try the API exactly once");
    assert.match(attempts[0], /^\\/wp-json\\/wp\\/v2\\/posts\\?/);
    assert.ok(repacks.length >= 1, title + " resolved to no repacks through the browser");
    assert.deepEqual(links, apiLinks.get(title), title + " browser links differ from the API");
    assert.equal(BrowserWindow.getAllWindows().length, 0, title + " left a window open");

    report.push({
      game: title,
      search: "browser-fallback",
      requests: attempts,
      hits: hits.length,
      repacks,
    });
    console.log("SMOKE " + JSON.stringify(report[report.length - 1]));
  }

  console.log("RESULT " + JSON.stringify({ steamrip: "passed", report }));
};

app.whenReady().then(async () => {
  try {
    await run();
    app.quit();
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
    build: {
      lib: {
        entry: path.join(root, "src/main/services/providers/steamrip.ts"),
        formats: ["cjs"],
        fileName: () => "steamrip.cjs",
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
    timeout: 180_000,
    windowsHide: true,
  });

  process.stdout.write(stdout);
  process.stderr.write(stderr);
  assert.match(stdout, /"steamrip":"passed"/);
} finally {
  await rm(workDir, { recursive: true, force: true });
}
