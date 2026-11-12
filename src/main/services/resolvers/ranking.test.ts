import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SourceGameRepack, SourcePreferences } from "@types";
import { DEFAULT_SOURCE_PREFERENCES } from "../../../shared/source-providers.js";
import { rankSourceCandidates, type SourceCandidate } from "./ranking.js";

const makeRepack = (slug: string): SourceGameRepack => ({
  id: `provider:test:${slug}`,
  title: slug,
  fileSize: null,
  uris: [`https://files.example/${slug}`],
  unavailableUris: [],
  uploadDate: null,
  downloadSourceId: "provider:test",
  downloadSourceName: "Test",
  createdAt: "2026-11-12T00:00:00.000Z",
});

const makeCandidate = (
  slug: string,
  overrides: Partial<Omit<SourceCandidate, "repack">> = {}
): SourceCandidate => ({
  providerId: "provider-a",
  providerPriority: 10,
  confidence: 1,
  buildMatch: false,
  hosterIds: [],
  ...overrides,
  repack: makeRepack(slug),
});

const withPreferences = (
  overrides: Partial<SourcePreferences> = {}
): SourcePreferences => ({ ...DEFAULT_SOURCE_PREFERENCES, ...overrides });

const titles = (candidates: { repack: SourceGameRepack }[]) =>
  candidates.map((candidate) => candidate.repack.title);

describe("source candidate ranking", () => {
  it("orders by confidence before provider and hoster preferences", () => {
    const ranked = rankSourceCandidates(
      [
        makeCandidate("confident", {
          confidence: 0.9,
          hosterIds: ["slow.example"],
        }),
        makeCandidate("weak", {
          confidence: 0.8,
          hosterIds: ["fast.example"],
        }),
      ],
      withPreferences({ hosterPriority: ["fast.example"] })
    );

    assert.deepEqual(titles(ranked), ["confident", "weak"]);
  });

  it("breaks equal confidence with a build match", () => {
    const ranked = rankSourceCandidates([
      makeCandidate("plain", { confidence: 0.8 }),
      makeCandidate("build", { confidence: 0.8, buildMatch: true }),
    ]);

    assert.deepEqual(titles(ranked), ["build", "plain"]);
  });

  it("uses explicit provider priority before registry priority", () => {
    const ranked = rankSourceCandidates(
      [
        makeCandidate("registry", {
          providerId: "provider-a",
          providerPriority: 1,
        }),
        makeCandidate("preferred", {
          providerId: "provider-b",
          providerPriority: 50,
        }),
      ],
      withPreferences({ providerPriority: ["provider-b"] })
    );

    assert.deepEqual(titles(ranked), ["preferred", "registry"]);
  });

  it("keeps registry priority for providers that are not listed", () => {
    const ranked = rankSourceCandidates([
      makeCandidate("second", {
        providerId: "provider-b",
        providerPriority: 20,
      }),
      makeCandidate("first", {
        providerId: "provider-a",
        providerPriority: 10,
      }),
    ]);

    assert.deepEqual(titles(ranked), ["first", "second"]);
  });

  it("uses the best preferred hoster on a repack", () => {
    const ranked = rankSourceCandidates(
      [
        makeCandidate("unlisted", { hosterIds: ["buzzheavier.example"] }),
        makeCandidate("preferred", {
          hosterIds: ["buzzheavier.example", "gofile.example"],
        }),
      ],
      withPreferences({ hosterPriority: ["gofile.example"] })
    );

    assert.deepEqual(titles(ranked), ["preferred", "unlisted"]);
  });

  it("falls back to resolver priority for hosters not in preferences", () => {
    const ranked = rankSourceCandidates(
      [
        makeCandidate("slow", { hosterIds: ["slow.example"] }),
        makeCandidate("fast", { hosterIds: ["fast.example"] }),
      ],
      DEFAULT_SOURCE_PREFERENCES,
      { "slow.example": 50, "fast.example": 10 }
    );

    assert.deepEqual(titles(ranked), ["fast", "slow"]);
  });

  it("ranks hosters without a resolver after registered ones", () => {
    const ranked = rankSourceCandidates(
      [
        makeCandidate("unknown", { hosterIds: ["unknown.example"] }),
        makeCandidate("known", { hosterIds: ["known.example"] }),
      ],
      DEFAULT_SOURCE_PREFERENCES,
      { "known.example": 5 }
    );

    assert.deepEqual(titles(ranked), ["known", "unknown"]);
  });

  it("returns a deterministic order for fully tied candidates", () => {
    const candidates = [makeCandidate("b"), makeCandidate("a")];

    assert.deepEqual(titles(rankSourceCandidates(candidates)), ["a", "b"]);
    assert.deepEqual(titles(rankSourceCandidates([...candidates].reverse())), [
      "a",
      "b",
    ]);
  });

  it("reports the score components for the default preferences", () => {
    const [ranked] = rankSourceCandidates([
      makeCandidate("one", { confidence: 0.85, buildMatch: true }),
    ]);

    assert.equal(ranked.score, 950_000);
    assert.equal(ranked.confidence, 0.85);
    assert.equal(ranked.buildMatch, true);
    assert.equal(ranked.hosterRank, 0);
    assert.equal(ranked.providerId, "provider-a");
  });
});
