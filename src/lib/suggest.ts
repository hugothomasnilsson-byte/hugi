import type { Swatch } from '../types';
import { NEUTRAL_FAMILIES, colourFamily, hexToRgb, rgbToOklch } from './colour';
import { normalizeTag } from './tags';

export interface SuggestInput {
  title: string;
  notes: string;
  /** All extracted (OCR) text of the entry's images. */
  text: string;
  palette: Swatch[];
  /** Tags already on the entry. */
  tags: string[];
  /** Tags the user dismissed for this entry. */
  dismissed: string[];
  /** Every tag in the library with its usage count. */
  library: ReadonlyMap<string, number>;
}

/*
 * Scoring overview. Every candidate gets a score; anything that matches a tag
 * the library already uses sits in a tier above all fresh vocabulary, so the
 * user's own words always come first. Within a tier, evidence is weighted by
 * where it was found: the title is deliberate, notes are the user's own words,
 * OCR text is plentiful but noisy. Repeats help, with diminishing returns.
 */
const LIBRARY_TIER = 1000;
const FIELD_WEIGHTS = [6, 3, 1.5] as const; // title, notes, text
const HASHTAG_WEIGHT = 4.5; // a #tag written in the source is a deliberate label
const PLATFORM_SCORE = 7;
const COLOUR_SCORE = 6;
const BIGRAM_BONUS = 1.25;
const MAX_BIGRAMS = 2;
/** OCR text longer than this many words needs a word to repeat before it is suggested. */
const LONG_TEXT_TOKENS = 60;

/** Index into per-field count triples. */
type Field = 0 | 1 | 2;
type FieldCounts = [number, number, number];
const TITLE: Field = 0;
const NOTES: Field = 1;
const TEXT: Field = 2;

const FLAG_URL = 1;
const FLAG_HASHTAG = 2;
const FLAG_HANDLE = 4;
/** Punctuation (not just spaces or hyphens) separates this token from the previous one. */
const FLAG_BREAK = 8;
const NOT_A_WORD = FLAG_URL | FLAG_HASHTAG | FLAG_HANDLE;

interface Token extends WordInfo {
  field: Field;
  flags: number;
}

/* ------------------------------------------------------------------ */
/* Word lists                                                          */
/* ------------------------------------------------------------------ */

function words(list: string): string[] {
  return list.split(/\s+/).filter(Boolean);
}

// Folded, lowercase. Words under four letters are never keywords anyway, but
// they are listed so a one-word library tag like "new" is recognised as common.
const STOPWORDS: ReadonlySet<string> = new Set([
  // Function words.
  ...words(`a about above across after afterwards again against all almost alone along already also although
    always am among amongst an and another any anybody anyhow anyone anything anyway anywhere are around as at away
    be became because become becomes becoming been before beforehand behind being below beside besides between
    beyond both but by can cannot could did do does doing done down during each either else elsewhere enough etc
    ever every everybody everyone everything everywhere except for former formerly from further had has have having
    he hence her here hereby herein hers herself him himself his how however i ie if in indeed instead into is it
    its itself just latter least less let lets may maybe me meanwhile might mine moreover most mostly much must my
    myself neither never nevertheless no nobody none noone nor not nothing now nowhere of off often oh on once one
    only onto or other others otherwise our ours ourselves out over own per perhaps please quite rather same shall
    she should since so some somebody somehow someone something sometime sometimes somewhere still such than that
    the their theirs them themselves then thence there thereafter thereby therefore therein thereupon these they
    this those though through throughout thru thus to together too toward towards under until up upon us very via
    was we were what whatever when whence whenever where whereafter whereas whereby wherein whereupon wherever
    whether which while whither who whoever whole whom whose why will with within without would yet you your yours
    yourself yourselves`),
  // Generic verbs, nouns and adjectives that say nothing about a source.
  ...words(`actually able back best better big came come comes coming different find finds found first get gets
    getting give given gives go goes going gone good got great keep kept know known knows last like likely little
    look looked looking looks lot lots made make makes making many more need needs new next okay put really right
    said say says see seem seemed seeming seems seen several show showed shown shows sure take taken takes taking
    tell thing things think told took try tried trying use used uses using want wanted wants way ways well went
    work worked working works yeah yes hello thanks thank stuff kind sort part parts person people full real left
    high long short small large tiny huge various certain true false available possible important general nice cool
    awesome amazing beautiful lovely pretty favourite favorite love loved loves regular shot shots`),
  // Time and numbers.
  ...words(`today tomorrow yesterday tonight week weeks weekend month months year years day days daily hour hours
    minute minutes min mins second seconds sec secs time times moment ago
    monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun
    january february march april may june july august september october november december
    jan feb mar apr jun jul aug sep sept oct nov dec
    zero two three four five six seven eight nine ten eleven twelve twenty thirty forty fifty hundred thousand
    million billion half`),
  // Web and app chrome that screenshots are full of.
  ...words(`http https www com org net html htm php asp jpg jpeg png gif webp heic pdf img url link links
    follow follows followed following follower followers likes liked liking share shares shared sharing reply
    replies replied replying repost reposts reposted retweet retweets retweeted quote tweet tweets comment comments
    commented view views viewed save saves saved post posts posted posting edit edited message messages send sent
    notification notifications subscribe subscribed subscriber subscribers unsubscribe download downloads upload
    uploaded login logout signup sign signed account accounts profile settings privacy terms cookie cookies policy
    accept close cancel previous page pages click tap swipe scroll read reading menu home search explore trending
    feed status online offline active verified sponsored promoted translate translated update updated loading
    loaded open opened app apps website site free original reel reels story stories highlights mute muted block
    report reported pinned pin pins board boards repin watch watching watched listen play paused pause channel
    channels thread threads tagged mention mentions instagood photooftheday picoftheday followme likeforlike
    image images photo photos picture pictures screenshot screenshots video videos clip clips untitled copy copied
    paste pasted file files folder version news credit credits courtesy featuring official caption`),
]);

