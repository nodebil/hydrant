// Local-only live smoke for the GameBounty provider.
// Usage: node scripts/smoke-gamebounty-provider.mjs
// Fetches live GameBounty JSON in memory and prints a JSON report.
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
const workDir = await mkdtemp(path.join(cacheDir, "gamebounty-smoke-"));

const games = [
  {
    title: "ELDEN RING",
    appId: 1245620,
    build: "25827938",
    size: "67.5 GB",
    hosters: ["vikingfile", "fileditch"],
    groups: 2,
  },
  {
    title: "Marvel's Spider-Man Remastered",
    appId: 1817070,
    build: "23986256",
    size: "69.4 GB",
    hosters: ["fileditch"],
    groups: 1,
  },
  {
    title: "Dead Space",
    appId: 1693980,
    build: "10602756",
    size: "34.4 GB",
    hosters: ["vikingfile", "fileditch", "gofile"],
    groups: 3,
  },
  {
    title: "Prison Architect",
    appId: 233450,
    build: "10630057",
    size: "764.6 MB",
    hosters: ["vikingfile", "pixeldrain", "datanodes", "gofile"],
    groups: 0,
  },
  {
    title: "BOXROOM",
    appId: 4335460,
    build: "26564418",
    size: "2.4 GB",
    hosters: ["vikingfile", "fileditch"],
    groups: 0,
  },
];

const noop = () => undefined;
const logger = { debug: noop, info: noop, warn: noop, error: noop };

const requests = [];

const fetchPage = async (input, init) => {
  const href =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const url = new URL(href);
  assert.equal(
    url.hostname,
    "gamebounty.world",
    "off-host request: " + url.href
  );

  requests.push(url.pathname + url.search);

  const response = await fetch(url, {
    ...init,
    redirect: "follow",
    headers: {
      "user-agent": SOURCE_USER_AGENT,
      accept: "application/json",
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
        entry: path.join(root, "src/main/services/providers/gamebounty.ts"),
        formats: ["cjs"],
        fileName: () => "gamebounty.cjs",
      },
      outDir: workDir,
      emptyOutDir: false,
      rollupOptions: { external: ["jsdom"] },
      ssr: true,
    },
  });

  const { gamebountyProvider, buildGameBountySearchUrl } = await import(
    pathToFileURL(path.join(workDir, "gamebounty.cjs")).href
  );

  const report = [];

  for (const game of games) {
    const requestId = "smoke-" + game.appId;
    const request = {
      requestId,
      shop: "steam",
      objectId: String(game.appId),
      title: game.title,
      steamAppId: game.appId,
    };
    const ctx = {
      signal: new AbortController().signal,
      fetch: fetchPage,
      logger,
      requestId,
    };

    requests.length = 0;
    const hits = await gamebountyProvider.search(request, ctx);

    assert.ok(hits.length >= 1, game.title + " returned no hits");

    const repacks = [];

    for (const hit of hits) {
      const links = await gamebountyProvider.scrape(hit, ctx);
      if (links.length === 0) continue;

      for (const link of links) {
        if (link.parts) {
          assert.equal(
            link.url,
            link.parts[0],
            "first part is not the link URL"
          );
        }
      }

      repacks.push({
        title: hit.title,
        build: hit.build ?? null,
        size: hit.size ?? null,
        hosters: links.map((link) => link.hosterId),
        links: links.map((link) =>
          link.parts
            ? {
                hoster: link.hosterId,
                parts: link.parts.length,
                first: link.parts[0].split("/").pop(),
              }
            : { hoster: link.hosterId, parts: 1 }
        ),
        groups: links.filter((link) => link.parts).length,
      });
    }

    assert.ok(repacks.length >= 1, game.title + " resolved to no repacks");

    const repack = repacks[0];
    const hosters = [...new Set(repacks.flatMap((item) => item.hosters))];

    assert.equal(repack.build, game.build);
    assert.equal(repack.size, game.size);
    assert.equal(repack.groups, game.groups);

    for (const hoster of game.hosters) {
      assert.ok(hosters.includes(hoster), game.title + " is missing " + hoster);
    }

    for (const link of repacks.flatMap((item) => item.links)) {
      if (link.hoster === "fileditch" && link.parts > 1) {
        assert.match(
          link.first,
          /part0*1\.rar$/i,
          "fileditch parts are not ordered from part1"
        );
      }
    }

    const expectedPostRequests = hits.length;

    assert.ok(
      requests.some((requestPath) => requestPath.startsWith("/api/v1/search?")),
      "search endpoint was not requested"
    );
    assert.ok(
      requests.some((requestPath) => requestPath.startsWith("/api/v1/posts/")),
      "post endpoint was not requested"
    );
    assert.equal(
      requests.length,
      1 + expectedPostRequests,
      "unexpected requests: " + requests.join(", ")
    );

    report.push({
      game: game.title,
      appId: game.appId,
      searchUrl: buildGameBountySearchUrl(game.title),
      hits: hits.length,
      requests: [...requests],
      repacks,
    });
    console.log("SMOKE " + JSON.stringify(report[report.length - 1]));
  }

  const missRequest = {
    requestId: "smoke-no-match",
    shop: "steam",
    objectId: "0",
    title: "definitely-not-a-game-on-gamebounty",
  };
  requests.length = 0;
  const missHits = await gamebountyProvider.search(missRequest, {
    signal: new AbortController().signal,
    fetch: fetchPage,
    logger,
    requestId: missRequest.requestId,
  });

  assert.deepEqual(missHits, [], "a nonsense title returned hits");
  assert.equal(requests.length, 1, "no-match search made extra requests");

  report.push({
    game: missRequest.title,
    search: "no-match",
    requests: [...requests],
    hits: missHits.length,
  });
  console.log("SMOKE " + JSON.stringify(report[report.length - 1]));

  console.log("RESULT " + JSON.stringify({ gamebounty: "passed", report }));
} finally {
  await rm(workDir, { recursive: true, force: true });
}
