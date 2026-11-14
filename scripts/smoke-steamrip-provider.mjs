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
const { app } = require("electron");

process.on("uncaughtException", (error) => {
  console.error(error);
  app.exit(1);
});

const { steamripProvider } = require("./steamrip.cjs");

app.disableHardwareAcceleration();
app.on("window-all-closed", () => undefined);

const games = [
  { title: "ELDEN RING", appId: 1245620, expect: ["gofile", "buzzheavier", "fileditch"] },
  { title: "Marvel's Spider-Man Remastered", appId: 1817070, expect: ["gofile", "buzzheavier"] },
  { title: "Dead Space", appId: 1693980, expect: ["buzzheavier"] },
];

const repeatedGames = [
  { title: "Prison Architect", expect: ["gofile"] },
  { title: "BOXROOM", expect: ["buzzheavier", "fileditch"] },
];

const logger = { debug() {}, info() {}, warn() {}, error() {} };

const run = async () => {
  const report = [];

  const runGame = async (game, requestId) => {
    const request = {
      requestId,
      shop: "steam",
      objectId: game.appId ? String(game.appId) : "smoke",
      title: game.title,
      ...(game.appId ? { steamAppId: game.appId } : {}),
    };
    const signal = new AbortController().signal;
    const ctx = {
      signal,
      fetch: globalThis.fetch,
      logger,
      requestId,
    };

    const hits = await steamripProvider.search(request, ctx);
    const repacks = [];

    for (const hit of hits) {
      const links = await steamripProvider.scrape(hit, ctx);
      if (links.length === 0) continue;

      repacks.push({
        title: hit.title,
        build: hit.build ?? null,
        size: hit.size ?? null,
        hosters: [...new Set(links.map((link) => link.hosterId))],
        links: links.length,
        parts: links.map((link) => link.parts?.length ?? 1),
      });
    }

    assert.equal(repacks.length, 1, game.title + " did not resolve to one repack");
    const hosters = repacks[0].hosters;
    for (const hoster of game.expect) {
      assert.ok(hosters.includes(hoster), game.title + " is missing " + hoster);
    }

    report.push({
      game: game.title,
      requestId,
      hits: hits.length,
      repacks,
    });
    console.log("SMOKE " + JSON.stringify(report[report.length - 1]));
  };

  for (const game of games) {
    await runGame(game, "smoke-" + String(game.appId));
  }

  for (let pass = 1; pass <= 2; pass += 1) {
    for (const game of repeatedGames) {
      await runGame(game, "smoke-repeat-" + pass + "-" + game.title.replaceAll(" ", "-"));
    }
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