/**
 * Platforms recognised from their domains. A platform only becomes a
 * suggestion when its domain appears (a clear sign the source came from there)
 * or when the library already uses one of its tag spellings.
 */
const PLATFORMS: ReadonlyArray<{ tags: readonly string[]; domain: RegExp }> = [
  { tags: ['instagram', 'insta'], domain: /\binstagram\.com\b|\binstagr\.am\b/ },
  { tags: ['pinterest'], domain: /\bpinterest\.(?:com|co\.uk|[a-z]{2})\b|\bpin\.it\b/ },
  { tags: ['arena', 'are-na'], domain: /\bare\.na\b/ },
  { tags: ['behance'], domain: /\bbehance\.net\b/ },
  { tags: ['dribbble'], domain: /\bdribbble\.com\b/ },
  { tags: ['youtube'], domain: /\byoutube\.com\b|\byoutu\.be\b/ },
  { tags: ['twitter', 'x'], domain: /\btwitter\.com\b|(?<![\w.-])x\.com\b/ },
  { tags: ['tumblr'], domain: /\btumblr\.com\b/ },
  { tags: ['vimeo'], domain: /\bvimeo\.com\b/ },
  { tags: ['substack'], domain: /\bsubstack\.com\b/ },
  { tags: ['flickr'], domain: /\bflickr\.com\b|\bflic\.kr\b/ },
  { tags: ['tiktok'], domain: /\btiktok\.com\b/ },
  { tags: ['reddit'], domain: /\breddit\.com\b|\bredd\.it\b/ },
  { tags: ['bluesky'], domain: /\bbsky\.app\b/ },
  { tags: ['cosmos'], domain: /\bcosmos\.so\b/ },
  { tags: ['savee'], domain: /\bsavee\.it\b/ },
  { tags: ['figma'], domain: /\bfigma\.com\b/ },
  { tags: ['github'], domain: /\bgithub\.com\b/ },
  { tags: ['medium'], domain: /\bmedium\.com\b/ },
  { tags: ['unsplash'], domain: /\bunsplash\.com\b/ },
  { tags: ['artstation'], domain: /\bartstation\.com\b/ },
  { tags: ['etsy'], domain: /\betsy\.com\b/ },
  { tags: ['bandcamp'], domain: /\bbandcamp\.com\b/ },
  { tags: ['soundcloud'], domain: /\bsoundcloud\.com\b/ },
  { tags: ['letterboxd'], domain: /\bletterboxd\.com\b/ },
];

/** Brand names that only count via the platform rule, never as loose keywords. */
const PLATFORM_WORDS: ReadonlySet<string> = new Set(
  words(`instagram pinterest behance dribbble youtube twitter tumblr vimeo substack flickr tiktok reddit bluesky
    savee figma github unsplash artstation etsy bandcamp soundcloud letterboxd facebook linkedin whatsapp google`),
);

const MONOCHROME_SPELLINGS = ['monochrome', 'black-and-white', 'blackandwhite', 'black-white', 'bnw', 'bw'];

/* ------------------------------------------------------------------ */
/* Words                                                               */
/* ------------------------------------------------------------------ */

const NON_ASCII = /[^\x00-\x7f]/;
const COMBINING_MARKS = /\p{M}+/gu;
const LOWER_LATIN = /^[a-z]+$/;

function fold(lower: string): string {
  return NON_ASCII.test(lower) ? lower.normalize('NFKD').replace(COMBINING_MARKS, '') : lower;
}

/** Light English plural folding: "posters" → "poster", "stories" → "story", "sketches" → "sketch". */
function singular(key: string): string {
  const n = key.length;
  if (n <= 3 || key.charCodeAt(n - 1) !== 115 /* s */ || !LOWER_LATIN.test(key)) return key;
  if (n > 4 && key.endsWith('ies')) return key.slice(0, -3) + 'y';
  if (/(?:ss|us|is)$/.test(key)) return key; // "glass", "bus", "analysis"
  if (n > 4 && /(?:ss|sh|ch|x|z)es$/.test(key)) return key.slice(0, -2); // "glasses", "brushes", "boxes"
  return key.slice(0, -1);
}

