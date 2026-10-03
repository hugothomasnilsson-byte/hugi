import type { Entry, HighlightSegment, ImageMeta, SearchDoc, SearchField, SearchResult, Swatch } from '../types';
import { normalizeTag } from './tags';

export interface ParsedQuery {
  raw: string;
  /** Plain words, folded (lowercase, diacritics removed). Each must match somewhere. */
  terms: string[];
  /** Quoted phrases, folded. Each must appear verbatim (folded) somewhere. */
  phrases: string[];
  /** Hashtag filters (normalised tags). The entry must carry each tag. */
  tags: string[];
  /** Words prefixed with "-" — entries containing them are excluded. */
  excluded: string[];
  /** Hex colour queries like "#c0392b" / "#fff" (only when not a known tag). */
  colours: { hex: string; rgb: [number, number, number] }[];
  /** The trailing hashtag the user is still typing (no trailing space), else null. */
  partialTag: string | null;
}

export interface SearchIndex {
  readonly size: number;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** CIE76 distance under which a swatch counts as "that colour". */
export const COLOUR_MATCH_THRESHOLD = 18;
/** Swatches covering less of the image than this never answer a hex colour query. */
export const MIN_SWATCH_WEIGHT = 0.05;

const WHOLE_WORD = 1.5;
const WORD_PREFIX = 1.2;
const SUBSTRING = 1;
/** Upper bound on the recency bonus: enough to order equal matches, too small to beat a better field. */
const RECENCY_WEIGHT = 0.25;
/** Occurrences inspected per field when looking for a better (whole-word) hit in long OCR text. */
const MAX_OCCURRENCES_PER_FIELD = 24;

// Field slots inside an indexed document, in display/importance order.
const FIELDS: readonly SearchField[] = ['title', 'tags', 'notes', 'credit', 'link', 'text', 'colour'];
const FIELD_WEIGHT: readonly number[] = [10, 8, 4, 4, 2, 3, 3];
const TITLE = 0;
const TAGS = 1;
const NOTES = 2;
const CREDIT = 3;
const LINK = 4;
const TEXT = 5;
const COLOUR = 6;
const TAG_WEIGHT = FIELD_WEIGHT[TAGS];
const COLOUR_WEIGHT = FIELD_WEIGHT[COLOUR];
/** Snippet sources in order of preference when several match equally well. */
const SNIPPET_FIELDS = [NOTES, TEXT, CREDIT, LINK] as const;
type SnippetField = NonNullable<SearchResult['snippet']>['field'];

// ---------------------------------------------------------------------------
// Folding: case-, diacritic- and whitespace-insensitive comparison form
// ---------------------------------------------------------------------------

/** Accents and invisible format characters (soft hyphen, ZWJ, BOM…) are dropped. */
const STRIP_RE = /[\p{M}\p{Cf}]/gu;
/** Letters NFKD leaves alone, plus typographic punctuation, mapped to plain forms. */
const SPECIAL_RE = /[ßæœøłđðþıς‘’‛“”‟‐-―−]/g;
const SPECIAL_FOLDS: Readonly<Record<string, string>> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ı: 'i',
  // toLowerCase() picks final sigma by context, which would make whole-string and
  // per-character folding disagree; folding it to σ keeps them identical.
  ς: 'σ',
  '‘': "'",
  '’': "'",
  '‛': "'",
  '“': '"',
  '”': '"',
  '‟': '"',
  '‐': '-',
  '‑': '-',
  '‒': '-',
  '–': '-',
  '—': '-',
  '―': '-',
  '−': '-',
};
const NON_ASCII_RE = /[^\x00-\x7f]/;
const NON_ASCII_CODE_POINT_RE = /[\ud800-\udbff][\udc00-\udfff]|[^\x00-\x7f]/g;
/** Same effect as replacing /\s+/ with " ", but leaves the common single spaces alone (much faster). */
const WS_COLLAPSE_RE = /\s{2,}|[^\S ]/g;

function foldRaw(s: string): string {
  return s
    .normalize('NFKD')
    .toLowerCase()
    .replace(STRIP_RE, '')
    .replace(SPECIAL_RE, (ch) => SPECIAL_FOLDS[ch]);
}

