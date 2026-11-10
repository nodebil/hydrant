import assert from "node:assert/strict";
import test from "node:test";
import {
  extractSteamAppId,
  isConfidentMatch,
  normalizeTitle,
  scoreTitleMatch,
} from "./source-matching.js";

test("normalizeTitle removes punctuation, editions, builds, and release years", () => {
  assert.equal(normalizeTitle("ELDEN RING"), "elden ring");
  assert.equal(
    normalizeTitle("Marvel's Spider-Man Remastered"),
    "marvels spider man"
  );
  assert.equal(normalizeTitle("Dead Space (2023)"), "dead space");
  assert.equal(normalizeTitle("ELDEN RING Deluxe Edition"), "elden ring");
  assert.equal(normalizeTitle("ELDEN RING Build-23850278"), "elden ring");
  assert.equal(
    normalizeTitle("The Witcher 3: Wild Hunt"),
    "witcher 3 wild hunt"
  );
  assert.equal(normalizeTitle("Pokémon™ Scarlet"), "pokemon scarlet");
  assert.equal(normalizeTitle("Battlefield 2042"), "battlefield 2042");
  assert.equal(normalizeTitle(""), "");
});

test("scoreTitleMatch ignores editions, punctuation, and Unicode variants", () => {
  assert.equal(
    scoreTitleMatch("Marvel's Spider-Man Remastered", "Marvels Spider Man"),
    1
  );
  assert.equal(scoreTitleMatch("Pokémon Scarlet", "Pokemon Scarlet"), 1);
  assert.equal(scoreTitleMatch("ELDEN RING Deluxe Edition", "Elden Ring"), 1);
  assert.equal(scoreTitleMatch("Dead Space (2023)", "Dead Space"), 1);
  assert.equal(
    scoreTitleMatch("Battlefield 2042", "Battlefield 2042 (2021)"),
    1
  );
});

test("scoreTitleMatch rejects extra title tokens", () => {
  assert.equal(scoreTitleMatch("Elden Ring", "Elden Ring Nightreign"), 0.6667);
  assert.equal(scoreTitleMatch("Hades II", "Hades"), 0.5);
  assert.equal(scoreTitleMatch("Battlefield 2042", "Battlefield"), 0);
  assert.equal(
    scoreTitleMatch(
      "Call of Duty Modern Warfare",
      "Call of Duty Modern Warfare 2"
    ),
    0
  );
  assert.equal(
    scoreTitleMatch("The Witcher 3", "The Witcher 3 Wild Hunt"),
    0.5
  );
});

test("scoreTitleMatch rejects conflicting release years", () => {
  assert.equal(scoreTitleMatch("Dead Space (2023)", "Dead Space (2008)"), 0);
  assert.equal(scoreTitleMatch("Dead Space (2008)", "Dead Space (2023)"), 0);
  assert.equal(scoreTitleMatch("Dead Space (2023)", "Dead Space (2023)"), 1);
});

test("scoreTitleMatch handles empty and unrelated titles", () => {
  assert.equal(scoreTitleMatch("", "Elden Ring"), 0);
  assert.equal(scoreTitleMatch("Elden Ring", ""), 0);
  assert.equal(scoreTitleMatch("Elden Ring", "Hades"), 0);
});

test("isConfidentMatch accepts known variants and rejects false positives", () => {
  assert.equal(isConfidentMatch("ELDEN RING", "Elden Ring"), true);
  assert.equal(
    isConfidentMatch("Marvel's Spider-Man Remastered", "Marvel's Spider-Man"),
    true
  );
  assert.equal(
    isConfidentMatch("Dead Space (2023)", "Dead Space (2023)"),
    true
  );
  assert.equal(isConfidentMatch("Pokémon Scarlet", "Pokemon Scarlet"), true);

  assert.equal(isConfidentMatch("Elden Ring", "Elden Ring Nightreign"), false);
  assert.equal(
    isConfidentMatch("Dead Space (2023)", "Dead Space (2008)"),
    false
  );
  assert.equal(isConfidentMatch("Hades II", "Hades"), false);
  assert.equal(
    isConfidentMatch(
      "Call of Duty Modern Warfare",
      "Call of Duty Modern Warfare 2"
    ),
    false
  );
  assert.equal(isConfidentMatch("Elden Ring", ""), false);
  assert.equal(isConfidentMatch("Elden Ring", "Elden Ring", 0.9), true);
  assert.equal(
    isConfidentMatch("Elden Ring", "Elden Ring Nightreign", 0.6),
    true
  );
});

test("extractSteamAppId reads Steam store, community, protocol, and query URLs", () => {
  assert.equal(
    extractSteamAppId("https://store.steampowered.com/app/1245620/ELDEN_RING/"),
    1245620
  );
  assert.equal(
    extractSteamAppId("https://steamcommunity.com/app/1245620"),
    1245620
  );
  assert.equal(extractSteamAppId("steam://rungameid/1245620"), 1245620);
  assert.equal(
    extractSteamAppId("https://example.com/?appid=1245620"),
    1245620
  );
  assert.equal(
    extractSteamAppId("https://example.com/?steamAppId=1245620"),
    1245620
  );
  assert.equal(
    extractSteamAppId("https://store.steampowered.com/app/0/"),
    undefined
  );
  assert.equal(
    extractSteamAppId(
      "https://store.steampowered.com/app/99999999999999999999/"
    ),
    undefined
  );
  assert.equal(extractSteamAppId("Elden Ring"), undefined);
  assert.equal(extractSteamAppId(""), undefined);
  assert.equal(extractSteamAppId(null), undefined);
});