/**
 * Plural-insensitive matching key. The singular cannot always be read off the
 * spelling ("stories" ← story but "movies" ← movie; "boxes" ← box but
 * "glazes" ← glaze), so both forms are folded onto one key instead: a final
 * "ie" becomes "y" and a silent "e" after ch, sh, x, z or o is dropped
 * (movie, movies → "movy"; glaze, glazes → "glaz"; hero, heroes → "hero").
 * Keys are only compared, never shown.
 */
function stem(key: string): string {
  const base = singular(key);
  if (base.length <= 3 || !LOWER_LATIN.test(base)) return base;
  if (base.endsWith('ie')) return base.slice(0, -2) + 'y';
  if (/(?:ch|sh|[xzo])e$/.test(base)) return base.slice(0, -1);
  return base;
}

interface WordInfo {
  /** Lowercase, as written (compatibility forms such as OCR ligatures normalised). */
  surface: string;
  /** Lowercase with diacritics folded, for matching. */
  key: string;
  /** Plural-insensitive key. */
  stem: string;
  /** Passes the fresh-keyword filters (before position-specific flags). */
  keyword: boolean;
}

function isUpper(code: number): boolean {
  return code >= 65 && code <= 90;
}
function isLower(code: number): boolean {
  return code >= 97 && code <= 122;
}

/**
 * Case noise typical of OCR: "tHiS", "ThE", "SOMEthing". Allows "word", "Word",
 * "WORD" and one internal capital ("YouTube", "iPhone"). ASCII-only; other
 * scripts are not judged.
 */
function hasNoisyCase(raw: string): boolean {
  let humps = 0;
  let upperRun = 0;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (isUpper(code)) {
      if (i > 0 && isLower(raw.charCodeAt(i - 1))) {
        if (++humps >= 2 || i === raw.length - 1) return true;
      }
      upperRun++;
    } else {
      if (isLower(code) && upperRun >= 2 && i + 1 < raw.length && isLower(raw.charCodeAt(i + 1))) return true;
      upperRun = 0;
    }
  }
  return false;
}

/** True for OCR debris such as "rnrnm", "lllll", "xkcdq". Only judges plain Latin words. */
function hasGarbageShape(key: string): boolean {
  if (!LOWER_LATIN.test(key)) return false;
  let vowels = 0;
  let consonantRun = 0;
  for (let i = 0; i < key.length; i++) {
    const ch = key[i];
    if (i >= 2 && ch === key[i - 1] && ch === key[i - 2]) return true;
    if (ch === 'a' || ch === 'e' || ch === 'i' || ch === 'o' || ch === 'u' || ch === 'y') {
      vowels++;
      consonantRun = 0;
    } else if (++consonantRun >= 6) {
      return true;
    }
  }
  // One vowel in seven letters is still English ("stretch", "scripts",
  // "strength"); the consonant-run check above already catches most debris.
  const ratio = vowels / key.length;
  return ratio < 0.1 || ratio > 0.8;
}

const HAS_DIGIT = /\p{N}/u;

function analyseWord(raw: string): WordInfo {
  const nonAscii = NON_ASCII.test(raw);
  // NFKC turns OCR ligatures ("ﬁ") and full-width forms into plain letters.
  const surface = nonAscii ? raw.toLowerCase().normalize('NFKC') : raw.toLowerCase();
  const key = fold(surface);
  const stemmed = stem(key);
  // Word lists hold real words, so plurals are checked by their singular.
  const base = singular(key);
  const keyword =
    key.length >= 4 &&
    key.length <= 24 &&
    !HAS_DIGIT.test(key) &&
    !STOPWORDS.has(key) &&
    !STOPWORDS.has(base) &&
    !PLATFORM_WORDS.has(base) &&
    !hasGarbageShape(key) &&
    !hasNoisyCase(raw);
  return { surface, key, stem: stemmed, keyword };
}

// Word analysis is a pure function of the raw word, and the same OCR text is
// re-analysed whenever an entry is edited, so results are memoised (bounded).
const wordCache = new Map<string, WordInfo>();
const WORD_CACHE_LIMIT = 20000;

function wordInfo(raw: string): WordInfo {
  let info = wordCache.get(raw);
  if (!info) {
    if (wordCache.size >= WORD_CACHE_LIMIT) wordCache.clear();
    info = analyseWord(raw);
    wordCache.set(raw, info);
  }
  return info;
}

/* ------------------------------------------------------------------ */
/* Tokenising                                                          */
/* ------------------------------------------------------------------ */

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu;
// Only strips links from keyword extraction (platforms have their own patterns),
// so TLDs that are also English words ("it", "me", "so") are left out: OCR
// often glues sentences together as "end.It".
const URL_RE =
  /\b(?:https?:\/\/|www\.)\S+|\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|app|xyz|art|design|studio|uk|de|fr|nl|tv|dev|info|blog)\b(?:\/\S*)?/giu;
