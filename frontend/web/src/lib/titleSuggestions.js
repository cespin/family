// Earlier expense titles offered while a title is typed. Matching ignores case and accents, so
// "nunoa" finds "Ñuñoa", and the typed text must begin a word of the title.

const DEFAULT_MAX = 5;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

/** A title as it is compared: no accents, lower case, and single spaces. */
export function normalizeTitle(text) {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Where `query` sits in `title` at the start of a word, or -1. A word starts at the beginning of
 * the title or after any character that is not a letter or digit, such as a space, "(" or ".".
 */
function wordStartIndex(title, query) {
  let index = title.indexOf(query);
  while (index !== -1) {
    if (index === 0 || !WORD_CHARACTER.test(title[index - 1])) return index;
    index = title.indexOf(query, index + 1);
  }
  return -1;
}

/**
 * Up to `max` distinct titles from `entries` that match `query`. `entries` are `{ title }` newest
 * first, as the API lists expenses, so a title typed several ways keeps its newest spelling. Titles
 * that start with the query come first, then the newest. A title the query already equals is left
 * out, since picking it would change nothing.
 */
export function titleSuggestions(entries, query, { max = DEFAULT_MAX } = {}) {
  const wanted = normalizeTitle(query);
  if (!wanted) return [];

  const seen = new Set();
  const matches = [];
  for (const { title } of entries) {
    const normalized = normalizeTitle(title ?? '');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    if (normalized === wanted) continue;
    const index = wordStartIndex(normalized, wanted);
    if (index !== -1) matches.push({ title: title.trim(), atStart: index === 0 });
  }

  // The sort is stable, so each half keeps the newest-first order.
  matches.sort((a, b) => Number(b.atStart) - Number(a.atStart));
  return matches.slice(0, max).map((match) => match.title);
}
