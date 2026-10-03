import { describe, expect, it } from 'vitest';
import {
  buildIndex,
  foldText,
  highlight,
  isEmptyQuery,
  knownTagsOf,
  makeSnippet,
  parseQuery,
  search,
  swatchMatches,
  tagMatches,
  type ParsedQuery,
} from '../../src/lib/search';
import type { Entry, HighlightSegment, ImageMeta, SearchDoc, Swatch } from '../../src/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let nextId = 0;

function entry(fields: Partial<Entry> = {}): Entry {
  const id = fields.id ?? `e${++nextId}`;
  return {
    id,
    title: '',
    notes: '',
    link: '',
    credit: '',
    tags: [],
    imageIds: [],
    dismissedTags: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    ...fields,
  };
}

function image(fields: Partial<ImageMeta> = {}): ImageMeta {
  return {
    id: `i${++nextId}`,
    entryId: 'x',
    width: 100,
    height: 100,
    mime: 'image/png',
    size: 1,
    text: '',
    textEdited: false,
    ocrStatus: 'done',
    palette: [],
    createdAt: 1_000,
    ...fields,
  };
}

function swatch(hex: string, name: string, family: string, weight = 0.3): Swatch {
  const n = parseInt(hex.slice(1), 16);
  return { hex, rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], name, family, weight };
}

function doc(e: Entry, images: ImageMeta[] = []): SearchDoc {
  return { entry: e, images };
}

function ids(results: { entry: Entry }[]): string[] {
  return results.map((r) => r.entry.id);
}

function joined(segments: HighlightSegment[]): string {
  return segments.map((s) => s.text).join('');
}

function marked(segments: HighlightSegment[]): string[] {
  return segments.filter((s) => s.match).map((s) => s.text);
}