// Inner hyphens belong to the tag ("#film-grain"), as in the app's own tags.
const HASHTAG_RE = /(?<![\p{L}\p{N}_&/])#([\p{L}\p{N}][\p{L}\p{M}\p{N}_]*(?:-[\p{L}\p{M}\p{N}_]+)*)/gu;
const HANDLE_RE = /(?<![\p{L}\p{N}_.])@[\p{L}\p{N}_.]+/gu;

function spans(text: string, re: RegExp): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(re)) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** Walks sorted, non-overlapping spans alongside increasing token offsets. */
class SpanCursor {
  private i = 0;
  constructor(private readonly ranges: [number, number][]) {}
  contains(offset: number): boolean {
    while (this.i < this.ranges.length && this.ranges[this.i][1] <= offset) this.i++;
    return this.i < this.ranges.length && this.ranges[this.i][0] <= offset;
  }
}

/** Whitespace, dashes and underscores join words into phrases; anything else breaks them. */
function gapJoins(text: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    const c = text.charCodeAt(i);
    const joins =
      c === 32 || c === 10 || c === 13 || c === 9 || c === 45 || c === 95 || c === 160 || (c >= 0x2010 && c <= 0x2014);
    if (!joins) return false;
  }
  return true;
}

interface Scan {
  tokens: Token[];
  hashtags: { tag: string; field: Field }[];
  textTokens: number;
}

/** A word hyphenated across a line break in a scanned page: "solu-⏎tion". */
const LINE_BREAK_HYPHEN_RE = /(\p{Ll})[-\u00ad\u2010][ \t]*\r?\n[ \t]*(?=\p{Ll})/gu;

function scanField(source: string, field: Field, into: Scan): void {
  if (!source) return;
  let text = source.normalize('NFC');
  // OCR keeps a page's end-of-line hyphenation; rejoin it so "solu-⏎tion" is
  // read as "solution" rather than two fragments. A capital after the break
  // ("Müller-⏎Brockmann") marks a real compound and is left alone.
  if (field === TEXT) text = text.replace(LINE_BREAK_HYPHEN_RE, '$1');
  const urls = new SpanCursor(spans(text, URL_RE));
  const handles = new SpanCursor(spans(text, HANDLE_RE));
  const hashtagSpans: [number, number][] = [];
  for (const m of text.matchAll(HASHTAG_RE)) {
    hashtagSpans.push([m.index, m.index + m[0].length]);
    into.hashtags.push({ tag: m[1], field });
  }
  const hashtags = new SpanCursor(hashtagSpans);

  let previousEnd = -1;
  for (const m of text.matchAll(WORD_RE)) {
    const raw = m[0];
    const start = m.index;
    let flags = 0;
    if (urls.contains(start)) flags |= FLAG_URL;
    if (hashtags.contains(start)) flags |= FLAG_HASHTAG;
    if (handles.contains(start)) flags |= FLAG_HANDLE;
    if (previousEnd >= 0 && !gapJoins(text, previousEnd, start)) flags |= FLAG_BREAK;
    previousEnd = start + raw.length;
    into.tokens.push({ ...wordInfo(raw), field, flags });
    if (field === TEXT) into.textTokens++;
  }
}

/** Token i+1 directly continues token i (same field, no punctuation between). */
function joined(tokens: Token[], i: number): boolean {
  const next = tokens[i + 1];
  return next !== undefined && next.field === tokens[i].field && !(next.flags & FLAG_BREAK);
}

function isKeyword(token: Token): boolean {
  return token.keyword && !(token.flags & NOT_A_WORD);
}

/* ------------------------------------------------------------------ */
/* Tags                                                                */
/* ------------------------------------------------------------------ */

interface TagShape {
  /** The normalised tag, or "" when the input cannot be a tag. */
  tag: string;
  /** Stemmed, folded words of the tag ("film-grain" → ["film", "grain"]). */
  parts: string[];
  /** Plural-insensitive identity, used for de-duplication and exclusion. */
  identity: string;
  /** Stem of the words run together ("film-grain" → "filmgrain"). */
  compact: string;
}

// Shapes are pure functions of the string, so they are memoised across calls.
const shapeCache = new Map<string, TagShape>();
const SHAPE_CACHE_LIMIT = 20000;

function shapeOf(raw: string): TagShape {
  let shape = shapeCache.get(raw);
  if (!shape) {
    let tag = normalizeTag(raw);
    if (/^\p{N}+$/u.test(tag)) tag = ''; // "#1" is a list marker, not a tag
    const words = tag
      .split(/[-_]+/)
      .filter(Boolean)
      .map((p) => fold(p));
    const parts = words.map(stem);
    // The run-together form stems the whole word, as a token "movieposter"
    // would be, not each part ("movie-poster" → "movieposter", not "movyposter").
    shape = { tag, parts, identity: parts.join('-'), compact: stem(words.join('')) };
    if (shapeCache.size >= SHAPE_CACHE_LIMIT) shapeCache.clear();
    shapeCache.set(raw, shape);
  }
  return shape;
}