/**
 * The comparison form used everywhere in search: NFKD, lowercase, accents and
 * format characters removed, a few extra letter folds (ß → ss, ø → o…), and
 * whitespace runs collapsed to one space. "Café  Noir" → "cafe noir".
 *
 * Folding is local to each code point, so text that is mostly ASCII (English or
 * Swedish OCR text with the odd "å" or curly quote) folds just its non-ASCII
 * characters through a cache, which is several times faster than normalising
 * the whole string. Dense non-Latin text is faster to fold in one go.
 */
export function foldText(s: string): string {
  const first = s.search(NON_ASCII_RE);
  let folded: string;
  if (first === -1) folded = s.toLowerCase();
  else if (isDenseNonAscii(s, first)) folded = foldRaw(s);
  else folded = s.replace(NON_ASCII_CODE_POINT_RE, foldCodePoint).toLowerCase();
  return folded.replace(WS_COLLAPSE_RE, ' ');
}

/** Samples the text after its first non-ASCII character. Only affects speed, never the result. */
function isDenseNonAscii(s: string, from: number): boolean {
  const end = Math.min(s.length, from + 256);
  let count = 0;
  for (let i = from; i < end; i++) if (s.charCodeAt(i) > 0x7f) count++;
  return count * 4 > end - from;
}

const codePointFolds = new Map<string, string>();

function foldCodePoint(cp: string): string {
  let folded = codePointFolds.get(cp);
  if (folded === undefined) {
    folded = foldRaw(cp);
    if (codePointFolds.size > 8192) codePointFolds.clear();
    codePointFolds.set(cp, folded);
  }
  return folded;
}

