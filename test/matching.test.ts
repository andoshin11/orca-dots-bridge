import { expect, test } from "vite-plus/test";
import {
  aliasMatches,
  editDistance,
  matchFields,
  matchToken,
  normalizeForMatch,
  rankMatches,
} from "../src/matching.js";
import { queryTokens } from "../src/service.js";

test("normalizes width, case, kana and separators", () => {
  expect(normalizeForMatch("ＯＲＣＡ-dots_Bridge.v2")).toBe("orcadotsbridgev2");
  expect(normalizeForMatch("デバッグ バードジ")).toBe("でばっぐばーどじ");
  // Half-width katakana becomes full-width first, then hiragana.
  expect(normalizeForMatch("ﾃﾞﾊﾞｯｸﾞ")).toBe("でばっぐ");
  expect(normalizeForMatch(" - _ . ")).toBe("");
});

test("Damerau-Levenshtein counts a transposition as one edit and stops early", () => {
  expect(editDistance("birdge", "bridge", 1)).toBe(1);
  expect(editDistance("bridge", "bridge", 1)).toBe(0);
  expect(editDistance("brige", "bridge", 1)).toBe(1);
  expect(editDistance("bridges", "brdg", 1)).toBe(2);
  expect(editDistance("orcadotsbirdge", "orcadotsbridge", 2)).toBe(1);
  expect(editDistance("debug", "review", 2)).toBe(3);
});

test("splits unspaced Japanese from Latin words and drops particles", () => {
  expect(queryTokens("orca-dots-bridgeのdebug")).toEqual(["orca-dots-bridge", "debug"]);
  expect(queryTokens("ＤＥＢＵＧのワークスペースは？")).toEqual(["debug", "ワークスペースは"]);
  expect(queryTokens("the debug birdge workspace")).toEqual(["debug", "birdge", "workspace"]);
});

test("matches a token exactly, as a substring or within a small edit distance", () => {
  const fields = matchFields(["orca-dots-bridge", "debug-birdge", "デバッグ用の修正"]);
  expect(matchToken("bridge", fields, true)).toBe("exact");
  expect(matchToken("Debug-Birdge", fields, true)).toBe("exact");
  expect(matchToken("dots-bri", fields, true)).toBe("substring");
  // Hiragana from speech matches a katakana title.
  expect(matchToken("でばっぐ", fields, true)).toBe("substring");
  // A Japanese token that contains a whole field also counts.
  expect(matchToken("デバッグ用の修正のやつ", fields, true)).toBe("substring");
  expect(matchToken("brigde", fields, true)).toBe("fuzzy");
  expect(matchToken("brigde", fields, false)).toBeNull();
  // Short words get no edits; long words get two.
  expect(matchToken("dbg", fields, true)).toBeNull();
  expect(matchToken("orcadotsbirdgx", fields, true)).toBe("fuzzy");
  expect(matchToken("reviewer", fields, true)).toBeNull();
});

test("an alias matches a whole token or appears inside the query", () => {
  expect(aliasMatches("でばっぐ", "デバッグ", ["デバッグ"])).toBe(true);
  expect(aliasMatches("でばっぐ", "デバッグの状態", ["デバッグの状態"])).toBe(true);
  expect(aliasMatches("my bridge", "My-Bridge", ["my-bridge"])).toBe(true);
  expect(aliasMatches("でばっぐ", "main", ["main"])).toBe(false);
});

test("ranks alias over exact over substring over fuzzy; fuzzy is only a fallback", () => {
  const items = [
    { id: "repo-main", fields: ["orca-dots-bridge", "main"], aliases: [] },
    { id: "debug", fields: ["orca-dots-bridge", "debug-birdge"], aliases: [] },
    { id: "other", fields: ["other-app", "feature"], aliases: ["ふぃーちゃー"] },
  ];
  const rank = (query: string) =>
    rankMatches(
      items,
      query,
      queryTokens(query),
      (i) => matchFields(i.fields),
      (i) => i.aliases,
    ).map((m) => [m.item.id, m.matchedBy]);
  // "birdge" matches the debug workspace exactly, so bridge's fuzzy match is ignored.
  expect(rank("birdge")).toEqual([["debug", "exact"]]);
  // Nothing matches "brigde" exactly: every bridge workspace matches fuzzily.
  expect(rank("brigde")).toEqual([
    ["repo-main", "fuzzy"],
    ["debug", "fuzzy"],
  ]);
  expect(rank("フィーチャー")).toEqual([["other", "alias"]]);
  expect(rank("dots")).toEqual([
    ["repo-main", "exact"],
    ["debug", "exact"],
  ]);
  expect(rank("ebug")).toEqual([["debug", "substring"]]);
  expect(rank("nothing-like-this")).toEqual([]);
});