interface LibraryIndex {
  /** Snapshot used to detect a library Map that was mutated in place. */
  keys: string[];
  counts: number[];
  /** One-word tags by their word, and multi-word tags by their run-together form. */
  single: Map<string, TagShape[]>;
  /** Multi-word tags by their first word. */
  multi: Map<string, TagShape[]>;
  /** Longest key in `single`; longer run-together phrases cannot match. */
  longestSingle: number;
  /** Each word used inside tags, with the summed usage of those tags. */
  vocabulary: Map<string, number>;
}

const libraryIndexes = new WeakMap<ReadonlyMap<string, number>, LibraryIndex>();

function isCurrent(index: LibraryIndex, library: ReadonlyMap<string, number>): boolean {
  if (index.keys.length !== library.size) return false;
  let i = 0;
  for (const [key, count] of library) {
    if (index.keys[i] !== key || index.counts[i] !== count) return false;
    i++;
  }
  return true;
}

/** Lookup structures for the library's tags, rebuilt only when the library changes. */
function indexLibrary(library: ReadonlyMap<string, number>): LibraryIndex {
  const cached = libraryIndexes.get(library);
  if (cached && isCurrent(cached, library)) return cached;

  const index: LibraryIndex = {
    keys: [],
    counts: [],
    single: new Map(),
    multi: new Map(),
    longestSingle: 0,
    vocabulary: new Map(),
  };
  const push = (map: Map<string, TagShape[]>, key: string, shape: TagShape) => {
    const list = map.get(key);
    if (list) list.push(shape);
    else map.set(key, [shape]);
    if (map === index.single) index.longestSingle = Math.max(index.longestSingle, key.length);
  };
  for (const [key, count] of library) {
    index.keys.push(key);
    index.counts.push(count);
    const shape = shapeOf(key);
    if (shape.parts.length === 0 || shape.compact.length < 2) continue;
    if (shape.parts.length === 1) push(index.single, shape.parts[0], shape);
    else {
      push(index.multi, shape.parts[0], shape);
      push(index.single, shape.compact, shape);
    }
    for (const part of shape.parts) {
      index.vocabulary.set(part, (index.vocabulary.get(part) ?? 0) + Math.max(0, count || 0));
    }
  }
  libraryIndexes.set(library, index);
  return index;
}

/** A one-word tag that is also a stopword ("new", "work"); checked by its singular, like keywords. */
function isCommonWord(shape: TagShape): boolean {
  return STOPWORDS.has(shape.parts[0]) || STOPWORDS.has(singular(fold(shape.tag)));
}

function fieldScore(counts: readonly number[], weights: readonly number[] = FIELD_WEIGHTS): number {
  let score = 0;
  for (let f = 0; f < 3; f++) if (counts[f] > 0) score += weights[f] * (1 + Math.log(counts[f]));
  return score;
}

/**
 * How established a library tag is. Deliberately gentle: where a word was
 * found should matter more than how often the tag has been used, so this
 * mostly separates tags with similar evidence.
 */
function popularity(count: number | undefined): number {
  return 0.5 * Math.log2(1 + Math.max(0, count || 0));
}

/** Score for a tag the library already has, found by a non-textual signal (domain, colour). */
function knownTagScore(library: ReadonlyMap<string, number>, tag: string): number {
  return LIBRARY_TIER + FIELD_WEIGHTS[NOTES] + popularity(library.get(tag));
}

/* ------------------------------------------------------------------ */
/* Candidates                                                          */
/* ------------------------------------------------------------------ */

/** Position used to order equal scores: candidates found earlier read first. */
const NO_POSITION = Number.MAX_SAFE_INTEGER;

class Candidates {
  private readonly best = new Map<string, { tag: string; score: number; position: number }>();
  private readonly excludedTags = new Set<string>();
  private readonly excludedIdentities = new Set<string>();

  /** Tags on the entry and dismissed tags, including their singular/plural twins. */
  exclude(tags: Iterable<string>): void {
    for (const raw of tags) {
      const { tag, identity } = shapeOf(raw);
      if (!tag) continue;
      this.excludedTags.add(tag);
      this.excludedIdentities.add(identity);
    }
  }

  add(raw: string, score: number, position = NO_POSITION): void {
    const { tag, identity } = shapeOf(raw);
    if (!tag || !identity || this.excludedTags.has(tag) || this.excludedIdentities.has(identity)) return;
    const candidate = { tag, score, position };
    const current = this.best.get(identity);
    // One suggestion per identity: "poster" and "posters" never both appear.
    if (!current || compareCandidates(candidate, current) < 0) this.best.set(identity, candidate);
  }

  ranked(limit: number): string[] {
    return [...this.best.values()]
      .sort(compareCandidates)
      .slice(0, limit)
      .map((c) => c.tag);
  }
}