/** Exactly the characters JavaScript's `\s` matches. */
function isWhitespace(c: number): boolean {
  return (
    c === 32 ||
    (c >= 9 && c <= 13) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

interface FoldMap {
  /** Identical to foldText(text). */
  folded: string;
  /** For every UTF-16 unit of `folded`, the index in the original text of the code point it came from. */
  starts: number[];
}

/**
 * Folds code point by code point, remembering where each folded unit came from,
 * so matches found in folded text can be mapped back even when folding changes
 * length ("ﬁ" → "fi", "ß" → "ss", "é" → "e", collapsed whitespace).
 */
function foldWithMap(text: string): FoldMap {
  const starts: number[] = [];
  const units: string[] = [];
  let lastWasSpace = false;
  for (let i = 0; i < text.length; ) {
    const c = text.charCodeAt(i);
    if (c < 0x80) {
      if (isWhitespace(c)) {
        if (!lastWasSpace) {
          units.push(' ');
          starts.push(i);
          lastWasSpace = true;
        }
      } else {
        units.push(c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : text[i]);
        starts.push(i);
        lastWasSpace = false;
      }
      i++;
      continue;
    }
    const size = c >= 0xd800 && c <= 0xdbff && isLowSurrogate(text.charCodeAt(i + 1)) ? 2 : 1;
    const folded = foldCodePoint(text.slice(i, i + size));
    for (let k = 0; k < folded.length; k++) {
      if (isWhitespace(folded.charCodeAt(k))) {
        if (lastWasSpace) continue;
        units.push(' ');
        lastWasSpace = true;
      } else {
        units.push(folded[k]);
        lastWasSpace = false;
      }
      starts.push(i);
    }
    i += size;
  }
  return { folded: units.join(''), starts };
}

function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

// ---------------------------------------------------------------------------
// Word boundaries
// ---------------------------------------------------------------------------

const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

function isWordCodePoint(cp: number): boolean {
  if (cp < 0x80) return (cp >= 97 && cp <= 122) || (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90);
  return WORD_CHAR_RE.test(String.fromCodePoint(cp));
}

function wordCharBefore(s: string, pos: number): boolean {
  if (pos <= 0) return false;
  const c = s.charCodeAt(pos - 1);
  return isWordCodePoint(isLowSurrogate(c) && pos >= 2 ? s.codePointAt(pos - 2)! : c);
}

function wordCharAt(s: string, pos: number): boolean {
  return pos < s.length && isWordCodePoint(s.codePointAt(pos)!);
}

/**
 * How good one occurrence is: whole word, word prefix or bare substring.
 * The colour field holds generated words ("ochre", "#c0392b"), where a
 * mid-word hit is noise, so there only word-initial hits count (0 = no hit)
 * and hex codes must match in full.
 */
function occurrenceQuality(s: string, pos: number, len: number, colourWords: boolean): number {
  const startsWord = !wordCharBefore(s, pos);
  const endsWord = !wordCharAt(s, pos + len);
  if (colourWords) {
    if (!startsWord) return 0;
    if (pos > 0 && s.charCodeAt(pos - 1) === 35 /* # */ && !endsWord) return 0;
  } else if (!startsWord) {
    return SUBSTRING;
  }
  return endsWord ? WHOLE_WORD : WORD_PREFIX;
}

function hasColourWord(words: string, needle: string): boolean {
  for (let p = words.indexOf(needle); p !== -1; p = words.indexOf(needle, p + 1)) {
    if (occurrenceQuality(words, p, needle.length, true) > 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Colour maths (CIE76 in CIELAB, D65). Kept local so search has no dependencies.
// ---------------------------------------------------------------------------

type Lab = [number, number, number];

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function labPivot(t: number): number {
  return t > 216 / 24389 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29;
}

function rgbToLab([r8, g8, b8]: readonly [number, number, number]): Lab {
  const r = srgbToLinear(r8);
  const g = srgbToLinear(g8);
  const b = srgbToLinear(b8);
  const x = labPivot((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
  const y = labPivot(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
  const z = labPivot((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function labDistance(a: Lab, b: Lab): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function hexToRgb(hex: string): [number, number, number] | null {
  let h = hex.replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(h)) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-f]{6}$/.test(h)) return null;
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function swatchRgb(swatch: Swatch): [number, number, number] {
  return Array.isArray(swatch.rgb) && swatch.rgb.length === 3 ? swatch.rgb : (hexToRgb(swatch.hex) ?? [0, 0, 0]);
}

/** Folded "name family #hex" — the words a plain term can match on a swatch. */
function swatchWords(swatch: Swatch): string {
  return foldText(`${swatch.name ?? ''} ${swatch.family ?? ''} ${swatch.hex ?? ''}`);
}

/** Closer and more dominant swatches rank higher; an exact, dominant match scores 4.5. */
function colourScore(distance: number, weight: number): number {
  const closeness = 1 - distance / COLOUR_MATCH_THRESHOLD;
  const prominence = Math.min(1, weight / 0.3);
  return COLOUR_WEIGHT * (1 + 0.5 * closeness) * (0.6 + 0.4 * prominence);
}

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

const QUOTE_CHARS = '"“”„«»';
const EDGE_PUNCT_RE = /^[\p{P}\p{Z}]+|[\p{P}\p{Z}]+$/gu;
const HEX_TAG_RE = /^(?:[0-9a-f]{3}|[0-9a-f]{6})$/;

/** Folds a bare word and trims surrounding punctuation ("film," → "film", "f/1.8." → "f/1.8"). */
function cleanWord(token: string): string {
  return foldText(token).replace(EDGE_PUNCT_RE, '').trim();
}

function pushUnique<T>(list: T[], value: T): void {
  if (!list.includes(value)) list.push(value);
}

function isKnownTag(tag: string, knownTags: ReadonlySet<string> | undefined, stillTyping: boolean): boolean {
  if (!knownTags) return false;
  if (knownTags.has(tag)) return true;
  // While the user is mid-way through "#facade", don't flash colour results for "#fac".
  if (stillTyping) {
    for (const known of knownTags) if (known.startsWith(tag)) return true;
  }
  return false;
}

export function parseQuery(raw: string, knownTags?: ReadonlySet<string>): ParsedQuery {
  const text = raw ?? '';
  const q: ParsedQuery = { raw: text, terms: [], phrases: [], tags: [], excluded: [], colours: [], partialTag: null };
  const n = text.length;
  // The tag carried by the most recent token, or null when that token was anything else.
  let lastTag: string | null = null;
  let i = 0;

  while (i < n) {
    while (i < n && isWhitespace(text.charCodeAt(i))) i++;
    if (i >= n) break;
    lastTag = null;

    // Quoted phrase, optionally negated: "golden hour" / -"golden hour".
    // An unclosed quote runs to the end so live typing still narrows results.
    const negated = text[i] === '-' && i + 1 < n && QUOTE_CHARS.includes(text[i + 1]);
    const quoteAt = negated ? i + 1 : i;
    if (QUOTE_CHARS.includes(text[quoteAt])) {
      let close = quoteAt + 1;
      while (close < n && !QUOTE_CHARS.includes(text[close])) close++;
      const phrase = foldText(text.slice(quoteAt + 1, close)).trim();
      if (phrase) pushUnique(negated ? q.excluded : q.phrases, phrase);
      i = close + 1;
      continue;
    }

    let end = i;
    while (end < n && !isWhitespace(text.charCodeAt(end))) end++;
    const token = text.slice(i, end);
    i = end;

    if (token[0] === '#') {
      const tag = normalizeTag(token);
      if (!tag) continue;
      const stillTyping = end === n;
      if (HEX_TAG_RE.test(tag) && !isKnownTag(tag, knownTags, stillTyping)) {
        const rgb = hexToRgb(tag)!;
        const hex = `#${tag.length === 3 ? tag[0] + tag[0] + tag[1] + tag[1] + tag[2] + tag[2] : tag}`;
        if (!q.colours.some((c) => c.hex === hex)) q.colours.push({ hex, rgb });
      } else {
        pushUnique(q.tags, tag);
        lastTag = tag;
      }
    } else if (token[0] === '-') {
      if (token.length > 1) {
        const word = cleanWord(token.slice(1));
        if (word) pushUnique(q.excluded, word);
      }
    } else {
      const word = cleanWord(token);
      if (word) pushUnique(q.terms, word);
    }
  }

  if (lastTag !== null && !isWhitespace(text.charCodeAt(n - 1))) q.partialTag = lastTag;
  return q;
}

export function isEmptyQuery(q: ParsedQuery): boolean {
  return q.terms.length === 0 && q.phrases.length === 0 && q.tags.length === 0 && q.colours.length === 0;
}

/** Terms and phrases: the strings that must appear (and get highlighted). */
function needlesOf(q: ParsedQuery): string[] {
  const needles: string[] = [];
  for (const t of q.terms) if (t) pushUnique(needles, t);
  for (const p of q.phrases) if (p) pushUnique(needles, p);
  return needles;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

interface IndexedDoc {
  entry: Entry;
  images: readonly ImageMeta[];
  /** Folded fields in FIELDS order, separated by "\n" (which folding never leaves inside a field). */
  hay: string;
  /** Exclusive end offset of each field in `hay`. */
  ends: number[];
  /** Folded entry tags. */
  tags: string[];
  /** All palette swatches, deduplicated by hex, heaviest first. */
  swatches: Swatch[];
  labs: Lab[];
}

class Index implements SearchIndex {
  constructor(
    readonly docs: readonly IndexedDoc[],
    /** Recency bonus per doc, 0 (oldest) … RECENCY_WEIGHT (newest). */
    readonly recency: Float64Array,
    readonly knownTags: ReadonlySet<string>,
  ) {}

  get size(): number {
    return this.docs.length;
  }
}

function imagesOf(doc: SearchDoc): ImageMeta[] {
  return (doc.images ?? []).filter(Boolean);
}

function joinImageText(images: readonly ImageMeta[]): string {
  let text = '';
  for (const img of images) {
    if (!img.text) continue;
    text = text ? `${text}\n${img.text}` : img.text;
  }
  return text;
}

function collectSwatches(images: readonly ImageMeta[]): Swatch[] {
  const byHex = new Map<string, Swatch>();
  for (const img of images) {
    for (const swatch of img.palette ?? []) {
      const key = (swatch.hex ?? '').toLowerCase();
      const seen = byHex.get(key);
      if (!seen || swatch.weight > seen.weight) byHex.set(key, swatch);
    }
  }
  return [...byHex.values()].sort((a, b) => b.weight - a.weight);
}

function indexDoc(doc: SearchDoc, images: ImageMeta[]): IndexedDoc {
  const { entry } = doc;
  const swatches = collectSwatches(images);
  const colourWords = new Set<string>();
  for (const s of swatches) {
    if (s.name) colourWords.add(s.name);
    if (s.family) colourWords.add(s.family);
    if (s.hex) colourWords.add(s.hex.toLowerCase());
  }
  const fields = [
    entry.title ?? '',
    (entry.tags ?? []).join(' '),
    entry.notes ?? '',
    entry.credit ?? '',
    entry.link ?? '',
    joinImageText(images),
    [...colourWords].join(' '),
  ].map(foldText);
  const ends: number[] = [];
  let offset = 0;
  for (const field of fields) {
    offset += field.length;
    ends.push(offset);
    offset += 1; // separator
  }
  return {
    entry,
    images,
    hay: fields.join('\n'),
    ends,
    tags: (entry.tags ?? []).map(foldText),
    swatches,
    labs: swatches.map((s) => rgbToLab(swatchRgb(s))),
  };
}

/**
 * Folding thousands of OCR texts is the expensive part of indexing, and the UI
 * rebuilds the index after every edit. Folded documents are therefore cached per
 * Entry object and reused while every input that feeds the index is unchanged
 * (compared by value for strings, by identity for images and palettes).
 */
const docCache = new WeakMap<Entry, { key: unknown[]; doc: IndexedDoc }>();

function cacheKey(entry: Entry, images: readonly ImageMeta[]): unknown[] {
  const key: unknown[] = [entry.title, entry.notes, entry.credit, entry.link, images.length];
  for (const tag of entry.tags ?? []) key.push(tag);
  for (const img of images) key.push(img, img.text, img.palette, img.palette?.length);
  return key;
}

function sameKey(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function buildIndex(docs: SearchDoc[]): SearchIndex {
  const indexed: IndexedDoc[] = [];
  const knownTags = new Set<string>();
  let oldest = Infinity;
  let newest = -Infinity;

  for (const doc of docs) {
    if (!doc?.entry) continue;
    const images = imagesOf(doc);
    const key = cacheKey(doc.entry, images);
    const cached = docCache.get(doc.entry);
    let item: IndexedDoc;
    if (cached && sameKey(cached.key, key)) {
      item = cached.doc;
    } else {
      item = indexDoc(doc, images);
      docCache.set(doc.entry, { key, doc: item });
    }
    indexed.push(item);
    for (const tag of doc.entry.tags ?? []) knownTags.add(tag);
    const created = doc.entry.createdAt || 0;
    if (created < oldest) oldest = created;
    if (created > newest) newest = created;
  }

  const span = newest - oldest;
  const recency = new Float64Array(indexed.length);
  if (span > 0) {
    for (let i = 0; i < indexed.length; i++) {
      recency[i] = (((indexed[i].entry.createdAt || 0) - oldest) / span) * RECENCY_WEIGHT;
    }
  }
  return new Index(indexed, recency, knownTags);
}

/** Every hashtag in the indexed library (normalised). Pass to parseQuery so "#face" stays a tag. */
export function knownTagsOf(index: SearchIndex): ReadonlySet<string> {
  return index instanceof Index ? index.knownTags : new Set<string>();
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Scratch output for scanNeedle, reused to keep the hot loop allocation-free. */
const scan = { score: 0, mask: 0 };

/**
 * Finds the best-scoring occurrence of `needle` in a document and the set of
 * fields it occurs in. Jumps field to field so long OCR text costs at most a
 * bounded number of boundary checks.
 */
function scanNeedle(doc: IndexedDoc, needle: string): void {
  const { hay, ends } = doc;
  const len = needle.length;
  let best = 0;
  let mask = 0;
  let field = 0;
  let pos = hay.indexOf(needle);
  while (pos !== -1) {
    while (pos >= ends[field]) field++;
    const fieldEnd = ends[field];
    const weight = FIELD_WEIGHT[field];
    const colourWords = field === COLOUR;
    let quality = 0;
    let seen = 0;
    while (pos !== -1 && pos < fieldEnd) {
      const q = occurrenceQuality(hay, pos, len, colourWords);
      if (q > quality) quality = q;
      // Stop early once this field can't do better, or can't beat a better field.
      if (quality === WHOLE_WORD || ++seen >= MAX_OCCURRENCES_PER_FIELD) break;
      if (quality > 0 && weight * WHOLE_WORD <= best) break;
      pos = hay.indexOf(needle, pos + 1);
    }
    if (quality > 0) {
      mask |= 1 << field;
      if (weight * quality > best) best = weight * quality;
    }
    if (pos !== -1 && pos < fieldEnd) pos = hay.indexOf(needle, fieldEnd + 1);
  }
  scan.score = best;
  scan.mask = mask;
}

function containsNeedle(doc: IndexedDoc, needle: string): boolean {
  const { hay } = doc;
  const colourStart = doc.ends[TEXT] + 1;
  for (let pos = hay.indexOf(needle); pos !== -1; pos = hay.indexOf(needle, pos + 1)) {
    if (pos < colourStart || occurrenceQuality(hay, pos, needle.length, true) > 0) return true;
  }
  return false;
}

interface CompiledQuery {
  q: ParsedQuery;
  needles: string[];
  excluded: string[];
  tagFilters: { tag: string; prefix: boolean }[];
  colours: Lab[];
}

function compile(q: ParsedQuery): CompiledQuery {
  return {
    q,
    needles: needlesOf(q),
    excluded: q.excluded.filter(Boolean),
    tagFilters: q.tags.map((tag) => ({ tag: foldText(tag), prefix: tag === q.partialTag })),
    colours: q.colours.map((c) => rgbToLab(c.rgb)),
  };
}

/** Score for a tag filter, or 0 when the document fails it. */
function tagFilterScore(doc: IndexedDoc, tag: string, prefix: boolean): number {
  let quality = 0;
  for (const t of doc.tags) {
    if (t === tag) return TAG_WEIGHT * WHOLE_WORD;
    if (prefix && t.startsWith(tag)) quality = WORD_PREFIX;
  }
  return TAG_WEIGHT * quality;
}

/** Best score for a colour query against the document's significant swatches, or 0. */
function colourQueryScore(doc: IndexedDoc, target: Lab): number {
  let best = 0;
  for (let i = 0; i < doc.swatches.length; i++) {
    const weight = doc.swatches[i].weight;
    if (!(weight >= MIN_SWATCH_WEIGHT)) continue;
    const distance = labDistance(doc.labs[i], target);
    if (distance < COLOUR_MATCH_THRESHOLD) best = Math.max(best, colourScore(distance, weight));
  }
  return best;
}

function matchedSwatches(doc: IndexedDoc, cq: CompiledQuery, colourNeedles: string[]): Swatch[] {
  const out: Swatch[] = [];
  doc.swatches.forEach((swatch, i) => {
    const byQuery =
      swatch.weight >= MIN_SWATCH_WEIGHT &&
      cq.colours.some((target) => labDistance(doc.labs[i], target) < COLOUR_MATCH_THRESHOLD);
    if (byQuery) {
      out.push(swatch);
    } else if (colourNeedles.length) {
      const words = swatchWords(swatch);
      if (colourNeedles.some((needle) => hasColourWord(words, needle))) out.push(swatch);
    }
  });
  return out;
}

function originalText(doc: IndexedDoc, field: SnippetField): string {
  switch (field) {
    case 'notes':
      return doc.entry.notes ?? '';
    case 'credit':
      return doc.entry.credit ?? '';
    case 'link':
      return doc.entry.link ?? '';
    case 'text':
      return joinImageText(doc.images);
  }
}

/**
 * Snippets are built on first read: a broad query can match thousands of
 * entries, but only the handful on screen ever show one.
 */
function makeResult(
  doc: IndexedDoc,
  score: number,
  fields: SearchField[],
  snippetField: SnippetField | null,
  swatches: Swatch[],
  q: ParsedQuery,
): SearchResult {
  let snippet: SearchResult['snippet'] | undefined = snippetField ? undefined : null;
  return {
    entry: doc.entry,
    score,
    fields,
    get snippet() {
      if (snippet === undefined) {
        const segments = makeSnippet(originalText(doc, snippetField!), q);
        snippet = segments ? { field: snippetField!, segments } : null;
      }
      return snippet;
    },
    set snippet(value) {
      snippet = value;
    },
    swatches,
  };
}

/** Picks the long-form field showing the most terms the title doesn't already show. */
function chooseSnippetField(needleMasks: number[]): SnippetField | null {
  let bestField: SnippetField | null = null;
  let bestCount = 0;
  for (const slot of SNIPPET_FIELDS) {
    let count = 0;
    for (const mask of needleMasks) {
      if (!(mask & (1 << TITLE)) && mask & (1 << slot)) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      bestField = FIELDS[slot] as SnippetField;
    }
  }
  return bestField;
}

export function search(index: SearchIndex, raw: string): SearchResult[] {
  if (!(index instanceof Index)) throw new TypeError('search() expects an index created by buildIndex()');
  const q = parseQuery(raw, index.knownTags);
  if (isEmptyQuery(q)) return [];
  const cq = compile(q);
  const { needles, excluded, tagFilters, colours } = cq;
  const needleMasks = new Array<number>(needles.length);
  const results: SearchResult[] = [];

  docs: for (let d = 0; d < index.docs.length; d++) {
    const doc = index.docs[d];
    let score = 0;
    let mask = 0;

    for (const filter of tagFilters) {
      const s = tagFilterScore(doc, filter.tag, filter.prefix);
      if (s === 0) continue docs;
      score += s;
      mask |= 1 << TAGS;
    }
    for (const target of colours) {
      const s = colourQueryScore(doc, target);
      if (s === 0) continue docs;
      score += s;
      mask |= 1 << COLOUR;
    }
    for (let k = 0; k < needles.length; k++) {
      scanNeedle(doc, needles[k]);
      if (scan.mask === 0) continue docs;
      score += scan.score;
      mask |= scan.mask;
      needleMasks[k] = scan.mask;
    }
    for (const word of excluded) {
      if (containsNeedle(doc, word)) continue docs;
    }

    const fields = FIELDS.filter((_, slot) => mask & (1 << slot));
    const colourNeedles = needles.filter((_, k) => needleMasks[k] & (1 << COLOUR));
    const swatches = mask & (1 << COLOUR) ? matchedSwatches(doc, cq, colourNeedles) : [];
    const snippetField = needles.length ? chooseSnippetField(needleMasks) : null;
    results.push(makeResult(doc, score + index.recency[d], fields, snippetField, swatches, q));
  }

  return results.sort((a, b) => b.score - a.score || b.entry.createdAt - a.entry.createdAt);
}

// ---------------------------------------------------------------------------
// Highlighting
// ---------------------------------------------------------------------------

interface RawMatch {
  /** Range in the original text. */
  start: number;
  end: number;
  /** Index into the needle list. */
  needle: number;
}

/** Every (possibly overlapping) occurrence of every needle, in original-text coordinates, sorted. */
function findMatches(text: string, needles: string[]): RawMatch[] {
  if (!text || needles.length === 0) return [];
  // Cheap rejection with the native fold before building the position map.
  const quick = foldText(text);
  if (!needles.some((needle) => quick.includes(needle))) return [];

  const { folded, starts } = foldWithMap(text);
  // End of the code point behind folded unit u, extended over anything that
  // folded to nothing (combining accents, collapsed whitespace) right after it.
  const endOf = (u: number): number => {
    let next = u + 1;
    while (next < starts.length && starts[next] === starts[u]) next++;
    return next < starts.length ? starts[next] : text.length;
  };

  const matches: RawMatch[] = [];
  needles.forEach((needle, k) => {
    for (let p = folded.indexOf(needle); p !== -1; p = folded.indexOf(needle, p + 1)) {
      matches.push({ start: starts[p], end: endOf(p + needle.length - 1), needle: k });
    }
  });
  return matches.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Union of match ranges; overlapping and touching ranges merge. */
function mergeRanges(matches: RawMatch[]): [number, number][] {
  const merged: [number, number][] = [];
  for (const m of matches) {
    const last = merged[merged.length - 1];
    if (last && m.start <= last[1]) {
      if (m.end > last[1]) last[1] = m.end;
    } else {
      merged.push([m.start, m.end]);
    }
  }
  return merged;
}

function segmentsFromRanges(text: string, ranges: [number, number][], from: number, to: number): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  let cursor = from;
  for (const [start, end] of ranges) {
    const s = Math.max(start, from);
    const e = Math.min(end, to);
    if (e <= s) continue;
    if (s > cursor) segments.push({ text: text.slice(cursor, s), match: false });
    segments.push({ text: text.slice(s, e), match: true });
    cursor = e;
  }
  if (cursor < to) segments.push({ text: text.slice(cursor, to), match: false });
  return segments;
}

export function highlight(text: string, q: ParsedQuery): HighlightSegment[] {
  const source = text ?? '';
  const matches = findMatches(source, needlesOf(q));
  if (matches.length === 0) return [{ text: source, match: false }];
  return segmentsFromRanges(source, mergeRanges(matches), 0, source.length);
}

/** Share of the snippet shown before the anchoring match. */
const SNIPPET_LEAD = 0.3;
const SNIPPET_ANCHORS = 64;

/**
 * Picks the window of `maxLen` characters that shows the most distinct query
 * words (then the most matches), preferring the earliest on ties, and returns
 * it with the anchoring match.
 */
function chooseWindow(text: string, matches: RawMatch[], maxLen: number): { from: number; to: number; anchor: RawMatch } {
  const lead = Math.floor(maxLen * SNIPPET_LEAD);
  let best = { from: 0, to: maxLen, anchor: matches[0] };
  let bestDistinct = -1;
  let bestCount = -1;
  let lo = 0;
  const anchors = Math.min(matches.length, SNIPPET_ANCHORS);
  for (let i = 0; i < anchors; i++) {
    const anchor = matches[i];
    const from = Math.max(0, Math.min(anchor.start - lead, text.length - maxLen));
    const to = Math.min(text.length, from + maxLen);
    while (lo < matches.length && matches[lo].start < from) lo++;
    let seen = 0;
    let count = 0;
    for (let j = lo; j < matches.length && matches[j].start < to; j++) {
      if (matches[j].end > to) continue;
      seen |= 1 << matches[j].needle % 31;
      count++;
    }
    const distinct = popcount(seen);
    if (distinct > bestDistinct || (distinct === bestDistinct && count > bestCount)) {
      best = { from, to, anchor };
      bestDistinct = distinct;
      bestCount = count;
    }
  }
  return best;
}

function popcount(n: number): number {
  let count = 0;
  for (let v = n; v; v &= v - 1) count++;
  return count;
}

export function makeSnippet(text: string, q: ParsedQuery, maxLen = 160): HighlightSegment[] | null {
  const needles = needlesOf(q);
  if (!text || needles.length === 0) return null;
  const flat = text.replace(WS_COLLAPSE_RE, ' ').trim();
  const matches = findMatches(flat, needles);
  if (matches.length === 0) return null;

  let from = 0;
  let to = flat.length;
  if (flat.length > maxLen) {
    const window = chooseWindow(flat, matches, Math.max(1, maxLen));
    from = window.from;
    to = window.to;
    // Cut at word boundaries, without cutting off the anchoring match.
    if (from > 0 && flat[from - 1] !== ' ') {
      const space = flat.indexOf(' ', from);
      if (space !== -1 && space < window.anchor.start) from = space + 1;
    }
    if (to < flat.length && flat[to] !== ' ' && flat[to - 1] !== ' ') {
      const space = flat.lastIndexOf(' ', to - 1);
      if (space >= window.anchor.end) to = space;
    }
    // Never split a surrogate pair if a single long word forced a mid-word cut.
    if (from > 0 && isLowSurrogate(flat.charCodeAt(from))) from--;
    if (to < flat.length && isLowSurrogate(flat.charCodeAt(to))) to++;
    while (from < to && flat[from] === ' ') from++;
    while (to > from && flat[to - 1] === ' ') to--;
  }

  const segments = segmentsFromRanges(flat, mergeRanges(matches), from, to);
  if (from > 0) segments.unshift({ text: '…', match: false });
  if (to < flat.length) segments.push({ text: '…', match: false });
  return segments;
}

// ---------------------------------------------------------------------------
// Chip and swatch highlighting
// ---------------------------------------------------------------------------

export function tagMatches(tag: string, q: ParsedQuery): boolean {
  const folded = foldText(tag ?? '');
  if (!folded) return false;
  for (const filter of q.tags) {
    const f = foldText(filter);
    if (folded === f || (filter === q.partialTag && folded.startsWith(f))) return true;
  }
  return needlesOf(q).some((needle) => folded.includes(needle));
}

export function swatchMatches(swatch: Swatch, q: ParsedQuery): boolean {
  if (q.colours.length) {
    const lab = rgbToLab(swatchRgb(swatch));
    if (q.colours.some((c) => labDistance(lab, rgbToLab(c.rgb)) < COLOUR_MATCH_THRESHOLD)) return true;
  }
  const needles = needlesOf(q);
  if (needles.length === 0) return false;
  const words = swatchWords(swatch);
  return needles.some((needle) => hasColourWord(words, needle));
}
