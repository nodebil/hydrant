// Local-only live smoke for the SteamGG provider.
// Usage: node scripts/smoke-steamgg-provider.mjs
// Fetches live SteamGG pages in memory and prints a JSON report.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = path.join(root, "node_modules", ".cache");
const SOURCE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0";

await mkdir(cacheDir, { recursive: true });
// Keep the bundle under the repo so its external jsdom resolves from node_modules.
const workDir = await mkdtemp(path.join(cacheDir, "steamgg-smoke-"));

const games = [
  {
    title: "ELDEN RING",
    appId: 1245620,
    expect: ["gofile", "datanodes", "akirabox", "filekeeper"],
  },
  {
    title: "Marvel's Spider-Man Remastered",
    appId: 1817070,
    expect: ["datanodes", "akirabox", "filekeeper"],
  },
  {
    title: "Dead Space",
    appId: 1693980,
    minRepacks: 2,
    expect: [
      "pixeldrain",
      "datanodes",
      "akirabox",
      "rootz",
      "vikingfile",
      "buzzheavier",
    ],
  },
  {
    title: "Prison Architect",
    expect: ["pixeldrain", "akirabox", "buzzheavier"],
  },
];

const noop = () => undefined;
const logger = { debug: noop, info: noop, warn: noop, error: noop };

const fetchPage = async (input, init) => {
  const href =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const url = new URL(href);
  assert.equal(url.hostname, "steamgg.net", "off-host request: " + url.href);

  const response = await fetch(url, {
    ...init,
    redirect: "follow",
    headers: {
      "user-agent": SOURCE_USER_AGENT,
      accept: "*/*",
    },
  });

  assert.ok(response.ok, url.pathname + " returned " + String(response.status));

  return response;
};

try {
  await build({
    configFile: false,
    logLevel: "silent",
    build: {
      lib: {
        entry: path.join(root, "src/main/services/providers/steamgg.ts"),
        formats: ["cjs"],
        fileName: () => "steamgg.cjs",
      },
      outDir: workDir,
      emptyOutDir: false,
      rollupOptions: { external: ["jsdom"] },
      ssr: true,
    },
  });

  const { steamggProvider } = await import(
    pathToFileURL(path.join(workDir, "steamgg.cjs")).href
  );

  const report = [];

  for (const game of games) {
    const requestId = "smoke-" + (game.appId ?? "no-appid");
    const request = {
      requestId,
      shop: "steam",
      objectId: game.appId ? String(game.appId) : "smoke",
      title: game.title,
      ...(game.appId ? { steamAppId: game.appId } : {}),
    };
    const ctx = {
      signal: new AbortController().signal,
      fetch: fetchPage,
      logger,
      requestId,
    };

    const hits = await steamggProvider.search(request, ctx);
    const repacks = [];

    for (const hit of hits) {
      const links = await steamggProvider.scrape(hit, ctx);
      if (links.length === 0) continue;

      repacks.push({
        title: hit.title,
        build: hit.build ?? null,
        size: hit.size ?? null,
        hosters: [...new Set(links.map((link) => link.hosterId))],
        links: links.length,
      });
    }

    assert.ok(
      repacks.length >= (game.minRepacks ?? 1),
      game.title + " resolved to " + String(repacks.length) + " repacks"
    );

    const hosters = [...new Set(repacks.flatMap((repack) => repack.hosters))];

    for (const hoster of game.expect) {
      assert.ok(hosters.includes(hoster), game.title + " is missing " + hoster);
    }

    report.push({
      game: game.title,
      appId: game.appId ?? null,
      hits: hits.length,
      repacks,
    });
    console.log("SMOKE " + JSON.stringify(report[report.length - 1]));
  }

  console.log("RESULT " + JSON.stringify({ steamgg: "passed", report }));
} finally {
  await rm(workDir, { recursive: true, force: true });
}