/** Higher score first, then earlier in the text, then alphabetical: a total, deterministic order. */
function compareCandidates(
  a: { tag: string; score: number; position: number },
  b: { tag: string; score: number; position: number },
): number {
  return b.score - a.score || a.position - b.position || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0);
}

/**
 * Offline hashtag suggestions for an entry, best first.
 *
 * Signals, strongest first: tags the library already uses whose words appear
 * in the title, notes or OCR text; salient keywords, repeated two-word phrases
 * and #hashtags written in the source; the platform a screenshot came from (by
 * domain); and the dominant colour family of the palette (or "monochrome").
 * Never returns a tag already on the entry or dismissed for it, nor a
 * singular/plural twin of one. Deterministic.
 */
export function suggestTags(input: SuggestInput, limit = 6): string[] {
  const max = Math.floor(limit);
  if (!(max > 0)) return [];

  const candidates = new Candidates();
  candidates.exclude(input.tags ?? []);
  candidates.exclude(input.dismissed ?? []);
  const library = input.library ?? new Map<string, number>();

  const scan: Scan = { tokens: [], hashtags: [], textTokens: 0 };
  scanField(input.title ?? '', TITLE, scan);
  scanField(input.notes ?? '', NOTES, scan);
  scanField(input.text ?? '', TEXT, scan);

  const index = library.size > 0 ? indexLibrary(library) : null;
  const covered = index ? matchLibraryTags(scan.tokens, index, library, candidates) : new Uint8Array(scan.tokens.length);
  collectKeywords(scan, covered, index, candidates);
  collectHashtags(scan.hashtags, candidates);
  collectPlatforms(input, library, candidates);
  collectColour(input.palette ?? [], scan.textTokens, library, candidates);

  return candidates.ranked(max);
}

/**
 * Signal 1: library tags whose words occur in the text, as a phrase
 * ("film grain" → film-grain), written together ("filmgrain" → film-grain) or
 * apart ("film grain" → filmgrain). Returns which token positions a library tag
 * explained, so those words are not re-suggested as fresh keywords.
 */
function matchLibraryTags(
  tokens: Token[],
  index: LibraryIndex,
  library: ReadonlyMap<string, number>,
  out: Candidates,
): Uint8Array {
  const covered = new Uint8Array(tokens.length);
  const hits = new Map<TagShape, FieldCounts>();
  const firstHit = new Map<TagShape, number>();
  const record = (shape: TagShape, start: number, length: number) => {
    const field = tokens[start].field;
    // A one-word tag that is also a common word ("new", "work") only counts in the title.
    if (length === 1 && shape.parts.length === 1 && field !== TITLE && isCommonWord(shape)) return;
    let counts = hits.get(shape);
    if (!counts) {
      hits.set(shape, (counts = [0, 0, 0]));
      firstHit.set(shape, start);
    }
    counts[field]++;
    covered.fill(1, start, start + length);
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const singles = index.single.get(token.stem);
    if (singles) for (const shape of singles) record(shape, i, 1);

    const multis = index.multi.get(token.stem);
    if (multis) {
      for (const shape of multis) {
        const { parts } = shape;
        let j = 1;
        while (j < parts.length && joined(tokens, i + j - 1) && tokens[i + j].stem === parts[j]) j++;
        if (j === parts.length) record(shape, i, j);
      }
    }

    // Words written apart: "black and white" → blackandwhite, "film grain" → filmgrain.
    let compact = token.key;
    for (let span = 2; span <= 3 && joined(tokens, i + span - 2); span++) {
      compact += tokens[i + span - 1].key;
      // Stems are up to two letters shorter than the words ("boxes" → "box", "berries" → "berry").
      if (compact.length > index.longestSingle + 2) break;
      const matches = index.single.get(stem(compact));
      if (matches) for (const shape of matches) if (shape.parts.length === 1) record(shape, i, span);
    }
  }

  for (const [shape, counts] of hits) {
    out.add(shape.tag, LIBRARY_TIER + fieldScore(counts) + popularity(library.get(shape.tag)), firstHit.get(shape));
  }
  return covered;
}

interface KeywordStats {
  counts: FieldCounts;
  /** First spelling seen; most words only ever have this one. */
  surface: string;
  /** Spelling counts, created only once a second spelling turns up. */
  surfaces: Map<string, number> | null;
  firstSeen: number;
}

interface PhraseStats extends KeywordStats {
  parts: [string, string];
}

function newStats(surface: string, firstSeen: number): KeywordStats {
  return { counts: [0, 0, 0], surface, surfaces: null, firstSeen };
}

function tally(stats: KeywordStats, surface: string, field: Field): void {
  const seen = stats.counts[0] + stats.counts[1] + stats.counts[2];
  stats.counts[field]++;
  if (!stats.surfaces) {
    if (surface === stats.surface) return;
    stats.surfaces = new Map([[stats.surface, seen]]);
  }
  stats.surfaces.set(surface, (stats.surfaces.get(surface) ?? 0) + 1);
}