/** Deterministic PRNG so property and perf tests are reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------

describe('foldText', () => {
  it('is case- and diacritic-insensitive', () => {
    expect(foldText('Café')).toBe('cafe');
    expect(foldText('CAFÉ')).toBe('cafe');
    expect(foldText('Ångström Øre Æsir Straße Łódź')).toBe('angstrom ore aesir strasse lodz');
  });

  it('expands compatibility forms and collapses whitespace', () => {
    expect(foldText('ﬁne art\t\n  ①')).toBe('fine art 1');
    expect(foldText('ＦＵＬＬ')).toBe('full');
  });

  it('removes invisible format characters and unifies typographic punctuation', () => {
    expect(foldText('photo­graphy')).toBe('photography');
    expect(foldText('it’s 1990–2000')).toBe("it's 1990-2000");
  });

  it('folds final sigma so word position does not matter', () => {
    expect(foldText('ΟΔΟΣ')).toBe(foldText('οδοσ'));
  });
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe('parseQuery', () => {
  it('splits terms and hashtags (spec example)', () => {
    const q = parseQuery('grain #colour #film');
    expect(q.terms).toEqual(['grain']);
    expect(q.tags).toEqual(['colour', 'film']);
    expect(q.partialTag).toBe('film');
    expect(q.phrases).toEqual([]);
    expect(q.excluded).toEqual([]);
    expect(q.colours).toEqual([]);
    expect(q.raw).toBe('grain #colour #film');
  });

  it('treats the trailing tag as complete once a space follows', () => {
    expect(parseQuery('grain #film ').partialTag).toBeNull();
    expect(parseQuery('#film grain').partialTag).toBeNull();
    expect(parseQuery('#film grain').tags).toEqual(['film']);
  });

  it('ignores runs of whitespace of any kind', () => {
    const q = parseQuery('  grain \t\n  film　noir   ');
    expect(q.terms).toEqual(['grain', 'film', 'noir']);
  });

  it('folds terms and normalises tags', () => {
    const q = parseQuery('Café NOIR #Film #Ça_va');
    expect(q.terms).toEqual(['cafe', 'noir']);
    expect(q.tags).toEqual(['film', 'ça_va']);
  });

  it('strips surrounding punctuation but keeps inner characters', () => {
    const q = parseQuery('grain, (film). f/1.8. 35mm "x" ... it’s c++');
    expect(q.terms).toEqual(['grain', 'film', 'f/1.8', '35mm', "it's", 'c++']);
    expect(q.phrases).toEqual(['x']);
  });

  it('ignores empty hashtags', () => {
    for (const raw of ['#', '##', '# #', '#!!', '#🎞️']) {
      const q = parseQuery(raw);
      expect(q.tags).toEqual([]);
      expect(q.partialTag).toBeNull();
      expect(isEmptyQuery(q)).toBe(true);
    }
    expect(parseQuery('##film').tags).toEqual(['film']);
  });

  it('keeps unicode and emoji terms', () => {
    const q = parseQuery('東京 🎞️ naïve');
    expect(q.terms).toEqual(['東京', '🎞', 'naive']);
  });

  it('parses quoted phrases, including smart quotes and unbalanced quotes', () => {
    expect(parseQuery('"golden  Hour" grain').phrases).toEqual(['golden hour']);
    expect(parseQuery('“golden hour” grain').phrases).toEqual(['golden hour']);
    expect(parseQuery('“golden hour” grain').terms).toEqual(['grain']);
    // Unclosed quote: the phrase runs to the end so live typing still narrows.
    const open = parseQuery('grain "golden ho');
    expect(open.terms).toEqual(['grain']);
    expect(open.phrases).toEqual(['golden ho']);
    expect(parseQuery('"').phrases).toEqual([]);
    expect(parseQuery('""  ""').phrases).toEqual([]);
  });

  it('parses exclusions', () => {
    const q = parseQuery('grain -digital -"lens flare" - -- -#film');
    expect(q.terms).toEqual(['grain']);
    expect(q.excluded).toEqual(['digital', 'lens flare', 'film']);
    expect(q.tags).toEqual([]);
  });

  it('treats an exclusion-only query as empty', () => {
    expect(isEmptyQuery(parseQuery('-digital'))).toBe(true);
    expect(isEmptyQuery(parseQuery('   '))).toBe(true);
    expect(isEmptyQuery(parseQuery(''))).toBe(true);
    expect(isEmptyQuery(parseQuery('a'))).toBe(false);
    expect(isEmptyQuery(parseQuery('#film'))).toBe(false);
    expect(isEmptyQuery(parseQuery('#fff'))).toBe(false);
    expect(isEmptyQuery(parseQuery('"x"'))).toBe(false);
  });

  it('turns hex-like hashtags into colour queries unless they are known tags', () => {
    const q = parseQuery('#C0392B #fff #12345 ');
    expect(q.colours).toEqual([
      { hex: '#c0392b', rgb: [192, 57, 43] },
      { hex: '#ffffff', rgb: [255, 255, 255] },
    ]);
    expect(q.tags).toEqual(['12345']);

    const known = parseQuery('#fff #add ', new Set(['add']));
    expect(known.colours.map((c) => c.hex)).toEqual(['#ffffff']);
    expect(known.tags).toEqual(['add']);
  });

  it('keeps a partly typed hashtag a tag when it prefixes a known tag', () => {
    const known = new Set(['facade']);
    const typing = parseQuery('#fac', known);
    expect(typing.tags).toEqual(['fac']);
    expect(typing.partialTag).toBe('fac');
    // Once finished with a space, "#fac" is no longer the start of anything.
    expect(parseQuery('#fac ', known).colours.map((c) => c.hex)).toEqual(['#ffaacc']);
  });

  it('has no partial tag when the trailing hashtag is a colour', () => {
    const q = parseQuery('grain #fff');
    expect(q.partialTag).toBeNull();
    expect(q.colours).toHaveLength(1);
  });

  it('deduplicates', () => {
    const q = parseQuery('grain Grain #film #FILM grain');
    expect(q.terms).toEqual(['grain']);
    expect(q.tags).toEqual(['film']);
  });
});

// ---------------------------------------------------------------------------
// Search: matching
// ---------------------------------------------------------------------------

describe('search matching', () => {
  const grainy = entry({ id: 'grainy', title: 'Grainy portraits', tags: ['portrait'] });
  const tagged = entry({ id: 'tagged', title: 'Contact sheet', tags: ['film-grain', 'film'] });
  const notes = entry({ id: 'notes', title: 'Untitled', notes: 'Shot at the Café de Flore on Portra 400' });
  const ocr = entry({ id: 'ocr', title: 'Screenshot' });
  const ocrImages = [image({ text: 'Kodak' }), image({ text: 'Tri-X 400\nPushed two stops' })];
  const index = buildIndex([doc(grainy), doc(tagged), doc(notes), doc(ocr, ocrImages)]);

  it('reports its size', () => {
    expect(index.size).toBe(4);
  });

  it('matches substrings in any field', () => {
    expect(ids(search(index, 'grain')).sort()).toEqual(['grainy', 'tagged']);
    expect(ids(search(index, 'flore'))).toEqual(['notes']);
    expect(ids(search(index, 'pushed'))).toEqual(['ocr']);
  });

  it('searches text from every image of an entry', () => {
    expect(ids(search(index, 'kodak tri-x'))).toEqual(['ocr']);
  });

  it('requires every term (AND)', () => {
    expect(ids(search(index, 'grain portraits'))).toEqual(['grainy']);
    expect(search(index, 'grain kodak')).toEqual([]);
  });

  it('is diacritic-insensitive in both directions', () => {
    expect(ids(search(index, 'cafe'))).toEqual(['notes']);
    expect(ids(search(index, 'CAFÉ'))).toEqual(['notes']);
  });

  it('matches phrases verbatim, across collapsed whitespace', () => {
    expect(ids(search(index, '"de flore"'))).toEqual(['notes']);
    expect(ids(search(index, '"400 pushed"'))).toEqual(['ocr']);
    expect(search(index, '"flore de"')).toEqual([]);
  });

  it('filters by exact tag once the tag is complete', () => {
    expect(ids(search(index, '#film '))).toEqual(['tagged']);
    expect(search(index, '#fil ')).toEqual([]);
    expect(search(index, '#grain ')).toEqual([]);
  });

  it('treats the tag being typed as a prefix', () => {
    expect(ids(search(index, '#fil'))).toEqual(['tagged']);
    expect(ids(search(index, '#por'))).toEqual(['grainy']);
  });

  it('combines keywords and tags', () => {
    expect(ids(search(index, 'contact #film'))).toEqual(['tagged']);
    expect(search(index, 'portraits #film')).toEqual([]);
  });

  it('excludes entries containing an excluded word in any field', () => {
    expect(ids(search(index, 'grain -contact'))).toEqual(['grainy']);
    expect(ids(search(index, 'grain -film'))).toEqual(['grainy']);
    expect(ids(search(index, '400 -kodak'))).toEqual(['notes']);
    expect(ids(search(index, '400 -"tri-x 400"'))).toEqual(['notes']);
  });

  it('returns nothing for empty, blank or exclusion-only queries', () => {
    expect(search(index, '')).toEqual([]);
    expect(search(index, '   \n ')).toEqual([]);
    expect(search(index, '-grain')).toEqual([]);
    expect(search(index, '#')).toEqual([]);
  });

  it('finds an entry by its link and credit', () => {
    const idx = buildIndex([
      doc(entry({ id: 'l', link: 'https://example.org/archive/kertesz' })),
      doc(entry({ id: 'c', credit: 'André Kertész' })),
    ]);
    expect(ids(search(idx, 'kertesz')).sort()).toEqual(['c', 'l']);
  });

  it('rejects documents built elsewhere', () => {
    expect(() => search({ size: 0 }, 'x')).toThrow(TypeError);
  });
});

describe('search colours', () => {
  const red = entry({ id: 'red', title: 'Poster', createdAt: 1 });
  const blue = entry({ id: 'blue', title: 'Sea', createdAt: 2 });
  const speck = entry({ id: 'speck', title: 'Snow', createdAt: 3 });
  const index = buildIndex([
    doc(red, [image({ palette: [swatch('#c0392b', 'vermilion', 'red', 0.6), swatch('#f5f0e6', 'ivory', 'white', 0.4)] })]),
    doc(blue, [image({ palette: [swatch('#1f4e79', 'navy', 'blue', 0.7), swatch('#c8a24a', 'ochre', 'yellow', 0.3)] })]),
    // A red speck too small to count for colour queries.
    doc(speck, [image({ palette: [swatch('#ffffff', 'white', 'white', 0.97), swatch('#c0392b', 'vermilion', 'red', 0.03)] })]),
  ]);

  it('matches hex queries by perceptual distance', () => {
    expect(ids(search(index, '#c33'))).toEqual(['red']);
    expect(ids(search(index, '#c4392f'))).toEqual(['red']);
    expect(ids(search(index, '#203f80'))).toEqual(['blue']);
    expect(search(index, '#00ff00')).toEqual([]);
  });

  it('reports the matched swatches and the colour field', () => {
    const [result] = search(index, '#c0392b');
    expect(result.swatches.map((s) => s.hex)).toEqual(['#c0392b']);
    expect(result.fields).toEqual(['colour']);
  });

  it('matches colour names and families as plain words', () => {
    expect(ids(search(index, 'ochre'))).toEqual(['blue']);
    expect(ids(search(index, 'navy'))).toEqual(['blue']);
    expect(ids(search(index, 'blue'))).toEqual(['blue']);
    // A colour word matches every swatch, however small.
    expect(ids(search(index, 'vermilion')).sort()).toEqual(['red', 'speck']);
    const [result] = search(index, 'yellow');
    expect(result.swatches.map((s) => s.name)).toEqual(['ochre']);
  });

  it('only counts colour words from their start, and hex codes in full', () => {
    expect(search(index, 'chre')).toEqual([]);
    expect(search(index, 'c039')).toEqual([]);
    expect(ids(search(index, 'c0392b')).sort()).toEqual(['red', 'speck']);
  });

  it('ranks closer, more dominant colours first', () => {
    const idx = buildIndex([
      doc(entry({ id: 'near' }), [image({ palette: [swatch('#c0392b', 'red', 'red', 0.5)] })]),
      doc(entry({ id: 'far' }), [image({ palette: [swatch('#b84a3a', 'brick', 'red', 0.5)] })]),
      doc(entry({ id: 'small' }), [image({ palette: [swatch('#c0392b', 'red', 'red', 0.06)] })]),
    ]);
    const order = ids(search(idx, '#c0392b'));
    expect(order[0]).toBe('near');
    expect(order).toHaveLength(3);
    // Same coverage: the closer shade wins. Same shade: the more dominant one wins.
    expect(order.indexOf('near')).toBeLessThan(order.indexOf('far'));
    expect(order.indexOf('near')).toBeLessThan(order.indexOf('small'));
  });

  it('needs every colour query to match', () => {
    expect(search(index, '#c0392b #1f4e79')).toEqual([]);
    expect(ids(search(index, '#c0392b #f5f0e6'))).toEqual(['red']);
  });

  it('treats a known tag that looks like hex as a tag', () => {
    const idx = buildIndex([
      doc(entry({ id: 'cafe', tags: ['cafe'] })),
      doc(entry({ id: 'beige' }), [image({ palette: [swatch('#ccaaff', 'lilac', 'purple', 0.5)] })]),
    ]);
    expect(knownTagsOf(idx).has('cafe')).toBe(true);
    expect(ids(search(idx, '#caf'))).toEqual(['cafe']); // still typing "#cafe"
    expect(ids(search(idx, '#caf '))).toEqual(['beige']); // a finished "#caf" is a colour
  });
});

// ---------------------------------------------------------------------------
// Search: ranking and result shape
// ---------------------------------------------------------------------------

describe('search ranking', () => {
  it('orders by field weight: title > tags > credit/notes > text > link', () => {
    const index = buildIndex([
      doc(entry({ id: 'link', link: 'https://x.org/moss', createdAt: 6 })),
      doc(entry({ id: 'text', createdAt: 5 }), [image({ text: 'moss' })]),
      doc(entry({ id: 'notes', notes: 'moss', createdAt: 4 })),
      doc(entry({ id: 'tags', tags: ['moss'], createdAt: 3 })),
      doc(entry({ id: 'title', title: 'Moss', createdAt: 2 })),
    ]);
    expect(ids(search(index, 'moss'))).toEqual(['title', 'tags', 'notes', 'text', 'link']);
  });

  it('prefers whole words over prefixes over inner substrings', () => {
    const index = buildIndex([
      doc(entry({ id: 'inner', title: 'Ingrained', createdAt: 3 })),
      doc(entry({ id: 'prefix', title: 'Grainy', createdAt: 2 })),
      doc(entry({ id: 'whole', title: 'Grain', createdAt: 1 })),
    ]);
    expect(ids(search(index, 'grain'))).toEqual(['whole', 'prefix', 'inner']);
  });

  it('looks past an early mid-word hit for a whole-word hit in the same field', () => {
    const index = buildIndex([
      doc(entry({ id: 'later', notes: 'restart the art', createdAt: 1 })),
      doc(entry({ id: 'only', notes: 'restart', createdAt: 2 })),
    ]);
    const results = search(index, 'art');
    expect(ids(results)).toEqual(['later', 'only']);
    expect(results[0].score).toBeGreaterThan(results[1].score + 1);
  });

  it('treats hyphens and underscores as word boundaries', () => {
    const index = buildIndex([doc(entry({ id: 'a', tags: ['film-grain'] })), doc(entry({ id: 'b', tags: ['filmgrain'] }))]);
    const results = search(index, 'grain');
    expect(ids(results)).toEqual(['a', 'b']);
  });

  it('sums term scores so entries matching more strongly rank higher', () => {
    const index = buildIndex([
      doc(entry({ id: 'both-title', title: 'Grain study in red', createdAt: 1 })),
      doc(entry({ id: 'split', title: 'Grain', notes: 'study', createdAt: 2 })),
    ]);
    expect(ids(search(index, 'grain study'))).toEqual(['both-title', 'split']);
  });

  it('breaks ties by recency, newest first', () => {
    const index = buildIndex([
      doc(entry({ id: 'old', title: 'Dune', createdAt: 100 })),
      doc(entry({ id: 'new', title: 'Dune', createdAt: 300 })),
      doc(entry({ id: 'mid', title: 'Dune', createdAt: 200 })),
    ]);
    const results = search(index, 'dune');
    expect(ids(results)).toEqual(['new', 'mid', 'old']);
    // Recency is only a tie-breaker: it never outweighs a better field.
    expect(results[0].score - results[2].score).toBeLessThan(0.5);
  });

  it('keeps recency below the gap between match types', () => {
    const index = buildIndex([
      doc(entry({ id: 'new-prefix', title: 'Duneland', createdAt: 9_999 })),
      doc(entry({ id: 'old-whole', title: 'Dune', createdAt: 1 })),
    ]);
    expect(ids(search(index, 'dune'))).toEqual(['old-whole', 'new-prefix']);
  });

  it('ranks an exact tag above a tag that merely starts with the typed text', () => {
    const index = buildIndex([
      doc(entry({ id: 'filmic', tags: ['filmic'], createdAt: 2 })),
      doc(entry({ id: 'film', tags: ['film'], createdAt: 1 })),
    ]);
    expect(ids(search(index, '#film'))).toEqual(['film', 'filmic']);
  });
});

describe('search result shape', () => {
  const longNotes =
    'A long walk through the archive. ' + 'Nothing here. '.repeat(30) + 'Finally the Portra contact sheets turned up.';
  const e = entry({ id: 'e', title: 'Archive visit', notes: longNotes, tags: ['archive', 'film'] });
  const index = buildIndex([doc(e, [image({ text: 'Portra 160 NC' })])]);

  it('lists matched fields in importance order', () => {
    const [r] = search(index, 'portra archive #film');
    expect(r.fields).toEqual(['title', 'tags', 'notes', 'text']);
  });

  it('gives a snippet from the best long-form field when the title does not show the match', () => {
    const [r] = search(index, 'portra');
    expect(r.snippet?.field).toBe('notes');
    expect(marked(r.snippet!.segments)).toEqual(['Portra']);
    expect(r.snippet!.segments[0]).toEqual({ text: '…', match: false });
  });

  it('prefers the field that shows more of the hidden terms', () => {
    const [r] = search(index, 'portra 160');
    expect(r.snippet?.field).toBe('text');
    expect(marked(r.snippet!.segments)).toEqual(['Portra', '160']);
  });

  it('has no snippet when the title already shows every term', () => {
    const [r] = search(index, 'archive');
    expect(r.snippet).toBeNull();
    expect(search(index, '#film')[0].snippet).toBeNull();
  });

  it('serialises like a plain object (snippet included)', () => {
    const [r] = search(index, 'portra');
    const copy = { ...r };
    expect(copy.snippet?.field).toBe('notes');
    expect(JSON.parse(JSON.stringify(r)).snippet.field).toBe('notes');
    r.snippet = null;
    expect(r.snippet).toBeNull();
  });

  it('has no swatches without colour matches', () => {
    expect(search(index, 'portra')[0].swatches).toEqual([]);
  });
});

describe('buildIndex reuse', () => {
  it('reflects edits made to entries and images between builds', () => {
    const e = entry({ id: 'm', title: 'Before' });
    const img = image({ text: 'alpha' });
    const docs = [doc(e, [img])];
    expect(ids(search(buildIndex(docs), 'before alpha'))).toEqual(['m']);

    e.title = 'After';
    img.text = 'omega';
    const rebuilt = buildIndex(docs);
    expect(search(rebuilt, 'before')).toEqual([]);
    expect(ids(search(rebuilt, 'after omega'))).toEqual(['m']);

    e.tags = ['new'];
    expect(ids(search(buildIndex(docs), '#new'))).toEqual(['m']);
    expect(knownTagsOf(buildIndex(docs)).has('new')).toBe(true);

    const replaced = image({ text: 'gamma' });
    expect(ids(search(buildIndex([doc(e, [replaced])]), 'gamma'))).toEqual(['m']);
  });

  it('skips missing images defensively', () => {
    const idx = buildIndex([doc(entry({ id: 'x', title: 'X' }), [undefined as unknown as ImageMeta])]);
    expect(ids(search(idx, 'x'))).toEqual(['x']);
  });
});

// ---------------------------------------------------------------------------
// Highlighting
// ---------------------------------------------------------------------------

describe('highlight', () => {
  it('marks every occurrence of every term and phrase', () => {
    const segs = highlight('Grain and more grain in the film', parseQuery('grain film'));
    expect(segs).toEqual([
      { text: 'Grain', match: true },
      { text: ' and more ', match: false },
      { text: 'grain', match: true },
      { text: ' in the ', match: false },
      { text: 'film', match: true },
    ]);
  });

  it('returns the whole text unmatched when nothing matches', () => {
    expect(highlight('Nothing here', parseQuery('grain'))).toEqual([{ text: 'Nothing here', match: false }]);
    expect(highlight('Nothing here', parseQuery(''))).toEqual([{ text: 'Nothing here', match: false }]);
    expect(highlight('', parseQuery('x'))).toEqual([{ text: '', match: false }]);
  });

  it('ignores tag filters and colour queries', () => {
    expect(highlight('film', parseQuery('#film #fff'))).toEqual([{ text: 'film', match: false }]);
  });

  it('merges overlapping and adjacent matches', () => {
    expect(highlight('photography', parseQuery('photo graph'))).toEqual([{ text: 'photograph', match: true }, { text: 'y', match: false }]);
    expect(highlight('aaaa', parseQuery('aa'))).toEqual([{ text: 'aaaa', match: true }]);
    expect(highlight('abcdef', parseQuery('abc cde'))).toEqual([{ text: 'abcde', match: true }, { text: 'f', match: false }]);
  });

  it('maps precomposed accents back to the original', () => {
    expect(highlight('Le Café Noir', parseQuery('cafe'))).toEqual([
      { text: 'Le ', match: false },
      { text: 'Café', match: true },
      { text: ' Noir', match: false },
    ]);
  });

  it('keeps decomposed accents inside the highlight', () => {
    const text = 'Le Café Noir';
    expect(marked(highlight(text, parseQuery('café')))).toEqual(['Café']);
    expect(joined(highlight(text, parseQuery('cafe')))).toBe(text);
  });

  it('maps ligatures and ß, which change length when folded', () => {
    expect(highlight('The ﬁnal ﬁle', parseQuery('file'))).toEqual([
      { text: 'The ﬁnal ', match: false },
      { text: 'ﬁle', match: true },
    ]);
    expect(highlight('Große Straße 5', parseQuery('strasse'))).toEqual([
      { text: 'Große ', match: false },
      { text: 'Straße', match: true },
      { text: ' 5', match: false },
    ]);
    // A match starting inside an expansion highlights the whole source character.
    expect(marked(highlight('Straße', parseQuery('sse')))).toEqual(['ße']);
  });

  it('handles astral characters before and inside matches', () => {
    expect(highlight('🎞️🎞️ Kodak 𝒳 film', parseQuery('film'))).toEqual([
      { text: '🎞️🎞️ Kodak 𝒳 ', match: false },
      { text: 'film', match: true },
    ]);
    expect(marked(highlight('roll 🎞️ out', parseQuery('🎞')))).toEqual(['🎞️']);
    expect(marked(highlight('ＦＵＬＬ frame', parseQuery('full')))).toEqual(['ＦＵＬＬ']);
  });

  it('matches phrases across line breaks and repeated spaces', () => {
    const text = 'the golden\n   hour light';
    expect(highlight(text, parseQuery('"golden hour"'))).toEqual([
      { text: 'the ', match: false },
      { text: 'golden\n   hour', match: true },
      { text: ' light', match: false },
    ]);
  });

  it('maps İ, fullwidth and Greek final sigma correctly', () => {
    expect(marked(highlight('İstanbul', parseQuery('istanbul')))).toEqual(['İstanbul']);
    expect(marked(highlight('ΟΔΟΣ ΟΔΟΣ', parseQuery('οδοσ')))).toEqual(['ΟΔΟΣ', 'ΟΔΟΣ']);
  });

  it('always reproduces the input exactly (property test)', () => {
    const pool = ['a', 'B', 'é', 'é', 'ß', 'ﬁ', 'ﬃ', ' ', '\n', ' ', '­', '🎞️', '𝒳', 'Σ', 'İ', '①', '’', '-', '東', 'ǅ', '́', 'Ⅻ'];
    const queries = ['a', 'e', 'ss', 'fi', 'ffi', 'b a', 'σ', 'i', '1', "'", 'ae', 'xii', 'dz'].map((t) => parseQuery(`"${t}"`));
    const next = rng(42);
    for (let n = 0; n < 2000; n++) {
      let text = '';
      const len = Math.floor(next() * 14);
      for (let k = 0; k < len; k++) text += pool[Math.floor(next() * pool.length)];
      const q = queries[n % queries.length];
      const segs = highlight(text, q);
      expect(joined(segs)).toBe(text);
      // Every highlighted run, folded, contains the needle.
      for (const s of segs) if (s.match) expect(foldText(s.text)).toContain(q.phrases[0]);
      // Segments alternate and are never empty (except the single empty-text case).
      if (text) for (const s of segs) expect(s.text.length).toBeGreaterThan(0);
      for (let k = 1; k < segs.length; k++) expect(segs[k].match).not.toBe(segs[k - 1].match);
    }
  });
});

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

describe('makeSnippet', () => {
  const filler = (word: string, n: number) => Array.from({ length: n }, () => word).join(' ');

  it('returns the whole text, whitespace collapsed, when it is short', () => {
    expect(makeSnippet('  Shot on\n\nPortra   400  ', parseQuery('portra'))).toEqual([
      { text: 'Shot on ', match: false },
      { text: 'Portra', match: true },
      { text: ' 400', match: false },
    ]);
  });

  it('returns null without a match', () => {
    expect(makeSnippet('Shot on Portra', parseQuery('ektar'))).toBeNull();
    expect(makeSnippet('', parseQuery('ektar'))).toBeNull();
    expect(makeSnippet('Shot on Portra', parseQuery('#portra'))).toBeNull();
  });

  it('truncates long text around the match at word boundaries', () => {
    const text = `${filler('lorem', 60)} the Portra stock ${filler('ipsum', 60)}`;
    const segs = makeSnippet(text, parseQuery('portra'), 80)!;
    expect(segs[0]).toEqual({ text: '…', match: false });
    expect(segs[segs.length - 1]).toEqual({ text: '…', match: false });
    expect(marked(segs)).toEqual(['Portra']);
    const body = joined(segs.slice(1, -1));
    expect(body.length).toBeLessThanOrEqual(80);
    expect(body.length).toBeGreaterThan(60);
    // Cut between words, never inside one.
    expect(body).toMatch(/^(lorem |the )/);
    expect(body).toMatch(/( ipsum| stock)$/);
    expect(text.replace(/\s+/g, ' ')).toContain(body);
  });

  it('shows the start without a leading ellipsis when the match is near it', () => {
    const segs = makeSnippet(`Portra ${filler('ipsum', 100)}`, parseQuery('portra'), 60)!;
    expect(segs[0]).toEqual({ text: 'Portra', match: true });
    expect(segs[segs.length - 1].text).toBe('…');
  });

  it('shows the end without a trailing ellipsis when the match is near it', () => {
    const segs = makeSnippet(`${filler('ipsum', 100)} Portra.`, parseQuery('portra'), 60)!;
    expect(segs[0].text).toBe('…');
    expect(segs[segs.length - 1]).toEqual({ text: '.', match: false });
  });

  it('prefers the window showing the most distinct query words', () => {
    const text = `grain ${filler('x', 80)} grain then film ${filler('y', 80)}`;
    const segs = makeSnippet(text, parseQuery('grain film'), 40)!;
    expect(marked(segs)).toEqual(['grain', 'film']);
  });

  it('collapses whitespace inside a truncated snippet', () => {
    const text = `${filler('a', 50)}\n\n\tthe   Portra\n\nstock ${filler('b', 50)}`;
    const body = joined(makeSnippet(text, parseQuery('portra'), 40)!);
    expect(body).not.toMatch(/\s{2}|\n|\t/);
    expect(body).toContain('the Portra stock');
  });

  it('copes with a single unbroken word longer than the window', () => {
    const word = 'x'.repeat(300) + 'needle' + 'y'.repeat(300);
    const segs = makeSnippet(word, parseQuery('needle'), 50)!;
    expect(marked(segs)).toEqual(['needle']);
    expect(joined(segs.slice(1, -1)).length).toBeLessThanOrEqual(50);
  });

  it('highlights matches folded from accents inside the window', () => {
    const segs = makeSnippet(`${filler('zz', 40)} Café de Flore ${filler('zz', 40)}`, parseQuery('cafe flore'), 50)!;
    expect(marked(segs)).toEqual(['Café', 'Flore']);
  });
});

// ---------------------------------------------------------------------------
// Chips and swatches
// ---------------------------------------------------------------------------

describe('tagMatches', () => {
  it('matches tag filters exactly, the tag being typed by prefix, and terms by substring', () => {
    const q = parseQuery('grain #colour #fil');
    expect(tagMatches('colour', q)).toBe(true);
    expect(tagMatches('colours', q)).toBe(false);
    expect(tagMatches('film', q)).toBe(true);
    expect(tagMatches('film-grain', q)).toBe(true);
    expect(tagMatches('portrait', q)).toBe(false);
    expect(tagMatches('Colour', q)).toBe(true);
  });

  it('only uses prefix matching for the trailing tag', () => {
    expect(tagMatches('filmic', parseQuery('#film '))).toBe(false);
    expect(tagMatches('filmic', parseQuery('#film'))).toBe(true);
  });

  it('ignores accents', () => {
    expect(tagMatches('café', parseQuery('#cafe '))).toBe(true);
    expect(tagMatches('café', parseQuery('caf'))).toBe(true);
  });
});

describe('swatchMatches', () => {
  const ochre = swatch('#c8a24a', 'ochre', 'yellow', 0.02);

  it('matches colour queries within the threshold regardless of weight', () => {
    expect(swatchMatches(ochre, parseQuery('#c9a34b'))).toBe(true);
    expect(swatchMatches(ochre, parseQuery('#1f4e79'))).toBe(false);
  });

  it('matches names and families as words', () => {
    expect(swatchMatches(ochre, parseQuery('ochre'))).toBe(true);
    expect(swatchMatches(ochre, parseQuery('och'))).toBe(true);
    expect(swatchMatches(ochre, parseQuery('yellow'))).toBe(true);
    expect(swatchMatches(ochre, parseQuery('Yellow film'))).toBe(true);
    expect(swatchMatches(ochre, parseQuery('chre'))).toBe(false);
    expect(swatchMatches(ochre, parseQuery('film'))).toBe(false);
    expect(swatchMatches(ochre, parseQuery(''))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

describe('performance', () => {
  const VOCAB = (
    'the of and light shadow grain film portrait street archive colour paper print ink type serif ' +
    'gallery museum catalogue exhibition plate figure index margin column folio press studio negative ' +
    'contact sheet kodak portra ilford fuji lens aperture shutter frame square landscape texture pattern'
  ).split(' ');
  const PALETTE = [
    swatch('#c0392b', 'vermilion', 'red', 0.4),
    swatch('#1f4e79', 'navy', 'blue', 0.3),
    swatch('#c8a24a', 'ochre', 'yellow', 0.2),
    swatch('#f5f0e6', 'ivory', 'white', 0.1),
  ];

  function library(count: number): SearchDoc[] {
    const next = rng(7);
    const word = () => VOCAB[Math.floor(next() * VOCAB.length)];
    const words = (n: number) => Array.from({ length: n }, word).join(' ');
    return Array.from({ length: count }, (_, i) => {
      // ~2 KB of OCR text, with a sprinkling of numbers and accents.
      let text = '';
      while (text.length < 2000) text += `${words(12)} ${Math.floor(next() * 1000)} café\n`;
      return doc(
        entry({
          id: `p${i}`,
          title: words(3),
          notes: words(20),
          tags: [word(), word()],
          credit: words(2),
          link: `https://example.org/${word()}/${i}`,
          createdAt: i,
        }),
        [image({ text, palette: [PALETTE[i % 4], PALETTE[(i + 1) % 4]] })],
      );
    });
  }

  function timeIt(fn: () => void, runs: number): number {
    const times: number[] = [];
    for (let r = 0; r < runs; r++) {
      const t0 = performance.now();
      fn();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)];
  }

  it('searches 5,000 entries with ~2 KB of OCR text each quickly', () => {
    const docs = library(5000);
    const t0 = performance.now();
    const index = buildIndex(docs);
    const buildMs = performance.now() - t0;
    const rebuildMs = timeIt(() => buildIndex(docs), 3);

    const queries = ['zebra', 'grain', 'grain portrait', 'kodak -ilford', '#film', '"contact sheet"', '#c0392b', 'ochre', 'e'];
    for (const q of queries) search(index, q); // warm up
    const timings = Object.fromEntries(queries.map((q) => [q, timeIt(() => search(index, q), 7)]));

    console.info(
      `[search perf] build ${buildMs.toFixed(1)} ms, cached rebuild ${rebuildMs.toFixed(1)} ms, search medians:`,
      Object.entries(timings)
        .map(([q, ms]) => `${q}=${ms.toFixed(1)}ms`)
        .join(', '),
    );

    // Generous bounds: CI machines and jsdom vary; the target on desktop is < 15 ms.
    expect(timings.zebra).toBeLessThan(100);
    expect(timings['grain portrait']).toBeLessThan(150);
    expect(Math.max(...Object.values(timings))).toBeLessThan(400);
    expect(buildMs).toBeLessThan(5000);
    expect(rebuildMs).toBeLessThan(buildMs);
    expect(search(index, 'zebra')).toEqual([]);
    expect(search(index, 'cafe').length).toBe(5000);
  });
});

// Keep the type import exercised for readers of the test file.
const _typed: ParsedQuery = parseQuery('');
void _typed;
