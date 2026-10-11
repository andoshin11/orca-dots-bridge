// Name matching that tolerates speech recognition: spacing, punctuation, width, case,
// katakana vs hiragana, Japanese written without spaces and small Latin typos.

/** How a candidate matched a query, strongest first. */
export type MatchKind = "alias" | "exact" | "substring" | "fuzzy";
const strength: Record<Exclude<MatchKind, "alias">, number> = {
  exact: 3,
  substring: 2,
  fuzzy: 1,
};

/**
 * Canonical form for comparing names: NFKC (full-width → ASCII, half-width kana →
 * full-width), lowercase, katakana → hiragana, and no spaces, hyphens, underscores or dots.
 */
export function normalizeForMatch(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/gu, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s\-_.]+/gu, "");
}

/** Latin/digit words of a field (`orca-dots-bridge` → orca, dots, bridge). */
function latinWords(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((w) => w.length > 0);
}

const latin = /^[a-z0-9]+$/u;

/**
 * Damerau-Levenshtein distance (optimal string alignment), or `max + 1` as soon as it
 * is known to exceed `max`. Inputs are short query/field words.
 */
export function editDistance(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length > 64 || b.length > 64) return a === b ? 0 : max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d = Math.min(d, prev2[j - 2]! + 1);
      row.push(d);
      best = Math.min(best, d);
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length]!;
}

/** Edits allowed for a Latin query word: none below 4 letters, 1 from 4, 2 from 8. */
const allowedEdits = (word: string) => (word.length >= 8 ? 2 : word.length >= 4 ? 1 : 0);

/** The fields of one candidate, prepared once. */
export type MatchFields = { whole: string[]; words: Set<string> };
export function matchFields(values: readonly (string | null | undefined)[]): MatchFields {
  const present = values.filter((v): v is string => typeof v === "string" && v.length > 0);
  return {
    whole: present.map(normalizeForMatch).filter((v) => v.length > 0),
    words: new Set(present.flatMap(latinWords)),
  };
}

/**
 * How one query token matches a candidate's fields, or null. A token with Japanese text
 * also matches when it contains a whole field (「でばっぐのやつ」 ⊇ 「でばっぐ」).
 */
export function matchToken(token: string, fields: MatchFields, fuzzy: boolean): MatchKind | null {
  const q = normalizeForMatch(token);
  if (!q) return null;
  if (fields.words.has(q) || fields.whole.includes(q)) return "exact";
  if (fields.whole.some((f) => f.includes(q))) return "substring";
  if (!latin.test(q) && fields.whole.some((f) => f.length >= 3 && q.includes(f)))
    return "substring";
  if (!fuzzy || !latin.test(q)) return null;
  const max = allowedEdits(q);
  if (max === 0) return null;
  for (const word of [...fields.words, ...fields.whole.filter((f) => latin.test(f))])
    if (editDistance(q, word, max) <= max) return "fuzzy";
  return null;
}

/** True when an alias is named by the whole query or by one of its tokens. */
export function aliasMatches(alias: string, query: string, tokens: readonly string[]) {
  const a = normalizeForMatch(alias);
  if (!a) return false;
  if (tokens.some((t) => normalizeForMatch(t) === a)) return true;
  return a.length >= 2 && normalizeForMatch(query).includes(a);
}

export type Scored<T> = T & { matchedBy: MatchKind };

/**
 * Keeps the candidates that best match a query. Per token, a fuzzy match counts only
 * when no candidate matches that token exactly or as a substring. Candidates named by an
 * alias win; otherwise those matching the most tokens are kept, ordered by match strength
 * (stable for ties). `matchedBy` is "alias", or the weakest way a kept token matched.
 */
export function rankMatches<T>(
  items: readonly T[],
  query: string,
  tokens: readonly string[],
  fieldsOf: (item: T) => MatchFields,
  aliasesOf: (item: T) => readonly string[],
): { item: T; matchedBy: MatchKind; alias: string | null }[] {
  const prepared = items.map((item) => ({
    item,
    fields: fieldsOf(item),
    alias: aliasesOf(item).find((a) => aliasMatches(a, query, tokens)) ?? null,
  }));
  const levels = prepared.map((p) => tokens.map((t) => matchToken(t, p.fields, true)));
  // A token some candidate matches strictly never falls back to fuzzy matching.
  const strict = tokens.map((_, i) => levels.some((l) => l[i] === "exact" || l[i] === "substring"));
  const scored = prepared.map((p, n) => {
    const kinds = levels[n]!.map((k, i) => (k === "fuzzy" && strict[i] ? null : k)).filter(
      (k): k is Exclude<MatchKind, "alias"> => k !== null,
    );
    return {
      ...p,
      count: kinds.length,
      sum: kinds.reduce((s, k) => s + strength[k], 0),
      weakest: kinds.reduce<Exclude<MatchKind, "alias"> | null>(
        (w, k) => (w === null || strength[k] < strength[w] ? k : w),
        null,
      ),
    };
  });
  const aliased = scored.filter((s) => s.alias !== null);
  let kept: typeof scored;
  if (aliased.length) kept = aliased;
  else {
    const best = Math.max(0, ...scored.map((s) => s.count));
    kept = best === 0 ? [] : scored.filter((s) => s.count === best);
  }
  return kept
    .map((s, order) => ({ s, order }))
    .sort((a, b) => b.s.sum - a.s.sum || a.order - b.order)
    .map(({ s }) => ({
      item: s.item,
      matchedBy: s.alias !== null ? ("alias" as const) : s.weakest!,
      alias: s.alias,
    }));
}