/** The most frequent way a word was written; ties go to the shorter, then alphabetical. */
function preferredSurface(stats: KeywordStats): string {
  if (!stats.surfaces) return stats.surface;
  let best = '';
  let bestCount = -1;
  for (const [surface, count] of stats.surfaces) {
    if (
      count > bestCount ||
      (count === bestCount && (surface.length < best.length || (surface.length === best.length && surface < best)))
    ) {
      best = surface;
      bestCount = count;
    }
  }
  return best;
}

/** Signal 2: salient words and repeated two-word phrases. */
function collectKeywords(scan: Scan, covered: Uint8Array, index: LibraryIndex | null, out: Candidates): void {
  const { tokens } = scan;
  const unigrams = new Map<string, KeywordStats>();
  const bigrams = new Map<string, PhraseStats>();

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (covered[i] || !isKeyword(t)) continue;
    let word = unigrams.get(t.stem);
    if (!word) unigrams.set(t.stem, (word = newStats(t.surface, i)));
    tally(word, t.surface, t.field);

    if (!joined(tokens, i)) continue;
    const next = tokens[i + 1];
    if (covered[i + 1] || !isKeyword(next) || next.stem === t.stem) continue;
    const key = `${t.stem} ${next.stem}`;
    const surface = `${t.surface}-${next.surface}`;
    let phrase = bigrams.get(key);
    if (!phrase) bigrams.set(key, (phrase = { ...newStats(surface, i), parts: [t.stem, next.stem] }));
    tally(phrase, surface, t.field);
  }
  if (unigrams.size === 0) return;

  // Words that already appear inside the user's tags ("film" in film-grain and
  // film-stock) are part of their vocabulary and get a nudge.
  const vocabularyBonus = (key: string) => (index ? 2 * Math.log2(1 + (index.vocabulary.get(key) ?? 0)) : 0);

  // Repeated phrases win over their words: "type design" twice suggests
  // type-design, and those occurrences stop counting towards "type" and "design".
  const usedWords = new Set<string>();
  const phrases = [...bigrams.values()]
    .filter((p) => p.counts[0] + p.counts[1] + p.counts[2] >= 2)
    .map((p) => ({
      phrase: p,
      score: BIGRAM_BONUS * fieldScore(p.counts) + vocabularyBonus(p.parts[0]) + vocabularyBonus(p.parts[1]),
    }))
    .sort((a, b) => b.score - a.score || a.phrase.firstSeen - b.phrase.firstSeen);
  let accepted = 0;
  for (const { phrase, score } of phrases) {
    if (accepted >= MAX_BIGRAMS) break;
    const [a, b] = phrase.parts;
    if (usedWords.has(a) || usedWords.has(b)) continue;
    usedWords.add(a).add(b);
    accepted++;
    out.add(preferredSurface(phrase), score, phrase.firstSeen);
    for (const part of phrase.parts) {
      const word = unigrams.get(part)!;
      for (let f = 0; f < 3; f++) word.counts[f] = Math.max(0, word.counts[f] - phrase.counts[f]);
    }
  }

  // In a long OCR dump a single mention is noise; in a short caption it is the content.
  const minTextOnly = scan.textTokens > LONG_TEXT_TOKENS ? 2 : 1;
  for (const [key, stats] of unigrams) {
    const [title, notes, text] = stats.counts;
    if (title === 0 && notes === 0 && text < minTextOnly) continue;
    const surface = preferredSurface(stats);
    // A verb mentioned once in passing ("the type sits on…") is not a subject.
    if (title === 0 && notes + text === 1 && looksLikeVerb(surface)) continue;
    out.add(surface, fieldScore(stats.counts) + vocabularyBonus(key), stats.firstSeen);
  }
}

// Everyday verbs (base forms). Creative verbs that double as subjects — print,
// paint, draw, shoot, frame, design, type, press — are deliberately absent.
const COMMON_VERBS: ReadonlySet<string> = new Set(
  words(`sit stand lie hang make take give keep look feel seem show tell find think know want need
  use try come get put let run turn move hold bring leave call start stop help play mean become begin
  open close say ask work talk walk stay wait sound appear happen remain carry reach allow add spend
  grow offer serve send expect build fall cut rise speak meet pay lose follow change watch learn
  create provide include continue set sits lies says does goes gets puts lets runs`),
);

/** True for an everyday verb in any common inflection: sits, sitting, seemed, tries. */
function looksLikeVerb(word: string): boolean {
  const w = word.toLowerCase();
  const bases = [w];
  if (w.endsWith('ies')) bases.push(`${w.slice(0, -3)}y`);
  if (w.endsWith('es')) bases.push(w.slice(0, -2));
  if (w.endsWith('s')) bases.push(w.slice(0, -1));
  if (w.endsWith('ied')) bases.push(`${w.slice(0, -3)}y`);
  if (w.endsWith('ed')) bases.push(w.slice(0, -2), w.slice(0, -1));
  if (w.endsWith('ing')) bases.push(w.slice(0, -3), `${w.slice(0, -3)}e`);
  // Doubled final consonant: sitting → sit, stopped → stop.
  if (/(.)\1(ing|ed)$/.test(w)) bases.push(w.replace(/(.)\1(ing|ed)$/, '$1'));
  return bases.some((b) => COMMON_VERBS.has(b));
}

/** "#fff", "#c0392b": colour codes, not hashtags. Six letters ("#facade") stay words. */
function isHexColour(tag: string): boolean {
  return /^[0-9a-f]{3}$/.test(tag) || (/^[0-9a-f]{6}$/.test(tag) && /\d/.test(tag));
}

/** #hashtags written in the source itself, common in social media screenshots. */
function collectHashtags(hashtags: Scan['hashtags'], out: Candidates): void {
  const counts = new Map<string, FieldCounts>();
  for (const { tag: raw, field } of hashtags) {
    const { tag } = shapeOf(raw);
    if (tag.length < 2 || isHexColour(tag)) continue;
    const key = fold(tag);
    if (STOPWORDS.has(key) || PLATFORM_WORDS.has(key)) continue;
    let c = counts.get(tag);
    if (!c) counts.set(tag, (c = [0, 0, 0]));
    c[field]++;
  }
  const weights = FIELD_WEIGHTS.map((w) => Math.max(w, HASHTAG_WEIGHT));
  for (const [tag, c] of counts) out.add(tag, fieldScore(c, weights));
}

function librarySpelling(spellings: readonly string[], library: ReadonlyMap<string, number>): string | null {
  for (const s of spellings) if (library.has(s)) return s;
  return null;
}

/** Signal 3: where the source came from, judged by domains in the text. */
function collectPlatforms(input: SuggestInput, library: ReadonlyMap<string, number>, out: Candidates): void {
  const haystack = `${input.title ?? ''}\n${input.notes ?? ''}\n${input.text ?? ''}`.toLowerCase();
  if (!haystack.includes('.')) return;
  for (const platform of PLATFORMS) {
    if (!platform.domain.test(haystack)) continue;
    const known = librarySpelling(platform.tags, library);
    if (known) out.add(known, knownTagScore(library, known));
    else out.add(platform.tags[0], PLATFORM_SCORE);
  }
}

const FAMILY_DOMINANCE = 0.45;
const MAJOR_SWATCH = 0.05;
const MONOCHROME_MAX_CHROMA = 0.04;

/** Signal 4: a dominant colour family, or "monochrome" for neutral-only images. */
function collectColour(
  palette: Swatch[],
  textTokens: number,
  library: ReadonlyMap<string, number>,
  out: Candidates,
): void {
  // Families are recomputed from the colour rather than trusted from storage,
  // so palettes saved by an older namer are judged by the same rules.
  const swatches: { rgb: [number, number, number]; weight: number; family: string }[] = [];
  for (const s of palette) {
    const rgb = Array.isArray(s?.rgb) && s.rgb.length === 3 ? s.rgb : hexToRgb(s?.hex ?? '');
    if (rgb) swatches.push({ rgb, weight: Math.max(0, s.weight || 0), family: colourFamily(rgb) });
  }
  const total = swatches.reduce((sum, s) => sum + s.weight, 0);
  if (total <= 0) return;

  const shares = new Map<string, number>();
  for (const s of swatches) shares.set(s.family, (shares.get(s.family) ?? 0) + s.weight / total);

  const suggest = (spelling: string) =>
    out.add(spelling, library.has(spelling) ? knownTagScore(library, spelling) : COLOUR_SCORE);

  let dominant: string | null = null;
  let dominantShare = 0;
  for (const [family, share] of shares) {
    if (NEUTRAL_FAMILIES.has(family)) continue;
    if (share > dominantShare || (share === dominantShare && dominant !== null && family < dominant)) {
      dominant = family;
      dominantShare = share;
    }
  }
  // Swatch weights are shares of the whole image and a palette need not cover
  // all of it (minor colours and specks are left out), so dominance is judged
  // against the image rather than renormalised over the listed swatches.
  // Weights that over-sum (bad data) are scaled down to the image.
  if (dominant && dominantShare * Math.min(total, 1) >= FAMILY_DOMINANCE) {
    suggest(dominant);
    return;
  }

  const major = swatches.filter((s) => s.weight / total >= MAJOR_SWATCH);
  const neutralOnly =
    major.length > 0 &&
    major.every((s) => NEUTRAL_FAMILIES.has(s.family) && rgbToOklch(s.rgb)[1] < MONOCHROME_MAX_CHROMA);
  if (!neutralOnly) return;

  // A page of text (white with black type, or dark mode) is not a monochrome image.
  let largestNeutral = 0;
  for (const family of NEUTRAL_FAMILIES) largestNeutral = Math.max(largestNeutral, shares.get(family) ?? 0);
  if (largestNeutral >= 0.95 || (largestNeutral >= 0.75 && textTokens >= 15)) return;

  suggest(librarySpelling(MONOCHROME_SPELLINGS, library) ?? MONOCHROME_SPELLINGS[0]);
}
